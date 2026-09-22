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
  if (!raw || raw.includes("\0")) throw new UploadError(`Illegal path in archive: ${raw}`);
  if (raw.startsWith("/") || raw.startsWith("\\")) throw new UploadError(`Illegal path in archive (absolute): ${raw}`);
  if (/^[A-Za-z]:/.test(raw)) throw new UploadError(`Illegal path in archive (drive letter): ${raw}`);
  if (raw.includes("\\")) throw new UploadError(`Illegal path in archive (backslash): ${raw}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new UploadError(`Illegal path in archive: ${raw}`);
  if (parts.includes("..")) throw new UploadError(`Illegal path in archive (escapes the root): ${raw}`);
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
  // Decoding and re-encoding normalises invalid UTF-8 bytes into replacement characters, which keeps the digest stable.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  return new Map([["SKILL.md", new TextEncoder().encode(text)]]);
}

export async function normalizeUpload(bytes: Uint8Array): Promise<NormalizedSkill> {
  if (bytes.length === 0) throw new UploadError("Upload is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(`Upload exceeds the size limit: ${bytes.length} bytes > ${MAX_UPLOAD_BYTES} bytes`);
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

  if (filtered.size === 0) throw new UploadError("Archive contains no usable files");
  if (filtered.size > MAX_FILES) {
    throw new UploadError(`File count exceeds the limit: ${filtered.size} > ${MAX_FILES}`);
  }

  let unpacked = 0;
  for (const data of filtered.values()) unpacked += data.byteLength;
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new UploadError(`Unpacked size exceeds the limit: ${unpacked} bytes > ${MAX_UNPACKED_BYTES} bytes`);
  }

  const skillMdBytes = filtered.get("SKILL.md");
  if (!skillMdBytes) throw new UploadError("SKILL.md is missing from the archive root");
  const skillMd = new TextDecoder().decode(skillMdBytes);

  const { data } = parseFrontmatter(skillMd);
  if (!isValidSkillName(data.name)) {
    throw new UploadError(
      "Invalid name in SKILL.md frontmatter: must match ^[a-z0-9-]+$, be 1-64 characters, and neither start nor end with a hyphen nor contain consecutive hyphens",
    );
  }
  if (!isValidDescription(data.description)) {
    throw new UploadError("Invalid description in SKILL.md frontmatter: must be non-empty and at most 1024 characters");
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
