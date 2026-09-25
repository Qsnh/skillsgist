import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { env, resetDb } from "./helpers";

const seedU1 = () => q.createUser(env.DB, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });

const join = (userId: string, project: string, installKey: string, role: "admin" | "member" = "member") =>
  q.addMembership(env.DB, { project, userId, role, installKey });

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

  it("counts users and round-trips one", async () => {
    expect(await q.countUsers(env.DB)).toBe(0);
    await seedU1();
    expect(await q.countUsers(env.DB)).toBe(1);
    const byName = await q.getUserByUsername(env.DB, "alice");
    expect(byName?.id).toBe("u1");
    expect(byName).not.toHaveProperty("install_key");
  });

  it("creates, finds and lists projects by name", async () => {
    await q.createProject(env.DB, { slug: "zeta", name: "Alpha team" });
    expect(await q.getProject(env.DB, "zeta")).toMatchObject({ slug: "zeta", name: "Alpha team" });
    expect(await q.getProject(env.DB, "nope")).toBeNull();
    expect((await q.listProjects(env.DB)).map((p) => p.slug)).toEqual(["zeta", "default"]);
  });

  it("finds a membership by its install key", async () => {
    await seedU1();
    await join("u1", q.DEFAULT_PROJECT, "k1", "admin");
    expect(await q.getMembershipByInstallKey(env.DB, "k1")).toMatchObject({
      project: "default", user_id: "u1", role: "admin",
    });
    expect(await q.getMembershipByInstallKey(env.DB, "nope")).toBeNull();
  });

  it("loads a viewer with their memberships and project names, ordered by name", async () => {
    await seedU1();
    await q.createProject(env.DB, { slug: "aaa", name: "Zebra" });
    await join("u1", "aaa", "kz");
    await join("u1", q.DEFAULT_PROJECT, "kd");
    const viewer = await q.getViewer(env.DB, "u1");
    expect(viewer?.username).toBe("alice");
    expect(viewer?.memberships.map((m) => [m.project, m.project_name, m.install_key])).toEqual([
      ["default", "Default", "kd"],
      ["aaa", "Zebra", "kz"],
    ]);
    expect(await q.getViewer(env.DB, "nobody")).toBeNull();
  });

  it("loads a viewer by api token hash", async () => {
    await seedU1();
    await join("u1", q.DEFAULT_PROJECT, "kd");
    await q.updateApiTokenHash(env.DB, "u1", "hash-1");
    expect((await q.getViewerByApiTokenHash(env.DB, "hash-1"))?.memberships).toHaveLength(1);
    expect(await q.getViewerByApiTokenHash(env.DB, "hash-2")).toBeNull();
  });

  it("makes the first admin a member of the default project, once", async () => {
    const first = { id: "u1", username: "root", passwordHash: "h", installKey: "k1" };
    expect(await q.createFirstAdmin(env.DB, first)).toBe(true);
    expect(await q.createFirstAdmin(env.DB, { ...first, id: "u2", username: "late", installKey: "k2" })).toBe(false);
    expect(await q.getMembershipByInstallKey(env.DB, "k1")).toMatchObject({
      project: "default", user_id: "u1", role: "member",
    });
    expect(await q.getMembershipByInstallKey(env.DB, "k2")).toBeNull();
  });

  it("gives each of a user's memberships a fresh, distinct install key", async () => {
    await seedU1();
    await q.createProject(env.DB, { slug: "team-b", name: "Team B" });
    await join("u1", q.DEFAULT_PROJECT, "old-1");
    await join("u1", "team-b", "old-2");
    let n = 0;
    await q.rotateInstallKeys(env.DB, "u1", () => `new-${++n}`);
    const keys = (await q.getViewer(env.DB, "u1"))?.memberships.map((m) => m.install_key).sort();
    expect(keys).toEqual(["new-1", "new-2"]);
  });

  it("rotates nothing for a user in no project", async () => {
    await seedU1();
    await expect(q.rotateInstallKeys(env.DB, "u1", () => "x")).resolves.toBeUndefined();
  });

  it("deletes a user who belongs to a project, reassigning their skills", async () => {
    await seedU1();
    await q.createUser(env.DB, { id: "u2", username: "bob", passwordHash: "h", role: "member" });
    await join("u2", q.DEFAULT_PROJECT, "kb");
    await q.insertVersion(env.DB, { ...base, authorId: "u2" });
    await q.deleteUserReassigning(env.DB, "u2", "u1");
    expect(await q.getUserById(env.DB, "u2")).toBeNull();
    expect(await q.getMembershipByInstallKey(env.DB, "kb")).toBeNull();
    expect((await q.getSkill(env.DB, "default", "demo"))?.owner_id).toBe("u1");
    expect((await q.getVersion(env.DB, "default", "demo", 1))?.author_id).toBe("u1");
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

  it("keeps skills with the same name in different projects apart", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b", digest: digest("b") });
    expect((await q.getSkill(env.DB, "default", "demo"))?.id).toBe("s1");
    expect((await q.getSkill(env.DB, "team-b", "demo"))?.id).toBe("s2");
    expect((await q.getVersion(env.DB, "team-b", "demo", 1))?.digest).toBe(digest("b"));
    expect(await q.getSkill(env.DB, "team-b", "other")).toBeNull();
  });

  it("refuses a second skill with the same name in one project", async () => {
    await q.insertVersion(env.DB, base);
    await expect(q.insertVersion(env.DB, { ...base, skillId: "s2", digest: digest("b") })).rejects.toThrow(/UNIQUE/);
  });

  it("lists skills with author and project name, by scope and search", async () => {
    await join("u1", q.DEFAULT_PROJECT, "k1");
    await q.insertVersion(env.DB, { ...base, slug: "mine", name: "mine" });
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b", slug: "theirs", name: "theirs" });
    await q.insertVersion(env.DB, {
      ...base, skillId: "s3", project: "team-b", slug: "open", name: "open", visibility: "public",
    });
    const slugs = async (scope: q.SkillScope, text?: string) =>
      (await q.listSkills(env.DB, { scope, q: text })).map((s) => s.slug).sort();

    expect(await slugs({ kind: "public" })).toEqual(["open"]);
    expect(await slugs({ kind: "member", userId: "u1" })).toEqual(["mine", "open"]);
    expect(await slugs({ kind: "all" })).toEqual(["mine", "open", "theirs"]);
    expect(await slugs({ kind: "member", userId: "u1" }, "theirs")).toEqual([]);
    expect(await slugs({ kind: "all" }, "theirs")).toEqual(["theirs"]);
    const [open] = await q.listSkills(env.DB, { scope: { kind: "public" } });
    expect(open).toMatchObject({ author: "alice", project: "team-b", project_name: "Team B" });
    expect(await q.getSkillWithAuthor(env.DB, "team-b", "open")).toMatchObject({ author: "alice", project_name: "Team B" });
  });

  it("indexes one project's skills, its public ones, or every unambiguous public name", async () => {
    await q.insertVersion(env.DB, { ...base, slug: "secret", name: "secret" });
    await q.insertVersion(env.DB, { ...base, skillId: "s2", slug: "shared", name: "shared", visibility: "public" });
    await q.insertVersion(env.DB, {
      ...base, skillId: "s3", project: "team-b", slug: "elsewhere", name: "elsewhere", visibility: "public",
    });
    await q.insertVersion(env.DB, {
      ...base, skillId: "s4", project: "team-b", slug: "shared", name: "shared", visibility: "public",
    });
    const slugs = async (filter: q.IndexFilter) => (await q.listPublishedForIndex(env.DB, filter)).map((s) => s.slug);

    expect(await slugs({ kind: "root" })).toEqual(["elsewhere"]);
    expect(await slugs({ kind: "project", project: "default", publicOnly: false })).toEqual(["secret", "shared"]);
    expect(await slugs({ kind: "project", project: "default", publicOnly: true })).toEqual(["shared"]);
    expect(await slugs({ kind: "project", project: "team-b", publicOnly: true })).toEqual(["elsewhere", "shared"]);

    await q.setVisibility(env.DB, "team-b", "shared", "private");
    expect(await slugs({ kind: "root" })).toEqual(["elsewhere", "shared"]);
  });

  it("finds artifacts by project, name and version or digest, and public ones by name and digest", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b", digest: digest("b"), visibility: "public" });
    expect(await q.getArtifactByVersion(env.DB, "default", "demo", null)).toEqual({
      project: "default", slug: "demo", visibility: "private", r2_key: "artifacts/s1/1.zip",
    });
    expect((await q.getArtifactByDigest(env.DB, "team-b", "demo", digest("b")))?.r2_key).toBe("artifacts/s2/1.zip");
    expect(await q.getArtifactByDigest(env.DB, "default", "demo", digest("b"))).toBeNull();
    expect((await q.getPublicArtifact(env.DB, "demo", digest("b")))?.project).toBe("team-b");
    expect(await q.getPublicArtifact(env.DB, "demo", digest("a"))).toBeNull();
  });

  it("returns r2 keys when deleting a skill and leaves the same name in another project alone", async () => {
    await q.insertVersion(env.DB, base);
    await q.insertVersion(env.DB, { ...base, skillId: "s2", project: "team-b" });
    expect(await q.deleteSkill(env.DB, "default", "demo")).toEqual(["artifacts/s1/1.zip"]);
    expect(await q.getSkill(env.DB, "default", "demo")).toBeNull();
    expect(await q.getVersion(env.DB, "team-b", "demo", 1)).not.toBeNull();
  });

  it("re-renders one version's html in place", async () => {
    await q.insertVersion(env.DB, base);
    await q.updateVersionHtml(env.DB, "default", "demo", 1, "<p>new</p>", 9);
    expect(await q.getVersion(env.DB, "default", "demo", 1)).toMatchObject({ html: "<p>new</p>", html_rev: 9 });
  });

  it("counts downloads without touching updated_at", async () => {
    await q.insertVersion(env.DB, base);
    const before = await q.getSkill(env.DB, "default", "demo");
    expect(before?.download_count).toBe(0);

    await q.incrementDownloads(env.DB, "default", "demo");
    await q.incrementDownloads(env.DB, "default", "demo");

    const after = await q.getSkill(env.DB, "default", "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("keeps the download count when a new version is published", async () => {
    await q.insertVersion(env.DB, base);
    await q.incrementDownloads(env.DB, "default", "demo");
    await q.insertVersion(env.DB, { ...base, digest: digest("b") });
    expect((await q.getSkill(env.DB, "default", "demo"))?.download_count).toBe(1);
  });

  it("starts from zero when a deleted skill is published again", async () => {
    await q.insertVersion(env.DB, base);
    await q.incrementDownloads(env.DB, "default", "demo");
    await q.deleteSkill(env.DB, "default", "demo");
    await q.insertVersion(env.DB, { ...base, skillId: "s9" });
    expect((await q.getSkill(env.DB, "default", "demo"))?.download_count).toBe(0);
  });

  it("ignores a download for a skill that does not exist", async () => {
    await expect(q.incrementDownloads(env.DB, "default", "gone")).resolves.toBeUndefined();
  });
});
