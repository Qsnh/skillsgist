import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32, writeZip } from "../src/skills/zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("crc32", () => {
  it.each([
    ["123456789", 0xcbf43926],
    ["", 0],
  ])("hashes %j to the standard value", (input, expected) => {
    expect(crc32(enc.encode(input))).toBe(expected);
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

  it("uses deflate method for genuinely compressible content", async () => {
    const compressible = enc.encode("a".repeat(500));
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode("# Skill") },
      { path: "data.txt", data: compressible },
    ]);
    const files = unzipSync(bytes);
    expect(files["data.txt"]).toEqual(compressible);
    expect(bytes.length).toBeLessThan("# Skill".length + compressible.length);
  });
});
