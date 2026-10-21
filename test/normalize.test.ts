import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import type { UploadLimits } from "../src/config";
import { sha256Hex } from "../src/hash";
import { normalizeUpload, UploadError } from "../src/skills/normalize";
import { readZip, writeZip } from "../src/skills/zip";
import type { ArchiveEntry } from "../src/skills/zip";
import { fixture, FLAT_FILES, GOOD_MD } from "./helpers";

const enc = new TextEncoder();

const withLimits = (overrides: Partial<UploadLimits>): UploadLimits => ({ ...DEFAULT_LIMITS, ...overrides });

const SKILL_MD_BYTES = enc.encode(GOOD_MD).length;

function tarGz(entries: ArchiveEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const { path, data } of entries) {
    const header = new Uint8Array(512);
    const put = (offset: number, text: string) => header.set(enc.encode(text), offset);
    put(0, path);
    put(100, "0000644\0");
    put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
    put(148, "        ");
    header[156] = 0x30;
    put(257, "ustar\0");
    put(263, "00");
    put(148, `${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

function declareSize(zip: Uint8Array, path: string, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  const eocd = out.length - 22;
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const nameLen = view.getUint16(offset + 28, true);
    if (new TextDecoder().decode(out.subarray(offset + 46, offset + 46 + nameLen)) === path) {
      view.setUint32(offset + 24, size, true);
    }
    offset += 46 + nameLen;
  }
  return out;
}

async function issueOf(result: Promise<unknown>): Promise<UploadError["issue"]> {
  const err = await result.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UploadError);
  return (err as UploadError).issue;
}

describe("normalizeUpload", () => {
  it("accepts a bare SKILL.md", async () => {
    const result = await normalizeUpload(enc.encode(GOOD_MD));
    expect(result.name).toBe("demo-skill");
    expect(result.description).toBe("A demo skill used by the test suite.");
    expect(result.files).toEqual([{ path: "SKILL.md", size: SKILL_MD_BYTES }]);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("strips ./ prefixes from tar entries", async () => {
    const result = await normalizeUpload(fixture("FLAT_DOT_TAR_GZ"));
    expect(result.files.map((f) => f.path).sort()).toEqual(FLAT_FILES);
  });

  it("strips a single wrapping directory into a zip whose root holds SKILL.md and whose digest matches its bytes", async () => {
    const result = await normalizeUpload(fixture("WRAPPED_ZIP"));
    expect(result.files.map((f) => f.path)).toEqual(FLAT_FILES);
    expect((await readZip(result.zip)).has("SKILL.md")).toBe(true);
    expect(result.digest).toBe(`sha256:${sha256Hex(result.zip)}`);
  });

  it("accepts a zip that already has SKILL.md at the root, deterministically", async () => {
    const a = await normalizeUpload(fixture("FLAT_ZIP"));
    const b = await normalizeUpload(fixture("FLAT_ZIP"));
    expect(a.name).toBe("demo-skill");
    expect(a.digest).toBe(b.digest);
  });

  it.each([
    ["an archive without SKILL.md", fixture("NO_SKILL_MD_ZIP"), /SKILL\.md/],
    ["archives containing links", fixture("SYMLINK_TAR_GZ"), /link/i],
    ["an invalid name in frontmatter", enc.encode("---\nname: Demo_Skill\ndescription: nope\n---\nbody"), /name/],
    ["a missing description", enc.encode("---\nname: demo\n---\nbody"), /description/],
    ["an oversized description", enc.encode(`---\nname: demo\ndescription: ${"x".repeat(1025)}\n---\nbody`), /description/],
    ["an upload over the size limit", new Uint8Array(DEFAULT_LIMITS.uploadBytes + 1), /upload/i],
  ])("rejects %s", async (_label, bytes, reason) => {
    const result = normalizeUpload(bytes);
    await expect(result).rejects.toBeInstanceOf(UploadError);
    await expect(result).rejects.toThrow(reason);
  });

  it("rejects an upload over a configured size limit, and accepts one right at it", async () => {
    const bytes = enc.encode(GOOD_MD);
    expect(await issueOf(normalizeUpload(bytes, withLimits({ uploadBytes: SKILL_MD_BYTES - 1 })))).toEqual({
      key: "tooLarge",
      args: [SKILL_MD_BYTES, SKILL_MD_BYTES - 1],
    });
    expect((await normalizeUpload(bytes, withLimits({ uploadBytes: SKILL_MD_BYTES }))).name).toBe("demo-skill");
  });

  it("rejects path traversal", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "../../etc/passwd", data: enc.encode("x") },
    ]);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/path/i);
  });

  it("drops macOS junk entries", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "__MACOSX/._SKILL.md", data: enc.encode("junk") },
      { path: ".DS_Store", data: enc.encode("junk") },
    ]);
    const result = await normalizeUpload(bytes);
    expect(result.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("rejects too many files, and accepts exactly the limit", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "a.txt", data: enc.encode("x") },
      { path: "b.txt", data: enc.encode("x") },
    ]);
    await expect(normalizeUpload(bytes, withLimits({ files: 2 }))).rejects.toThrow(/file count/i);
    expect((await normalizeUpload(bytes, withLimits({ files: 3 }))).files).toHaveLength(3);
  });

  describe("the unpacked size limit", () => {
    const limits = withLimits({ unpackedBytes: 1024 });

    it("rejects a zip whose declared sizes add up past the limit, and accepts one that adds up to exactly it", async () => {
      const bytes = await writeZip([
        { path: "SKILL.md", data: enc.encode(GOOD_MD) },
        { path: "data.txt", data: enc.encode("a".repeat(4096)) },
      ]);
      const total = SKILL_MD_BYTES + 4096;
      expect(await issueOf(normalizeUpload(bytes, limits))).toEqual({ key: "unpackedTooLarge", args: [total, 1024] });
      expect((await normalizeUpload(bytes, withLimits({ unpackedBytes: total }))).files).toHaveLength(2);
    });

    it("goes by the sizes a zip declares, before inflating any entry", async () => {
      const honest = await writeZip([
        { path: "SKILL.md", data: enc.encode(GOOD_MD) },
        { path: "data.txt", data: enc.encode("tiny") },
      ]);
      const lying = declareSize(honest, "data.txt", 10_000);
      await expect(normalizeUpload(lying)).rejects.toThrow(/size mismatch/);
      expect(await issueOf(normalizeUpload(lying, limits))).toEqual({
        key: "unpackedTooLarge",
        args: [SKILL_MD_BYTES + 10_000, 1024],
      });
    });

    it("rejects a tar.gz whose files add up past the limit", async () => {
      const bytes = tarGz([
        { path: "SKILL.md", data: enc.encode(GOOD_MD) },
        { path: "data.txt", data: enc.encode("a".repeat(4096)) },
      ]);
      expect((await normalizeUpload(bytes)).files).toHaveLength(2);
      expect(await issueOf(normalizeUpload(bytes, limits))).toEqual({
        key: "unpackedTooLarge",
        args: [SKILL_MD_BYTES + 4096, 1024],
      });
    });

    it("stops gunzipping a tar.gz that inflates far past the limit instead of inflating all of it", async () => {
      const inflated = 8 * 1024 * 1024;
      const bomb = tarGz([
        { path: "SKILL.md", data: enc.encode(GOOD_MD) },
        { path: "zeros.bin", data: new Uint8Array(inflated) },
      ]);
      expect(bomb.length).toBeLessThan(limits.uploadBytes);
      const found = await issueOf(normalizeUpload(bomb, limits));
      expect(found.key).toBe("unpackedTooLarge");
      expect(found.args[1]).toBe(1024);
      expect(found.args[0]).toBeGreaterThan(1024);
      expect(found.args[0]).toBeLessThan(inflated);
    });
  });
});
