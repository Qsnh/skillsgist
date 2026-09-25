import { describe, expect, it } from "vitest";
import {
  canManage, canManageProject, canPublishTo, canView, hashPassword, PBKDF2_ITERATIONS, randomHex, skillScope,
  verifyPassword,
} from "../src/auth";
import { sha256Hex } from "../src/hash";
import type { Membership, SkillRow, Viewer } from "../src/db/queries";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  id: "u1", username: "alice", password_hash: "h", role: "member",
  api_token_hash: null, created_at: 0, last_login_at: null, memberships: [], ...over,
});

const member = (project: string, role: "admin" | "member" = "member"): Membership => ({
  project, project_name: project, user_id: "u1", role, install_key: "k", created_at: 0,
});

const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  id: "s1", project: "default", slug: "demo", description: "d", visibility: "private", owner_id: "u1",
  latest_version: 1, download_count: 0, created_at: 0, updated_at: 0, ...over,
});

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong password xx", stored)).toBe(false);
  });

  it("encodes scheme, iterations, salt and hash", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts).toHaveLength(4);
  });

  it("uses a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
  });

  it("verifies hashes stored with a different iteration count", async () => {
    const stored = await hashPassword("correct horse battery", 1000);
    expect(stored).toContain("$1000$");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
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

describe("canView", () => {
  it("shows a public skill to everyone, in its project or not", () => {
    expect(canView(null, skill({ visibility: "public" }))).toBe(true);
    expect(canView(viewer({ memberships: [member("other")] }), skill({ visibility: "public" }))).toBe(true);
  });

  it("shows a private skill to its project's members only", () => {
    expect(canView(null, skill())).toBe(false);
    expect(canView(viewer({ memberships: [member("default")] }), skill())).toBe(true);
    expect(canView(viewer({ memberships: [member("other")] }), skill())).toBe(false);
    expect(canView(viewer(), skill())).toBe(false);
  });

  it("shows an instance admin every private skill", () => {
    expect(canView(viewer({ role: "admin" }), skill())).toBe(true);
  });

  it("does not mistake an inherited property name for a membership", () => {
    expect(canView(viewer(), skill({ project: "constructor" }))).toBe(false);
  });
});

describe("canManage", () => {
  it("lets an owner manage their skill while they are in its project", () => {
    expect(canManage(viewer({ memberships: [member("default")] }), skill())).toBe(true);
  });

  it("stops an owner who is no longer in the project", () => {
    expect(canManage(viewer(), skill())).toBe(false);
  });

  it("stops a project member managing someone else's skill", () => {
    expect(canManage(viewer({ id: "u2", memberships: [member("default")] }), skill())).toBe(false);
  });

  it("lets a project admin manage every skill in that project and no other", () => {
    const lead = viewer({ id: "u2", memberships: [member("default", "admin")] });
    expect(canManage(lead, skill())).toBe(true);
    expect(canManage(lead, skill({ project: "other" }))).toBe(false);
  });

  it("lets an instance admin manage anything", () => {
    expect(canManage(viewer({ id: "u2", role: "admin" }), skill({ project: "other" }))).toBe(true);
  });
});

describe("canManageProject and canPublishTo", () => {
  it("lets project admins and instance admins manage a project", () => {
    expect(canManageProject(viewer({ memberships: [member("default", "admin")] }), "default")).toBe(true);
    expect(canManageProject(viewer({ memberships: [member("default")] }), "default")).toBe(false);
    expect(canManageProject(viewer({ role: "admin" }), "default")).toBe(true);
  });

  it("lets every member, and instance admins, publish to a project", () => {
    expect(canPublishTo(viewer({ memberships: [member("default")] }), "default")).toBe(true);
    expect(canPublishTo(viewer({ memberships: [member("default")] }), "other")).toBe(false);
    expect(canPublishTo(viewer({ role: "admin" }), "other")).toBe(true);
  });
});

describe("skillScope", () => {
  it("maps each kind of viewer to the rows it may list", () => {
    expect(skillScope(null)).toEqual({ kind: "public" });
    expect(skillScope(viewer({ role: "admin" }))).toEqual({ kind: "all" });
    expect(skillScope(viewer())).toEqual({ kind: "member", userId: "u1" });
  });
});
