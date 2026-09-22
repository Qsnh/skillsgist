import { ArchiveError } from "./zip";

async function inflateGzipMember(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await inflateGzipMember(data);
  } catch {
    // bsdtar (macOS's default `tar`) compresses its own output with `tar
    // czf` and pads the result to a block boundary with trailing NUL bytes
    // after the real gzip stream ends. Node's zlib and command-line gzip
    // both tolerate this silently; workerd's native DecompressionStream
    // does not ("Trailing bytes after end of compressed data").
    const floor = indexAfterLastNonZero(data);
    for (let extra = 0; extra <= GZIP_TRAILER_LEN; extra++) {
      const end = Math.min(floor + extra, data.length);
      try {
        return await inflateGzipMember(data.subarray(0, end));
      } catch {
        // Either still short of the real trailer boundary, or genuinely
        // corrupt — keep probing until the bound above is exhausted.
      }
    }
    // Every candidate length failed: this isn't padding, it's real
    // corruption. Let the caller normalize this into an ArchiveError.
    throw new Error("gzip decompression failed even after trimming trailing padding");
  }
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

export async function readTarGz(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new ArchiveError("不是合法的 gzip 数据");
  }
  let tar: Uint8Array;
  try {
    tar = await gunzip(bytes);
  } catch {
    throw new ArchiveError("gzip 解压失败");
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
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError("tar 条目大小非法");

    offset += 512;

    // '1' = 硬链接，'2' = 软链接
    if (typeFlag === 0x31 || typeFlag === 0x32) throw new ArchiveError("不支持压缩包中的链接条目");
    // '\0' 与 '0' = 普通文件；其余（目录 '5'、pax 头 'x'/'g' 等）跳过
    if (typeFlag === 0 || typeFlag === 0x30) {
      files.set(path, tar.slice(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}
