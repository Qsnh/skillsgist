import { getSkill, getVersion, insertVersion, setVisibility } from "./db/queries";
import type { UserRow, VersionRow } from "./db/queries";
import { renderMarkdown } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import { readZip, writeZip } from "./skills/zip";
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
      `The slug in the URL is ${opts.expectedSlug} but SKILL.md declares name ${normalized.name}; they must agree`,
    );
  }

  const existing = await getSkill(env.DB, normalized.name);
  if (existing && user.role !== "admin" && existing.owner_id !== user.id) {
    throw new ForbiddenError(`skill ${normalized.name} belongs to another user; you cannot overwrite it`);
  }

  // `insertVersion`'s ON CONFLICT clause deliberately
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
      // A digest match alone doesn't prove the artifact
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
    // Always record the publisher,
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

/**
 * 一次「只改文本」的编辑该发布的字节：上一版的压缩包，SKILL.md 换成 `skillMd`。
 *
 * 一个 skill 不只有 SKILL.md——`references/`、`scripts/` 里的文件都在包里，
 * 而编辑框只装得下其中一个。直接把文本框内容当整包发出去会连一句提示都没有
 * 地删掉其余文件，所以在这里把它们带过去。
 */
export async function repackWithSkillMd(
  env: Env,
  latest: VersionRow,
  skillMd: string,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(skillMd);
  const files = JSON.parse(latest.files) as Array<{ path: string }>;
  // 本来就只有 SKILL.md：省掉一次 R2 读，也让下面那个报错不会挡住一个根本
  // 不需要旧包的编辑。
  if (!files.some((f) => f.path !== "SKILL.md")) return bytes;

  // 读不到就挡住，而不是退回「只发 SKILL.md」——那正是这个函数要消灭的静默丢失。
  const object = await env.BUCKET.get(latest.r2_key);
  if (!object) {
    throw new UploadError(
      `The archive for v${latest.version} is missing from storage, so the files other than SKILL.md cannot be preserved. Upload a complete archive instead.`,
    );
  }

  const entries = await readZip(new Uint8Array(await object.arrayBuffer()));
  entries.set("SKILL.md", bytes);
  return writeZip([...entries].map(([path, data]) => ({ path, data })));
}
