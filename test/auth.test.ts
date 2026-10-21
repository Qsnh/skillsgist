import { beforeEach, describe, expect, it } from "vitest";
import {
  canAccessProject, canManage, canManageProject, canPublishIn, canView, hashPassword, randomHex, SESSION_COOKIE,
  skillScope, verifyPassword,
} from "../src/auth";
import { sha256Hex } from "../src/hash";
import { en } from "../src/i18n/en";
import { RateLimiter } from "../src/rate-limit";
import type { Membership, SkillRow, Viewer } from "../src/db/queries";
import { appFetch, env, ORIGIN, resetDb, seedUser, setCookieLine } from "./helpers";

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
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong password xx", stored)).toBe(false);
  });

  it("encodes Argon2id with its parameters, salt and hash, with a fresh salt each time", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await hashPassword("correct horse battery")).not.toBe(stored);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    const stored = await hashPassword("x");
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", stored.slice(0, stored.lastIndexOf("$")))).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$100000$c2FsdA$aGFzaA")).toBe(false);
  });
});

describe("signing in", () => {
  beforeEach(resetDb);

  const signIn = (password: string, clientIp: string) =>
    appFetch(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams({ username: "alice", password }),
      redirect: "manual",
      clientIp,
    });

  it("counts only failed attempts, so people who sign in often are never refused", async () => {
    const { password } = await seedUser({ username: "alice" });
    env.limiters = { ...env.limiters, signIn: new RateLimiter(10, 60_000) };
    for (let i = 0; i < 12; i++) expect((await signIn(password, "203.0.113.7")).status).toBe(302);
  });

  it("refuses an eleventh failure from one IP address within a minute, even with the right password", async () => {
    const { password } = await seedUser({ username: "alice" });
    env.limiters = { ...env.limiters, signIn: new RateLimiter(10, 60_000) };
    for (let i = 0; i < 10; i++) expect((await signIn("wrong password xx", "203.0.113.7")).status).toBe(401);

    const res = await signIn(password, "203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    expect(setCookieLine(res, SESSION_COOKIE)).toBeUndefined();
    const html = await res.text();
    expect(html).toContain(en.auth.tooManySignIns);
    expect(html).toContain('action="/login"');

    const elsewhere = await signIn(password, "198.51.100.9");
    expect(elsewhere.status).toBe(302);
    expect(setCookieLine(elsewhere, SESSION_COOKIE)).toBeDefined();
  });

  it("counts an IPv6 visitor's whole /64 as one address", async () => {
    await seedUser({ username: "alice" });
    env.limiters = { ...env.limiters, signIn: new RateLimiter(2, 60_000) };
    expect((await signIn("wrong password xx", "2001:db8:1:2::1")).status).toBe(401);
    expect((await signIn("wrong password xx", "2001:db8:1:2::2")).status).toBe(401);
    expect((await signIn("wrong password xx", "2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await signIn("wrong password xx", "2001:db8:1:3::1")).status).toBe(401);
  });
});

describe("randomHex", () => {
  it("returns the requested number of bytes as hex", () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", () => {
    expect(sha256Hex("")).toBe(
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
