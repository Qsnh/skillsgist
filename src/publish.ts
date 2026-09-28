import { canAccessProject, canManage, randomHex } from "./auth";
import { getProject, getSkill, getVersion, insertVersion, setVisibility } from "./db/queries";
import type { VersionRow, Viewer } from "./db/queries";
import { issue, IssueError } from "./i18n/issues";
import type { Issue } from "./i18n/issues";
import { RENDER_REVISION, renderSkillMd } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import { readZip, writeZip } from "./skills/zip";
import type { Env } from "./types";

export class ForbiddenError extends IssueError {
  readonly status = 403;
  readonly code = "forbidden";
  constructor(found: Issue) {
    super(found);
    this.name = "ForbiddenError";
  }
}

export function unchangedError(latest: VersionRow): UploadError {
  return new UploadError(issue("unchanged", latest.version, latest.slug));
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
    throw new UploadError(issue("slugMismatch", opts.expectedSlug, normalized.name));
  }

  const [project, existing] = canAccessProject(user, opts.project)
    ? await Promise.all([getProject(env.DB, opts.project), getSkill(env.DB, opts.project, normalized.name)])
    : [null, null];
  if (!project) {
    throw new ForbiddenError(issue("noSuchProject", opts.project));
  }
  if (existing && !canManage(user, existing)) {
    throw new ForbiddenError(issue("notYours", normalized.name));
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

  const outcome = (version: number) => ({
    project: opts.project,
    slug: normalized.name,
    version,
    digest: normalized.digest,
    unchanged,
    files: normalized.files,
  });

  if (unchanged) return outcome(latest.version);

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

  return outcome(version);
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
    throw new UploadError(issue("archiveMissing", latest.version));
  }

  const entries = await readZip(new Uint8Array(await object.arrayBuffer()));
  entries.set("SKILL.md", bytes);
  return writeZip([...entries].map(([path, data]) => ({ path, data })));
}
