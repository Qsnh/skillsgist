import { ArchiveError, pipeBytes } from "./zip";

/** The only place the gzip format is recognised. */
export function isGzip(b: Uint8Array): boolean {
  return b.length > 1 && b[0] === 0x1f && b[1] === 0x8b;
}

function inflateGzipMember(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new DecompressionStream("gzip"));
}

function indexAfterLastNonZero(data: Uint8Array): number {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return end;
}

// A gzip member ends with a fixed 8-byte trailer (CRC32 + ISIZE). For small
// archives — the common case for a skill package — ISIZE's high-order bytes
// are legitimately zero (e.g. a 5632-byte payload is `00 16 00 00` little
// endian: 3 of the 4 ISIZE bytes are zero), and CRC32's low byte is zero
// 1-in-256 of the time. That means "strip every trailing zero byte" can eat
// into the real trailer, not just bsdtar's padding — confirmed by hand: for
// this project's own `bsdtar-padded.tar.gz` fixture, the true gzip member
// ends at byte 335, but scanning backward for the last non-zero byte lands
// on 333, two bytes short (verified with Python's `zlib.decompressobj`,
// whose `unused_data` gives the exact boundary, and re-confirmed against
// workerd's own `DecompressionStream` directly: byte-for-byte probing shows
// length 335 is the *only* length that succeeds — 334 fails as truncated,
// 336 fails as "trailing bytes"). So a single blind retry does not reliably
// work; probe forward a handful of bytes from the fully-trimmed point
// instead, stopping at the first length that decompresses cleanly.
const GZIP_TRAILER_LEN = 8;

// Candidate lengths worth retrying after the full buffer has already failed
// to decompress once. Exported (pure, no I/O) so a test can assert on the
// candidate set directly instead of on CPU time: it must never include
// `data.length` (that exact attempt already failed once, in `gunzip`, before
// this is even called) and never repeat a value. Without both guarantees, a
// buffer that fails the initial attempt and doesn't end in 0x00 — trivial
// for corrupt, truncated, or adversarial input to satisfy — would have
// `indexAfterLastNonZero` return `data.length` unchanged, and every "probe"
// would silently re-run the identical failed decompression.
export function gzipRetryLengths(data: Uint8Array): number[] {
  const floor = indexAfterLastNonZero(data);
  const lengths: number[] = [];
  for (let extra = 0; extra <= GZIP_TRAILER_LEN; extra++) {
    const end = floor + extra;
    if (end >= data.length) break; // would just repeat the already-failed full-buffer attempt
    lengths.push(end);
  }
  return lengths;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await inflateGzipMember(data);
  } catch {
    for (const end of gzipRetryLengths(data)) {
      try {
        return await inflateGzipMember(data.subarray(0, end));
      } catch {
        // Either still short of the real trailer boundary, or genuinely
        // corrupt — keep probing the remaining candidates.
      }
    }
    throw new Error("gzip decompression failed even after trimming trailing padding");
  }
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

export async function readTarGz(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (!isGzip(bytes)) throw new ArchiveError("Not a valid gzip archive");
  let tar: Uint8Array;
  try {
    tar = await gunzip(bytes);
  } catch {
    throw new ArchiveError("gzip decompression failed");
  }

  const files = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = readString(header, 0, 100);
    const sizeText = readString(header, 124, 12).trim();
    const typeFlag = header[156];
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError("Invalid tar entry size");

    offset += 512;

    // '1' = hard link, '2' = symlink
    if (typeFlag === 0x31 || typeFlag === 0x32) throw new ArchiveError("Link entries in archives are not supported");
    // '\0' and '0' = regular file; everything else (directory '5', pax headers 'x'/'g', ...) is skipped
    if (typeFlag === 0 || typeFlag === 0x30) {
      files.set(path, tar.slice(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}
