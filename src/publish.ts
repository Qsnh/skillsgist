import { canAccessProject, canManage, canPublishIn, randomHex } from "./auth";
import { getProject, getSkill, getVersion, insertVersion, objectKeyFor, setVisibility } from "./db/queries";
import type { VersionRow, Viewer } from "./db/queries";
import { issue, IssueError } from "./i18n/issues";
import type { Issue } from "./i18n/issues";
import { RENDER_REVISION, renderSkillMd } from "./render/markdown";
import { normalizeUpload, UploadError } from "./skills/normalize";
import { readZip, writeZip } from "./skills/zip";
import type { Services } from "./types";

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

const ZIP = "application/zip";

export async function publishBytes(
  env: Services,
  user: Viewer,
  bytes: Uint8Array,
  opts: { project: string; expectedSlug?: string; visibility?: "public" | "private"; rejectUnchanged?: boolean },
): Promise<PublishOutcome> {
  const normalized = await normalizeUpload(bytes, env.config.limits);

  if (opts.expectedSlug && opts.expectedSlug !== normalized.name) {
    throw new UploadError(issue("slugMismatch", opts.expectedSlug, normalized.name));
  }

  const [project, existing] = canAccessProject(user, opts.project)
    ? [getProject(env.db, opts.project), getSkill(env.db, opts.project, normalized.name)]
    : [null, null];
  if (!project) {
    throw new ForbiddenError(issue("noSuchProject", opts.project));
  }
  if (!canPublishIn(user, project.slug)) {
    throw new ForbiddenError(issue("publishNotAllowed", project.slug));
  }
  if (existing && !canManage(user, existing)) {
    throw new ForbiddenError(issue("notYours", normalized.name));
  }

  const latest = existing ? getVersion(env.db, existing.project, existing.slug, existing.latest_version) : null;
  const unchanged = latest !== null && latest.digest === normalized.digest;

  if (unchanged) {
    if (!(await env.storage.head(latest.object_key))) await env.storage.put(latest.object_key, normalized.zip, ZIP);
    if (opts.rejectUnchanged) throw unchangedError(latest);
  }

  if (existing && opts.visibility !== undefined) {
    setVisibility(env.db, existing.project, existing.slug, opts.visibility);
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
  const skillId = existing?.id ?? randomHex(8);
  const objectKey = objectKeyFor(skillId, normalized.digest);
  await env.storage.put(objectKey, normalized.zip, ZIP);
  const version = insertVersion(env.db, {
    skillId,
    objectKey,
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

  return outcome(version);
}

export async function repackWithSkillMd(
  env: Services,
  latest: VersionRow,
  skillMd: string,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(skillMd);
  const files = JSON.parse(latest.files) as Array<{ path: string }>;
  if (!files.some((f) => f.path !== "SKILL.md")) return bytes;

  const object = await env.storage.get(latest.object_key);
  if (!object) {
    throw new UploadError(issue("archiveMissing", latest.version));
  }

  const entries = await readZip(await object.bytes(), env.config.limits.unpackedBytes);
  entries.set("SKILL.md", bytes);
  return writeZip([...entries].map(([path, data]) => ({ path, data })));
}
