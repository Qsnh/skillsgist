import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash";
import { MAX_FILES, normalizeUpload, UploadError } from "../src/skills/normalize";
import { readZip, writeZip } from "../src/skills/zip";
import { fixture, FLAT_FILES, GOOD_MD } from "./helpers";

const enc = new TextEncoder();

describe("normalizeUpload", () => {
  it("accepts a bare SKILL.md", async () => {
    const result = await normalizeUpload(enc.encode(GOOD_MD));
    expect(result.name).toBe("demo-skill");
    expect(result.description).toBe("A demo skill used by the test suite.");
    expect(result.files).toEqual([{ path: "SKILL.md", size: enc.encode(GOOD_MD).length }]);
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
    expect(result.digest).toBe(`sha256:${await sha256Hex(result.zip)}`);
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
    ["an upload over the size limit", new Uint8Array(2 * 1024 * 1024 + 1), /upload/i],
  ])("rejects %s", async (_label, bytes, reason) => {
    const result = normalizeUpload(bytes);
    await expect(result).rejects.toBeInstanceOf(UploadError);
    await expect(result).rejects.toThrow(reason);
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

  it("rejects too many files", async () => {
    const entries = [{ path: "SKILL.md", data: enc.encode(GOOD_MD) }];
    for (let i = 0; i <= MAX_FILES; i++) entries.push({ path: `f${i}.txt`, data: enc.encode("x") });
    const bytes = await writeZip(entries);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/file count/i);
  });
});
