import { describe, expect, it } from "vitest";
import { ArchiveError, readZip, writeZip } from "../src/skills/zip";
import { gzipRetryLengths, readTarGz } from "../src/skills/tar";
import { fixture } from "./helpers";

const dec = new TextDecoder();
const flatZip = fixture("FLAT_ZIP");
const wrappedZip = fixture("WRAPPED_ZIP");
const flatDotTarGz = fixture("FLAT_DOT_TAR_GZ");
const symlinkTarGz = fixture("SYMLINK_TAR_GZ");
const bsdtarPaddedTarGz = fixture("BSDTAR_PADDED_TAR_GZ");

describe("readZip", () => {
  it("reads a zip produced by the system zip tool", async () => {
    const files = await readZip(flatZip);
    expect([...files.keys()]).toContain("SKILL.md");
    expect(dec.decode(files.get("SKILL.md"))).toContain("name: demo-skill");
    expect(dec.decode(files.get("references/api.md"))).toContain("API notes");
  });

  it("keeps the wrapper directory in the raw paths", async () => {
    const files = await readZip(wrappedZip);
    expect([...files.keys()]).toContain("demo-skill/SKILL.md");
    expect(files.has("SKILL.md")).toBe(false);
  });

  it("rejects bytes that are not a zip", async () => {
    await expect(readZip(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(ArchiveError);
  });

  it("reads back a deflated writeZip entry, and wraps a corrupt deflate stream as ArchiveError", async () => {
    const enc = new TextEncoder();
    const name = "data.txt";
    const nameLen = enc.encode(name).length;
    const compressible = enc.encode("a".repeat(500));
    const bytes = await writeZip([{ path: name, data: compressible }]);
    expect((await readZip(bytes)).get(name)).toEqual(compressible);
    const localHeaderLen = 30 + nameLen;
    const centralEntryLen = 46 + nameLen;
    const bodyLen = bytes.length - localHeaderLen - centralEntryLen - 22;
    const corrupted = new Uint8Array(bytes);
    corrupted.fill(0xff, localHeaderLen, localHeaderLen + bodyLen);
    await expect(readZip(corrupted)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("readTarGz", () => {
  it("reads a tarball whose entries carry a ./ prefix, skipping directory entries", async () => {
    const files = await readTarGz(flatDotTarGz);
    expect([...files.keys()]).toContain("./SKILL.md");
    expect(dec.decode(files.get("./SKILL.md"))).toContain("name: demo-skill");
    for (const key of files.keys()) expect(key.endsWith("/")).toBe(false);
  });

  it("rejects archives containing links", async () => {
    await expect(readTarGz(symlinkTarGz)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("reads a tarball produced by bsdtar's own default compression (block-padded gzip)", async () => {
    const files = await readTarGz(bsdtarPaddedTarGz);
    expect([...files.keys()].sort()).toEqual(["./SKILL.md", "./references/api.md", "./scripts/run.sh"]);
    expect(dec.decode(files.get("./SKILL.md"))).toContain("name: demo-skill");
    expect(dec.decode(files.get("./references/api.md"))).toContain("API notes");
  });

  it("rejects genuinely corrupt gzip data (not just padding)", async () => {
    const bad = new Uint8Array(300);
    bad[0] = 0x1f;
    bad[1] = 0x8b;
    for (let i = 2; i < bad.length; i++) bad[i] = ((i * 37) % 256) || 1;
    await expect(readTarGz(bad)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("gzipRetryLengths", () => {
  it.each([
    ["no trailing zero byte", new Uint8Array([1, 2, 3, 4, 5]), 0, 0],
    ["a little padding", new Uint8Array([9, 9, 9, 0, 0, 0, 0, 0]), 1, 9],
    ["huge padding", Uint8Array.from({ length: 10_000 }, (_, i) => (i === 0 ? 1 : 0)), 1, 9],
  ])("proposes a bounded set of new, distinct lengths for %s", (_label, data, min, max) => {
    const lengths = gzipRetryLengths(data);
    expect(lengths.length).toBeGreaterThanOrEqual(min);
    expect(lengths.length).toBeLessThanOrEqual(max);
    expect(lengths).not.toContain(data.length);
    expect(new Set(lengths).size).toBe(lengths.length);
  });
});
