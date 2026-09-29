import { describe, expect, it } from "vitest";
import {
  canAccessProject, canManage, canManageProject, canPublishIn, canView, hashPassword, PBKDF2_ITERATIONS, randomHex,
  skillScope, verifyPassword,
} from "../src/auth";
import { sha256Hex } from "../src/hash";
import type { Membership, SkillRow, Viewer } from "../src/db/queries";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  id: "u1", username: "alice", password_hash: "h", role: "member",
  api_token_hash: null, created_at: 0, last_login_at: null, memberships: [], ...over,
});

const member = (project: string, role: "admin" | "member" = "member", can_publish = 1): Membership => ({
  project, project_name: project, user_id: "u1", role, install_key: "k", created_at: 0, can_publish,
});

const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  id: "s1", project: "default", slug: "demo", description: "d", visibility: "private", owner_id: "u1",
  latest_version: 1, download_count: 0, created_at: 0, updated_at: 0, ...over,
});

describe("password hashing", () => {
  it("round-trips a password, at the stored iteration count", async () => {
    for (const stored of [await hashPassword("correct horse battery"), await hashPassword("correct horse battery", 1000)]) {
      expect(await verifyPassword("correct horse battery", stored)).toBe(true);
      expect(await verifyPassword("wrong password xx", stored)).toBe(false);
    }
  });

  it("encodes scheme, iterations, salt and hash, with a fresh salt each time", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts).toHaveLength(4);
    expect(await hashPassword("correct horse battery")).not.toBe(stored);
    expect(await hashPassword("correct horse battery", 1000)).toContain("$1000$");
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("randomHex", () => {
  it("returns the requested number of bytes as hex", () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

const inDefault = viewer({ memberships: [member("default")] });
const inOther = viewer({ memberships: [member("other")] });
const instanceAdmin = viewer({ id: "u2", role: "admin" });

describe("canView", () => {
  it.each<[string, Viewer | null, Partial<SkillRow>, boolean]>([
    ["a public skill to an anonymous visitor", null, { visibility: "public" }, true],
    ["a public skill to another project's member", inOther, { visibility: "public" }, true],
    ["a private skill to an anonymous visitor", null, {}, false],
    ["a private skill to its project's member", inDefault, {}, true],
    ["a private skill to another project's member", inOther, {}, false],
    ["a private skill to a user in no project", viewer(), {}, false],
    ["a private skill to an instance admin", instanceAdmin, {}, true],
    ["a skill whose project is an inherited property name", viewer(), { project: "constructor" }, false],
  ])("shows %s", (_label, who, over, expected) => {
    expect(canView(who, skill(over))).toBe(expected);
  });
});

describe("canManage", () => {
  const lead = viewer({ id: "u2", memberships: [member("default", "admin")] });
  it.each<[string, Viewer, Partial<SkillRow>, boolean]>([
    ["an owner, while they are in its project", inDefault, {}, true],
    ["an owner no longer in the project", viewer(), {}, false],
    ["an owner whose publishing in its project is blocked", viewer({ memberships: [member("default", "member", 0)] }), {}, false],
    ["a project member, on someone else's skill", viewer({ id: "u2", memberships: [member("default")] }), {}, false],
    ["a project admin, on a skill in that project", lead, {}, true],
    ["a project admin, on a skill in another project", lead, { project: "other" }, false],
    ["an instance admin, on anything", instanceAdmin, { project: "other" }, true],
  ])("answers %s", (_label, who, over, expected) => {
    expect(canManage(who, skill(over))).toBe(expected);
  });
});

describe("canManageProject and canAccessProject", () => {
  it("lets project admins and instance admins manage a project", () => {
    expect(canManageProject(viewer({ memberships: [member("default", "admin")] }), "default")).toBe(true);
    expect(canManageProject(viewer({ memberships: [member("default")] }), "default")).toBe(false);
    expect(canManageProject(viewer({ role: "admin" }), "default")).toBe(true);
  });

  it("lets every member, and instance admins, into a project", () => {
    expect(canAccessProject(viewer({ memberships: [member("default")] }), "default")).toBe(true);
    expect(canAccessProject(viewer({ memberships: [member("default")] }), "other")).toBe(false);
    expect(canAccessProject(viewer({ role: "admin" }), "other")).toBe(true);
  });
});

describe("canPublishIn", () => {
  it.each<[string, Viewer, boolean]>([
    ["a member whose publishing is allowed", inDefault, true],
    ["a member whose publishing is blocked", viewer({ memberships: [member("default", "member", 0)] }), false],
    ["a project admin, whatever their switch says", viewer({ memberships: [member("default", "admin", 0)] }), true],
    ["an instance admin whose own membership is blocked", viewer({ role: "admin", memberships: [member("default", "member", 0)] }), true],
    ["a member of another project only", inOther, false],
  ])("answers %s", (_label, who, expected) => {
    expect(canPublishIn(who, "default")).toBe(expected);
  });
});

describe("skillScope", () => {
  it("maps each kind of viewer to the rows it may list", () => {
    expect(skillScope(null)).toEqual({ kind: "public" });
    expect(skillScope(viewer({ role: "admin" }))).toEqual({ kind: "all" });
    expect(skillScope(viewer())).toEqual({ kind: "member", userId: "u1" });
  });
});
