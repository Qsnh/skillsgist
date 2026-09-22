import { env as rawEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ArchiveError, readZip, writeZip } from "../src/skills/zip";
import { readTarGz } from "../src/skills/tar";

// Binary fixtures can't be read with `node:fs` from inside a pool-workers
// test: the worker's `node:fs` is a sandboxed, empty virtual filesystem with
// no bridge to the host disk (confirmed empirically — even `process.cwd()`
// is unreachable). `vitest.config.ts` reads the real files from disk (it
// runs in plain Node) and exposes them here as `dataBlobBindings`. Same
// `Cloudflare.Env`-is-untyped local-cast pattern as test/db.test.ts.
const env = rawEnv as unknown as {
  FLAT_ZIP: ArrayBuffer;
  WRAPPED_ZIP: ArrayBuffer;
  FLAT_DOT_TAR_GZ: ArrayBuffer;
  SYMLINK_TAR_GZ: ArrayBuffer;
};

const dec = new TextDecoder();
const flatZip = new Uint8Array(env.FLAT_ZIP);
const wrappedZip = new Uint8Array(env.WRAPPED_ZIP);
const flatDotTarGz = new Uint8Array(env.FLAT_DOT_TAR_GZ);
const symlinkTarGz = new Uint8Array(env.SYMLINK_TAR_GZ);

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
});
