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

  it("reads back what writeZip produced", async () => {
    const enc = new TextEncoder();
    const bytes = await writeZip([{ path: "SKILL.md", data: enc.encode("hello") }]);
    const files = await readZip(bytes);
    expect(dec.decode(files.get("SKILL.md"))).toBe("hello");
  });

  it("rejects bytes that are not a zip", async () => {
    await expect(readZip(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(ArchiveError);
  });

  it("wraps a corrupt deflate stream as ArchiveError instead of leaking a raw exception", async () => {
    const enc = new TextEncoder();
    const name = "data.txt";
    const nameLen = enc.encode(name).length;
    // A highly repetitive payload guarantees writeZip picks method 8 (deflate).
    const compressible = enc.encode("a".repeat(500));
    const bytes = await writeZip([{ path: name, data: compressible }]);
    // writeZip's layout for a single entry: [local header][compressed
    // body][central directory entry][22-byte EOCD]. Compute the exact
    // compressed-body span and smash only that (same length in, same length
    // out) so the local header, central directory, and EOCD stay
    // structurally valid — this isolates the failure to the inflate step
    // itself, feeding DecompressionStream("deflate-raw") garbage instead of
    // touching anything readZip parses before or after it.
    const localHeaderLen = 30 + nameLen;
    const centralEntryLen = 46 + nameLen;
    const bodyLen = bytes.length - localHeaderLen - centralEntryLen - 22;
    const corrupted = new Uint8Array(bytes);
    corrupted.fill(0xff, localHeaderLen, localHeaderLen + bodyLen);
    await expect(readZip(corrupted)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("readTarGz", () => {
  it("reads a tarball whose entries carry a ./ prefix", async () => {
    const files = await readTarGz(flatDotTarGz);
    expect([...files.keys()]).toContain("./SKILL.md");
    expect(dec.decode(files.get("./SKILL.md"))).toContain("name: demo-skill");
  });

  it("skips directory entries", async () => {
    const files = await readTarGz(flatDotTarGz);
    for (const key of files.keys()) expect(key.endsWith("/")).toBe(false);
  });

  it("rejects archives containing links", async () => {
    await expect(readTarGz(symlinkTarGz)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("reads a tarball produced by bsdtar's own default compression (block-padded gzip)", async () => {
    // macOS's default `tar` is bsdtar; `tar czf` has it gzip its own output,
    // which pads to a block boundary with trailing zero bytes after the
    // real gzip stream ends. This is the single most standard command a
    // macOS user would run, and it must not be rejected.
    const files = await readTarGz(bsdtarPaddedTarGz);
    expect([...files.keys()]).toContain("./SKILL.md");
    expect(dec.decode(files.get("./SKILL.md"))).toContain("name: demo-skill");
    expect(dec.decode(files.get("./references/api.md"))).toContain("API notes");
  });

  it("rejects genuinely corrupt gzip data (not just padding)", async () => {
    // Valid gzip magic bytes, but otherwise random non-zero garbage — the
    // padding probe must not mistake this for the bsdtar-padding case.
    const bad = new Uint8Array(300);
    bad[0] = 0x1f;
    bad[1] = 0x8b;
    for (let i = 2; i < bad.length; i++) bad[i] = ((i * 37) % 256) || 1; // never 0x00
    await expect(readTarGz(bad)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("gzipRetryLengths", () => {
  // Regression pin for a bug introduced by the padding-tolerance fix itself:
  // `indexAfterLastNonZero` returns `data.length` unchanged when the last
  // byte isn't zero, which is true of essentially all garbage, truncated, or
  // adversarial input (trivial for an attacker to guarantee). Before this
  // fix, every one of the (bounded) probe iterations recomputed
  // `Math.min(floor + extra, data.length)` as `data.length` and re-ran the
  // exact same decompression attempt that had already failed, up to 9 extra
  // times — a flat ~10x CPU multiplier on the failure path for ordinary
  // corrupt input, not just the bsdtar-padding case the probe exists for.
  // These tests assert on the pure candidate-length function directly rather
  // than on CPU time, so a future edit that reintroduces the duplicate
  // probing fails a test instead of passing silently.

  it("returns no candidates when the buffer doesn't end in a zero byte", () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    expect(gzipRetryLengths(garbage)).toEqual([]);
  });

  it("never proposes the length that already failed, and never repeats a candidate", () => {
    const withPadding = new Uint8Array([9, 9, 9, 0, 0, 0, 0, 0]);
    const lengths = gzipRetryLengths(withPadding);
    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths).not.toContain(withPadding.length);
    expect(new Set(lengths).size).toBe(lengths.length);
  });

  it("stays bounded no matter how much trailing padding there is", () => {
    const hugePadding = new Uint8Array(10_000);
    hugePadding[0] = 1;
    const lengths = gzipRetryLengths(hugePadding);
    expect(lengths.length).toBeLessThanOrEqual(9); // GZIP_TRAILER_LEN (8) + 1
    expect(lengths).not.toContain(hugePadding.length);
  });
});
