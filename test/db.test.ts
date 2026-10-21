import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { env, joinProject, membership, resetDb } from "./helpers";

const seedU1 = () => q.createUser(env.db, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });

const digest = (c: string) => "sha256:" + c.repeat(64);

const keyFor = (skillId: string, c: string) => `skills/${skillId}/${c.repeat(64)}.zip`;

const insert = (input: q.InsertVersionInput) =>
  q.insertVersion(env.db, { ...input, objectKey: q.objectKeyFor(input.skillId, input.digest) });

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

  it("names the member an install key belongs to", () => {
    seedU1();
    joinProject("u1", q.DEFAULT_PROJECT, "sgi_k1");
    expect(q.getInstallKeyAccess(env.db, "sgi_k1")).toEqual({ project: "default", user_id: "u1", username: "alice" });
    expect(q.getInstallKeyAccess(env.db, "sgi_nope")).toBeNull();
  });

  it("loads a viewer with their memberships and project names, and lists projects, ordered by name", () => {
    seedU1();
    q.createProject(env.db, { slug: "aaa", name: "Zebra" });
    joinProject("u1", "aaa", "kz");
    joinProject("u1", q.DEFAULT_PROJECT, "kd");
    const viewer = q.getViewer(env.db, "u1");
    expect(viewer?.username).toBe("alice");
    expect(viewer?.memberships.map((m) => [m.project, m.project_name, m.install_key])).toEqual([
      ["default", "Default", "kd"],
      ["aaa", "Zebra", "kz"],
    ]);
    expect(q.getViewer(env.db, "nobody")).toBeNull();
    expect(q.listProjects(env.db).map((p) => p.slug)).toEqual(["default", "aaa"]);
  });

  it("makes the first admin a member of the default project, once", () => {
    const first = { id: "u1", username: "root", passwordHash: "h", installKey: "k1" };
    expect(q.createFirstAdmin(env.db, first)).toBe(true);
    expect(q.createFirstAdmin(env.db, { ...first, id: "u2", username: "late", installKey: "k2" })).toBe(false);
    expect(membership("u1")).toMatchObject({ role: "member", install_key: "k1" });
    expect(membership("u2")).toBeNull();
  });

  it("signs the CLI out with every password change and key rotation, even for a user in no project", () => {
    seedU1();
    const signIn = (id: string) =>
      env.db
        .prepare(
          "INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at, last_used_at) VALUES (?, 'active', 'u1', 'x', 5, 0, 0, 0)",
        )
        .run(id);
    const signedIn = () => env.db.prepare("SELECT id FROM cli_logins").all();
    signIn("l1");
    expect(q.rotateInstallKeys(env.db, "u1", () => "x")).toBeUndefined();
    expect(signedIn()).toEqual([]);
    signIn("l2");
    q.updatePassword(env.db, "u1", "h2");
    expect(signedIn()).toEqual([]);
    expect(q.getUserById(env.db, "u1")?.password_hash).toBe("h2");
  });

  it("summarises the projects each account is in and the skills it owns", () => {
    seedU1();
    q.createUser(env.db, { id: "u2", username: "bob", passwordHash: "h", role: "member" });
    q.createProject(env.db, { slug: "team-b", name: "Team B" });
    joinProject("u1", q.DEFAULT_PROJECT, "k1");
    joinProject("u1", "team-b", "k2");
    insert(base);
    insert({ ...base, skillId: "s2", slug: "other", name: "other" });
    insert({ ...base, authorId: "u2" });
    const signIn = env.db.prepare(
      "INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at, last_used_at) VALUES (?, 'active', 'u1', 'x', 5, 0, 0, ?)",
    );
    signIn.run("l1", 100);
    signIn.run("l2", 50);
    expect(q.listUserSummaries(env.db, 50).map((u) => [u.username, u.projects, u.skills, u.cli_logins])).toEqual([
      ["alice", 2, 2, 1],
      ["bob", 0, 0, 0],
    ]);
    expect(q.getUserSummary(env.db, "u1", 50)).toMatchObject({ username: "alice", cli_logins: 1 });
    expect(q.getUserSummary(env.db, "u1", 0)).not.toHaveProperty("password_hash");
  });
});

describe("skills", () => {
  beforeEach(async () => {
    await resetDb();
    seedU1();
    q.createProject(env.db, { slug: "team-b", name: "Team B" });
  });

  it("allocates version numbers per skill and stores each archive under the skill's id and its digest", () => {
    expect(q.objectKeyFor("s1", digest("b"))).toBe(keyFor("s1", "b"));
    expect(insert(base)).toBe(1);
    expect(insert({ ...base, digest: digest("b") })).toBe(2);
    expect(q.getVersion(env.db, "default", "demo", 1)?.object_key).toBe(keyFor("s1", "a"));
    expect(q.getVersion(env.db, "default", "demo", 2)?.object_key).toBe(keyFor("s1", "b"));
    const skill = q.getSkill(env.db, "default", "demo");
    expect(skill).toMatchObject({ id: "s1", project: "default", slug: "demo", latest_version: 2 });
    expect(q.listVersions(env.db, "default", "demo")).toHaveLength(2);
  });

  it("keeps a name in the narrowed root index while its other copies are private", () => {
    insert(base);
    insert({ ...base, skillId: "s2", project: "team-b", visibility: "public" });
    expect(q.listPublishedForIndex(env.db, { kind: "root" }, "demo").map((s) => s.slug)).toEqual(["demo"]);
  });

  it("finds an artifact by digest only in its own project", () => {
    insert(base);
    insert({ ...base, skillId: "s2", project: "team-b", digest: digest("b"), visibility: "public" });
    expect(q.getArtifactByDigest(env.db, "team-b", "demo", digest("b"))?.object_key).toBe(keyFor("s2", "b"));
    expect(q.getArtifactByDigest(env.db, "default", "demo", digest("b"))).toBeNull();
  });

  it("returns the object keys when deleting a skill and leaves the same name in another project alone", () => {
    insert(base);
    insert({ ...base, skillId: "s2", project: "team-b" });
    expect(q.deleteSkill(env.db, "default", "demo")).toEqual([keyFor("s1", "a")]);
    expect(q.getSkill(env.db, "default", "demo")).toBeNull();
    expect(q.getVersion(env.db, "team-b", "demo", 1)).not.toBeNull();
  });
});
