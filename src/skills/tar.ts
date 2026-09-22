import { ArchiveError } from "./zip";

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
