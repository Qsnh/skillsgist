import { getSkill, getVersion, insertVersion, setVisibility } from "./db/queries";
import type { UserRow } from "./db/queries";
import { renderMarkdown } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import type { Env } from "./types";

export class ForbiddenError extends Error {
  // See the note on UploadError: the status and code belong to the error.
  readonly status = 403;
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface PublishOutcome {
  slug: string;
  version: number;
  digest: string;
  unchanged: boolean;
  files: Array<{ path: string; size: number }>;
}

export async function publishBytes(
  env: Env,
  user: UserRow,
  bytes: Uint8Array,
  opts: { expectedSlug?: string; visibility?: "public" | "private" } = {},
): Promise<PublishOutcome> {
  const normalized = await normalizeUpload(bytes);

  if (opts.expectedSlug && opts.expectedSlug !== normalized.name) {
    throw new UploadError(
      `URL 里的 slug 是 ${opts.expectedSlug}，但 SKILL.md 的 name 是 ${normalized.name}，两者必须一致`,
    );
  }

  const existing = await getSkill(env.DB, normalized.name);
  if (existing && user.role !== "admin" && existing.owner_id !== user.id) {
    throw new ForbiddenError(`skill ${normalized.name} 属于其他用户，无权覆盖`);
  }

  // Final-review Fix 1: `insertVersion`'s ON CONFLICT clause deliberately
  // never updates `visibility` (see the note on the call below), so for an
  // existing skill this is the only place that write happens. It sits here,
  // above the digest branch, rather than once per exit: a republish of
  // unchanged content must honour an explicit choice too, and any future
  // early return in this function would otherwise silently drop it again.
  // `undefined` means the caller passed no visibility at all (the edit
  // path) and must leave the column untouched. Ownership was just checked,
  // so no further authorization is needed.
  if (existing && opts.visibility !== undefined) {
    await setVisibility(env.DB, existing.slug, opts.visibility);
  }

  if (existing) {
    const latest = await getVersion(env.DB, existing.slug, existing.latest_version);
    if (latest?.digest === normalized.digest) {
      // Final-review Fix 2: a digest match alone doesn't prove the artifact
      // is actually fetchable. A prior publish could have written the D1
      // rows and then failed the R2 put (R2 error, or the isolate killed at
      // the CPU/memory limit right at that boundary) — see the ordering
      // comment on the BUCKET.put below. Confirm the object exists before
      // trusting "unchanged"; if it's missing, repair it by re-putting the
      // same bytes under the same key instead of reporting success forever
      // over a 404 artifact.
      const object = await env.BUCKET.head(latest.r2_key);
      if (!object) {
        await env.BUCKET.put(latest.r2_key, normalized.zip, {
          httpMetadata: { contentType: "application/zip" },
        });
      }
      return {
        slug: existing.slug,
        version: existing.latest_version,
        digest: normalized.digest,
        unchanged: true,
        files: normalized.files,
      };
    }
  }

  const html = await renderMarkdown(normalized.skillMd);
  const { version, r2Key } = await insertVersion(env.DB, {
    slug: normalized.name,
    digest: normalized.digest,
    size: normalized.zip.byteLength,
    name: normalized.name,
    description: normalized.description,
    skill_md: normalized.skillMd,
    html,
    files: JSON.stringify(normalized.files),
    // Correction 1 (task-10 brief override): always record the publisher,
    // not the skill's owner. `insertVersion`'s ON CONFLICT clause never
    // touches owner_id, so an existing skill's ownership is unaffected by
    // who publishes a new version to it — this only changes what
    // versions.author_id records.
    authorId: user.id,
    // Only used for the initial INSERT VALUES when the skill doesn't exist
    // yet (new skills default private, per spec §6). When `existing` is
    // true, `insertVersion`'s ON CONFLICT DO UPDATE never touches this
    // column — deliberately, so a republish that passes no visibility
    // (the edit path) can't reset a public skill to private, and an
    // admin's republish can't silently flip it either. An *explicitly*
    // supplied visibility on an existing skill is applied by the
    // `setVisibility` call above instead.
    visibility: opts.visibility ?? "private",
  });

  // Deliberate ordering: D1 rows are written before the R2 object. If R2
  // then fails, the version row points at a missing object — visible on
  // download (404). Republishing identical bytes now repairs this: the
  // unchanged-digest branch above verifies (via BUCKET.head) that the
  // object actually exists before trusting the digest match, and re-puts
  // it when it doesn't, rather than short-circuiting on the digest alone.
  // Writing R2 first would risk an unreferenced R2 object that nothing can
  // detect if D1 then failed.
  // `r2Key` comes back from `insertVersion`, which is what wrote it into
  // `versions.r2_key` — the column every reader trusts. Re-deriving the same
  // string here is how the stored key and the written object drift apart.
  await env.BUCKET.put(r2Key, normalized.zip, {
    httpMetadata: { contentType: "application/zip" },
  });

  return {
    slug: normalized.name,
    version,
    digest: normalized.digest,
    unchanged: false,
    files: normalized.files,
  };
}
