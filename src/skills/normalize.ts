import { DIGEST_PREFIX } from "../artifact";
import { sha256Hex } from "../hash";
import { isValidDescription, isValidSkillName, parseFrontmatter } from "./frontmatter";
import { isGzip, readTarGz } from "./tar";
import { ArchiveError, readZip, writeZip, type ArchiveEntry } from "./zip";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 200;

export class UploadError extends Error {
  // Status and machine-readable code travel with the error, so the routes
  // map it without re-deciding either (see routes/publish.tsx).
  readonly status = 400;
  readonly code = "invalid_upload";
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface NormalizedSkill {
  name: string;
  description: string;
  skillMd: string;
  files: Array<{ path: string; size: number }>;
  zip: Uint8Array;
  digest: string;
}

function isZip(b: Uint8Array): boolean {
  return b.length > 1 && b[0] === 0x50 && b[1] === 0x4b;
}

function isJunk(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === ".DS_Store" || base === "Thumbs.db" || base.startsWith("._");
}

function cleanPath(raw: string): string {
  if (!raw || raw.includes("\0")) throw new UploadError(`压缩包内路径非法：${raw}`);
  if (raw.startsWith("/") || raw.startsWith("\\")) throw new UploadError(`压缩包内路径非法（绝对路径）：${raw}`);
  if (/^[A-Za-z]:/.test(raw)) throw new UploadError(`压缩包内路径非法（盘符）：${raw}`);
  if (raw.includes("\\")) throw new UploadError(`压缩包内路径非法（反斜杠）：${raw}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new UploadError(`压缩包内路径非法：${raw}`);
  if (parts.includes("..")) throw new UploadError(`压缩包内路径非法（越界）：${raw}`);
  return parts.join("/");
}

function stripWrapperDir(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has("SKILL.md")) return files;
  const paths = [...files.keys()];
  if (paths.length === 0) return files;
  const first = paths[0].split("/")[0];
  const shared = paths.every((p) => p.startsWith(`${first}/`));
  if (!shared) return files;
  const out = new Map<string, Uint8Array>();
  for (const [path, data] of files) out.set(path.slice(first.length + 1), data);
  return out;
}

function dropJunk(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].filter(([path]) => !isJunk(path)));
}

async function extract(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  try {
    if (isGzip(bytes)) return await readTarGz(bytes);
    if (isZip(bytes)) return await readZip(bytes);
  } catch (err) {
    if (err instanceof ArchiveError) throw new UploadError(err.message);
    throw err;
  }
  // 解码再编码一次是为了把非法 UTF-8 字节规范成替换字符，保证 digest 稳定。
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  return new Map([["SKILL.md", new TextEncoder().encode(text)]]);
}

export async function normalizeUpload(bytes: Uint8Array): Promise<NormalizedSkill> {
  if (bytes.length === 0) throw new UploadError("上传内容为空");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(`上传体积超出上限：${bytes.length} 字节 > ${MAX_UPLOAD_BYTES} 字节`);
  }

  const raw = await extract(bytes);

  const cleaned = new Map<string, Uint8Array>();
  for (const [path, data] of raw) {
    if (isJunk(path)) continue;
    cleaned.set(cleanPath(path), data);
  }

  // Filtered twice on purpose: junk nested under a wrapper directory
  // (`wrapper/__MACOSX/…`) only becomes top-level once the wrapper is
  // stripped, and `isJunk` matches on a leading prefix.
  const filtered = dropJunk(stripWrapperDir(cleaned));

  if (filtered.size === 0) throw new UploadError("压缩包内没有可用文件");
  if (filtered.size > MAX_FILES) {
    throw new UploadError(`文件数超出上限：${filtered.size} > ${MAX_FILES}`);
  }

  let unpacked = 0;
  for (const data of filtered.values()) unpacked += data.byteLength;
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new UploadError(`解包后体积超出上限：${unpacked} 字节 > ${MAX_UNPACKED_BYTES} 字节`);
  }

  const skillMdBytes = filtered.get("SKILL.md");
  if (!skillMdBytes) throw new UploadError("压缩包根目录缺少 SKILL.md");
  const skillMd = new TextDecoder().decode(skillMdBytes);

  const { data } = parseFrontmatter(skillMd);
  if (!isValidSkillName(data.name)) {
    throw new UploadError(
      "SKILL.md 的 frontmatter 中 name 不合法：必须匹配 ^[a-z0-9-]+$，长度 1-64，不以连字符开头或结尾，不含连续连字符",
    );
  }
  if (!isValidDescription(data.description)) {
    throw new UploadError("SKILL.md 的 frontmatter 中 description 不合法：必须非空且不超过 1024 字符");
  }

  const entries: ArchiveEntry[] = [...filtered].map(([path, bytes]) => ({ path, data: bytes }));
  const zip = await writeZip(entries);

  return {
    name: data.name,
    description: data.description,
    skillMd,
    files: [...filtered]
      .map(([path, bytes]) => ({ path, size: bytes.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    zip,
    digest: `${DIGEST_PREFIX}${await sha256Hex(zip)}`,
  };
}
