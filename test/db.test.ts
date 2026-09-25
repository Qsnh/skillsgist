import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { env, resetDb } from "./helpers";

const seedU1 = () =>
  q.createUser(env.DB, {
    id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
  });

const base = {
  digest: "sha256:" + "a".repeat(64),
  size: 100,
  name: "demo",
  description: "a demo skill",
  skill_md: "---\nname: demo\ndescription: a demo skill\n---\nbody",
  html: "<p>body</p>",
  html_rev: 1,
  files: JSON.stringify([{ path: "SKILL.md", size: 10 }]),
};

describe("queries", () => {
  beforeEach(resetDb);

  it("counts users and round-trips one", async () => {
    expect(await q.countUsers(env.DB)).toBe(0);
    await seedU1();
    expect(await q.countUsers(env.DB)).toBe(1);
    const byName = await q.getUserByUsername(env.DB, "alice");
    expect(byName?.id).toBe("u1");
    expect(await q.getUserByInstallKey(env.DB, "k1")).not.toBeNull();
    expect(await q.getUserByInstallKey(env.DB, "nope")).toBeNull();
  });

  it("allocates version numbers monotonically per slug", async () => {
    await seedU1();
    const v1 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
    });
    const v2 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
      digest: "sha256:" + "b".repeat(64),
    });
    expect(v1).toEqual({ version: 1, r2Key: "skills/demo/1.zip" });
    expect(v2).toEqual({ version: 2, r2Key: "skills/demo/2.zip" });
    // The key it returns is the key it recorded — publish.ts writes the R2
    // object under exactly this, instead of re-deriving the string.
    expect((await q.getVersion(env.DB, "demo", 2))?.r2_key).toBe(v2.r2Key);
    const skill = await q.getSkill(env.DB, "demo");
    expect(skill?.latest_version).toBe(2);
    expect(await q.listVersions(env.DB, "demo")).toHaveLength(2);
  });

  it("hides private skills from the public index", async () => {
    await seedU1();
    await q.insertVersion(env.DB, { ...base, slug: "secret", authorId: "u1", visibility: "private" });
    await q.insertVersion(env.DB, {
      ...base, slug: "shared", authorId: "u1", visibility: "public",
      digest: "sha256:" + "c".repeat(64),
    });
    const pub = await q.listPublishedForIndex(env.DB, false);
    expect(pub.map((s) => s.slug)).toEqual(["shared"]);
    const all = await q.listPublishedForIndex(env.DB, true);
    expect(all.map((s) => s.slug).sort()).toEqual(["secret", "shared"]);
  });

  it("returns r2 keys when deleting a skill", async () => {
    await seedU1();
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    const keys = await q.deleteSkill(env.DB, "demo");
    expect(keys).toEqual(["skills/demo/1.zip"]);
    expect(await q.getSkill(env.DB, "demo")).toBeNull();
  });

  it("counts downloads without touching updated_at", async () => {
    await seedU1();
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    const before = await q.getSkill(env.DB, "demo");
    expect(before?.download_count).toBe(0);

    await q.incrementDownloads(env.DB, "demo");
    await q.incrementDownloads(env.DB, "demo");

    const after = await q.getSkill(env.DB, "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("keeps the download count when a new version is published", async () => {
    await seedU1();
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    await q.incrementDownloads(env.DB, "demo");
    await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
      digest: "sha256:" + "b".repeat(64),
    });
    expect((await q.getSkill(env.DB, "demo"))?.download_count).toBe(1);
  });

  it("starts from zero when a deleted skill is published again", async () => {
    await seedU1();
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    await q.incrementDownloads(env.DB, "demo");
    await q.deleteSkill(env.DB, "demo");
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    expect((await q.getSkill(env.DB, "demo"))?.download_count).toBe(0);
  });

  it("ignores a download for a slug that does not exist", async () => {
    await expect(q.incrementDownloads(env.DB, "gone")).resolves.toBeUndefined();
  });
});
