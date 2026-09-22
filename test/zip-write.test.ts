import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32, writeZip } from "../src/skills/zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("crc32", () => {
  it("matches the standard test vector", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("returns 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("writeZip", () => {
  it("produces an archive a third-party reader can open", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("---\nname: demo\n---\nhello") },
      { path: "references/api.md", data: enc.encode("# api") },
    ]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "references/api.md"]);
    expect(dec.decode(files["SKILL.md"])).toContain("name: demo");
    expect(dec.decode(files["references/api.md"])).toBe("# api");
  });

  it("sorts entries by path so output is deterministic", async () => {
    const a = await writeZip([
      { path: "b.md", data: enc.encode("b") },
      { path: "SKILL.md", data: enc.encode("a") },
    ]);
    const b = await writeZip([
      { path: "SKILL.md", data: enc.encode("a") },
      { path: "b.md", data: enc.encode("b") },
    ]);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });

  it("round-trips content that does not benefit from compression", async () => {
    const random = crypto.getRandomValues(new Uint8Array(512));
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("x") },
      { path: "blob.bin", data: random },
    ]);
    const files = unzipSync(bytes);
    expect(files["blob.bin"]).toEqual(random);
  });

  it("uses deflate method for genuinely compressible content", async () => {
    // A highly repetitive payload that compresses well.
    const compressible = enc.encode("a".repeat(500));
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("# Skill") },
      { path: "data.txt", data: compressible },
    ]);
    const files = unzipSync(bytes);
    // Verify round-trip through independent reader.
    expect(files["data.txt"]).toEqual(compressible);
    // Verify that the archive is smaller than the sum of uncompressed inputs,
    // confirming the deflate path was actually taken.
    const rawSize =
      "# Skill".length + compressible.length;
    expect(bytes.length).toBeLessThan(rawSize);
  });
});
