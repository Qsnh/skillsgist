import { describe, expect, it } from "vitest";
import { MAX_FILES, normalizeUpload, UploadError } from "../src/skills/normalize";
import { readZip, writeZip } from "../src/skills/zip";
import { fixture, GOOD_MD } from "./helpers";

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
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md", "references/api.md", "scripts/run.sh",
    ]);
  });

  it("strips a single wrapping directory", async () => {
    const result = await normalizeUpload(fixture("WRAPPED_ZIP"));
    expect(result.files.map((f) => f.path)).toContain("SKILL.md");
    expect(result.files.every((f) => !f.path.startsWith("demo-skill/"))).toBe(true);
  });

  it("accepts a zip that already has SKILL.md at the root", async () => {
    const result = await normalizeUpload(fixture("FLAT_ZIP"));
    expect(result.name).toBe("demo-skill");
  });

  it("rejects an archive without SKILL.md", async () => {
    await expect(normalizeUpload(fixture("NO_SKILL_MD_ZIP"))).rejects.toBeInstanceOf(UploadError);
  });

  it("rejects archives containing links", async () => {
    await expect(normalizeUpload(fixture("SYMLINK_TAR_GZ"))).rejects.toBeInstanceOf(UploadError);
  });

  it("accepts a tarball padded by bsdtar's default gzip (macOS tar czf)", async () => {
    // bsdtar-padded.tar.gz is what macOS's default `tar czf` produces: the
    // gzip stream is zero-padded to a block boundary. readTarGz
    // already tolerates this at the reader level; pin the tolerance at the
    // pipeline level too, since this is the single most likely real-world
    // upload shape from a macOS user.
    const result = await normalizeUpload(fixture("BSDTAR_PADDED_TAR_GZ"));
    expect(result.name).toBe("demo-skill");
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md", "references/api.md", "scripts/run.sh",
    ]);
  });

  it("rejects path traversal", async () => {
    const bytes = await writeZip([
      { path: "SKILL.md", data: enc.encode(GOOD_MD) },
      { path: "../../etc/passwd", data: enc.encode("x") },
    ]);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/路径/);
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

  it("rejects an invalid name in frontmatter", async () => {
    const md = "---\nname: Demo_Skill\ndescription: nope\n---\nbody";
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/name/);
  });

  it("rejects a missing description", async () => {
    const md = "---\nname: demo\n---\nbody";
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/description/);
  });

  it("rejects an oversized description", async () => {
    const md = `---\nname: demo\ndescription: ${"x".repeat(1025)}\n---\nbody`;
    await expect(normalizeUpload(enc.encode(md))).rejects.toThrow(/description/);
  });

  it("rejects too many files", async () => {
    const entries = [{ path: "SKILL.md", data: enc.encode(GOOD_MD) }];
    for (let i = 0; i <= MAX_FILES; i++) entries.push({ path: `f${i}.txt`, data: enc.encode("x") });
    const bytes = await writeZip(entries);
    await expect(normalizeUpload(bytes)).rejects.toThrow(/文件数/);
  });

  it("rejects an upload over the size limit", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(normalizeUpload(big)).rejects.toThrow(/上传/);
  });

  it("produces a zip whose root holds SKILL.md and whose digest matches its bytes", async () => {
    const result = await normalizeUpload(fixture("WRAPPED_ZIP"));
    const files = await readZip(result.zip);
    expect(files.has("SKILL.md")).toBe(true);
    const hash = await crypto.subtle.digest("SHA-256", result.zip);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(result.digest).toBe(`sha256:${hex}`);
  });

  it("is deterministic for identical input", async () => {
    const a = await normalizeUpload(fixture("FLAT_ZIP"));
    const b = await normalizeUpload(fixture("FLAT_ZIP"));
    expect(a.digest).toBe(b.digest);
  });
});
