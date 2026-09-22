import { getSkill, getVersion, insertVersion } from "./db/queries";
import type { UserRow } from "./db/queries";
import { renderMarkdown } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import type { Env } from "./types";

export class ForbiddenError extends Error {
  readonly status = 403;
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

  if (existing) {
    const latest = await getVersion(env.DB, existing.slug, existing.latest_version);
    if (latest?.digest === normalized.digest) {
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
  const version = await insertVersion(env.DB, {
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
    visibility: opts.visibility ?? "private",
  });

  // Deliberate ordering: D1 rows are written before the R2 object. If R2
  // then fails, the version row points at a missing object — visible on
  // download (404) and fixed by republishing. Writing R2 first would risk
  // an unreferenced R2 object that nothing can detect if D1 then failed.
  await env.BUCKET.put(`skills/${normalized.name}/${version}.zip`, normalized.zip, {
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
