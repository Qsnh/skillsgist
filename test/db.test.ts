import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { env, joinProject, membership, resetDb } from "./helpers";

const seedU1 = () => q.createUser(env.DB, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });

const digest = (c: string) => "sha256:" + c.repeat(64);

const base = {
  skillId: "s1",
  project: q.DEFAULT_PROJECT,
  slug: "demo",
  digest: digest("a"),
  size: 100,
  name: "demo",
  description: "a demo skill",
  skill_md: "---\nname: demo\ndescription: a demo skill\n---\nbody",
  html: "<p>body</p>",
  html_rev: 1,
  files: JSON.stringify([{ path: "SKILL.md", size: 10 }]),
  authorId: "u1",
  visibility: "private" as const,
};

describe("accounts, projects and memberships", () => {
  beforeEach(resetDb);

  it("loads a viewer with their memberships and project names, and lists projects, ordered by name", async () => {
    await seedU1();
    await q.createProject(env.DB, { slug: "aaa", name: "Zebra" });
    await joinProject("u1", "aaa", "kz");
    await joinProject("u1", q.DEFAULT_PROJECT, "kd");
    const viewer = await q.getViewer(env.DB, "u1");
    expect(viewer?.username).toBe("alice");
    expect(viewer?.memberships.map((m) => [m.project, m.project_name, m.install_key])).toEqual([
      ["default", "Default", "kd"],
      ["aaa", "Zebra", "kz"],
    ]);
    expect(await q.getViewer(env.DB, "nobody")).toBeNull();
    expect((await q.listProjects(env.DB)).map((p) => p.slug)).toEqual(["default", "aaa"]);
  });

  it("makes the first admin a member of the default project, once", async () => {
    const first = { id: "u1", username: "root", passwordHash: "h", installKey: "k1" };
    expect(await q.createFirstAdmin(env.DB, first)).toBe(true);
    expect(await q.createFirstAdmin(env.DB, { ...first, id: "u2", username: "late", installKey: "k2" })).toBe(false);
    expect(await membership("u1")).toMatchObject({ role: "member", install_key: "k1" });
    expect(await membership("u2")).toBeNull();
  });

  it("rotates nothing for a user in no project", async () => {
    await seedU1();
    await expect(q.rotateInstallKeys(env.DB, "u1", () => "x")).resolves.toBeUndefined();
  });

  it("summarises the projects each account is in and the skills it owns", async () => {
    await seedU1();
    await q.createUser(env.DB, { id: "u2", username: "bob", passwordHash: "h", role: "member" });
    await q.createProject(env.DB, { slug: "team-b", name: "Team B" });
    await joinProject("u1", q.DEFAULT_PROJECT, "k1");
    await joinProject("u1", "team-b", "k2");
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", slug: "other", name: "other" });
    await q.insertVersion(env.DB, { ...base, authorId: "u2" });
    await env.DB.batch(
      [["l1", 100], ["l2", 50]].map(([id, usedAt]) =>
        env.DB.prepare(
          "INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at, last_used_at) VALUES (?, 'active', 'u1', 'x', 5, 0, 0, ?)",
        ).bind(id, usedAt),
      ),
    );
    expect((await q.listUserSummaries(env.DB, 50)).map((u) => [u.username, u.projects, u.skills, u.cli_logins])).toEqual([
      ["alice", 2, 2, 1],
      ["bob", 0, 0, 0],
    ]);
    expect(await q.getUserSummary(env.DB, "u1", 50)).toMatchObject({ username: "alice", cli_logins: 1 });
    expect(await q.getUserSummary(env.DB, "u1", 0)).not.toHaveProperty("password_hash");
  });
});

describe("skills", () => {
  beforeEach(async () => {
    await resetDb();
    await seedU1();
    await q.createProject(env.DB, { slug: "team-b", name: "Team B" });
  });

  it("allocates version numbers per skill and stores each under the skill's id", async () => {
    const v1 = await q.insertVersion(env.DB, base);
    const v2 = await q.insertVersion(env.DB, { ...base, digest: digest("b") });
    expect(v1).toEqual({ version: 1, r2Key: "artifacts/s1/1.zip" });
    expect(v2).toEqual({ version: 2, r2Key: "artifacts/s1/2.zip" });
    expect((await q.getVersion(env.DB, "default", "demo", 2))?.r2_key).toBe(v2.r2Key);
    const skill = await q.getSkill(env.DB, "default", "demo");
    expect(skill).toMatchObject({ id: "s1", project: "default", slug: "demo", latest_version: 2 });
    expect(await q.listVersions(env.DB, "default", "demo")).toHaveLength(2);
  });

  it("keeps a name in the narrowed root index while its other copies are private", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b", visibility: "public" });
    expect((await q.listPublishedForIndex(env.DB, { kind: "root" }, "demo")).map((s) => s.slug)).toEqual(["demo"]);
  });

  it("finds an artifact by digest only in its own project", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b", digest: digest("b"), visibility: "public" });
    expect((await q.getArtifactByDigest(env.DB, "team-b", "demo", digest("b")))?.r2_key).toBe("artifacts/s2/1.zip");
    expect(await q.getArtifactByDigest(env.DB, "default", "demo", digest("b"))).toBeNull();
  });

  it("returns r2 keys when deleting a skill and leaves the same name in another project alone", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b" });
    expect(await q.deleteSkill(env.DB, "default", "demo")).toEqual(["artifacts/s1/1.zip"]);
    expect(await q.getSkill(env.DB, "default", "demo")).toBeNull();
    expect(await q.getVersion(env.DB, "team-b", "demo", 1)).not.toBeNull();
  });

  it("counts downloads without touching updated_at, keeps the count across versions, and ignores a missing skill", async () => {
    await q.insertVersion(env.DB, base);
    const before = await q.getSkill(env.DB, "default", "demo");
    expect(before?.download_count).toBe(0);

    await q.incrementDownloads(env.DB, "default", "demo");
    await q.incrementDownloads(env.DB, "default", "demo");

    const after = await q.getSkill(env.DB, "default", "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);

    await q.insertVersion(env.DB, { ...base, digest: digest("b") });
    expect((await q.getSkill(env.DB, "default", "demo"))?.download_count).toBe(2);
    await expect(q.incrementDownloads(env.DB, "default", "gone")).resolves.toBeUndefined();
  });
});
