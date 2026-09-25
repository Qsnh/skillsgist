import { canManage, canPublishTo, randomHex } from "./auth";
import { getProject, getSkill, getVersion, insertVersion, setVisibility } from "./db/queries";
import type { VersionRow, Viewer } from "./db/queries";
import { RENDER_REVISION, renderSkillMd } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import { readZip, writeZip } from "./skills/zip";
import type { Env } from "./types";

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function unchangedError(latest: VersionRow): UploadError {
  return new UploadError(
    `This is identical to v${latest.version}, the latest version of ${latest.slug}, so no new version was published`,
  );
}

export interface PublishOutcome {
  project: string;
  slug: string;
  version: number;
  digest: string;
  unchanged: boolean;
  files: Array<{ path: string; size: number }>;
}

export async function publishBytes(
  env: Env,
  user: Viewer,
  bytes: Uint8Array,
  opts: { project: string; expectedSlug?: string; visibility?: "public" | "private"; rejectUnchanged?: boolean },
): Promise<PublishOutcome> {
  const normalized = await normalizeUpload(bytes);

  if (opts.expectedSlug && opts.expectedSlug !== normalized.name) {
    throw new UploadError(
      `The slug in the URL is ${opts.expectedSlug} but SKILL.md declares name ${normalized.name}; they must agree`,
    );
  }

  if (!canPublishTo(user, opts.project) || !(await getProject(env.DB, opts.project))) {
    throw new ForbiddenError(`There is no project named ${opts.project} that you can publish to`);
  }

  const existing = await getSkill(env.DB, opts.project, normalized.name);
  if (existing && !canManage(user, existing)) {
    throw new ForbiddenError(`skill ${normalized.name} belongs to another user; you cannot overwrite it`);
  }

  const latest = existing ? await getVersion(env.DB, existing.project, existing.slug, existing.latest_version) : null;
  const unchanged = latest !== null && latest.digest === normalized.digest;

  if (unchanged) {
    const object = await env.BUCKET.head(latest.r2_key);
    if (!object) {
      await env.BUCKET.put(latest.r2_key, normalized.zip, {
        httpMetadata: { contentType: "application/zip" },
      });
    }
    if (opts.rejectUnchanged) throw unchangedError(latest);
  }

  if (existing && opts.visibility !== undefined) {
    await setVisibility(env.DB, existing.project, existing.slug, opts.visibility);
  }

  if (unchanged) {
    return {
      project: latest.project,
      slug: latest.slug,
      version: latest.version,
      digest: normalized.digest,
      unchanged: true,
      files: normalized.files,
    };
  }

  const html = await renderSkillMd(normalized.skillMd);
  const { version, r2Key } = await insertVersion(env.DB, {
    skillId: existing?.id ?? randomHex(8),
    project: opts.project,
    slug: normalized.name,
    digest: normalized.digest,
    size: normalized.zip.byteLength,
    name: normalized.name,
    description: normalized.description,
    skill_md: normalized.skillMd,
    html,
    html_rev: RENDER_REVISION,
    files: JSON.stringify(normalized.files),
    authorId: user.id,
    visibility: opts.visibility ?? "private",
  });

  await env.BUCKET.put(r2Key, normalized.zip, {
    httpMetadata: { contentType: "application/zip" },
  });

  return {
    project: opts.project,
    slug: normalized.name,
    version,
    digest: normalized.digest,
    unchanged: false,
    files: normalized.files,
  };
}

export async function repackWithSkillMd(
  env: Env,
  latest: VersionRow,
  skillMd: string,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(skillMd);
  const files = JSON.parse(latest.files) as Array<{ path: string }>;
  if (!files.some((f) => f.path !== "SKILL.md")) return bytes;

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
