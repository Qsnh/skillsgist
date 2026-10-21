import { beforeEach, describe, expect, it } from "vitest";
import { LOGIN_IDLE_MS, newDeviceCode, newDeviceToken, newUserCode, normalizeUserCode } from "../src/credentials";
import * as logins from "../src/db/logins";
import { deleteMembership, deleteProject, deleteUserReassigning } from "../src/db/queries";
import { sha256Hex } from "../src/hash";
import { env, joinProject, resetDb, seedProject, seedUser } from "./helpers";

const NOW = 1_800_000_000_000;

function pending(overrides: Partial<{ id: string; userCode: string; now: number; requestedScope: string | null }> = {}) {
  const input = {
    id: overrides.id ?? "l1",
    userCode: overrides.userCode ?? "BCDF-GHJK",
    deviceCodeHash: sha256Hex(newDeviceCode()),
    deviceName: "laptop",
    country: "NL",
    requestedScope: overrides.requestedScope ?? null,
    now: overrides.now ?? NOW,
  };
  expect(logins.createPendingLogin(env.db, input)).toBe(true);
  return input;
}

const row = (id: string) =>
  (env.db.prepare("SELECT * FROM cli_logins WHERE id = ?").get(id) as logins.CliLoginRow | undefined) ?? null;
const grants = (id: string) =>
  env.db.prepare("SELECT project FROM cli_login_projects WHERE login_id = ? ORDER BY project").pluck().all(id) as string[];

describe("codes and tokens", () => {
  it("makes user codes from 20 consonants as XXXX-XXXX and normalizes what people type", () => {
    for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" BCDFGHJK ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF-GHJA")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
  });

  it("prefixes device tokens and makes 32-byte codes", () => {
    expect(newDeviceToken()).toMatch(/^sgd_[a-f0-9]{64}$/);
    expect(newDeviceCode()).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("pending logins", () => {
  beforeEach(resetDb);

  it("finds a login by user code, and refuses a second one with the same code", () => {
    pending();
    expect(logins.getLoginByUserCode(env.db, "BCDF-GHJK")).toMatchObject({ id: "l1", status: "pending", expires_at: NOW + 600_000 });
    expect(logins.getLoginByUserCode(env.db, "CDFG-HJKL")).toBeNull();
    expect(
      logins.createPendingLogin(env.db, {
        id: "l2", userCode: "BCDF-GHJK", deviceCodeHash: "x", deviceName: "", country: null, requestedScope: null, now: NOW,
      }),
    ).toBe(false);
  });

  it("deletes expired requests that never became active and sign-ins unused for 90 days, and keeps the rest", async () => {
    const { user } = await seedUser({ username: "alice" });
    pending({ id: "old" });
    for (const [id, userCode, usedAt] of [["live", "CDFG-HJKL", NOW], ["idle", "DFGH-JKLM", NOW - LOGIN_IDLE_MS]] as const) {
      pending({ id, userCode });
      logins.approveLogin(env.db, id, user.id, ["default"], NOW);
      logins.activateLogin(env.db, id, `token-${id}`, usedAt);
    }
    expect(logins.deleteStaleLogins(env.db, NOW + 600_001)).toBe(2);
    expect(row("old")).toBeNull();
    expect(row("idle")).toBeNull();
    expect(grants("idle")).toEqual([]);
    expect(row("live")?.status).toBe("active");
    expect(grants("live")).toEqual(["default"]);
  });
});

describe("approving and claiming", () => {
  beforeEach(async () => {
    await resetDb();
    await seedProject("team-b", "Team B");
    await seedProject("team-c", "Team C");
  });

  it("grants only the approver's own projects, once, and keeps the user code but clears the scope", async () => {
    const { user } = await seedUser({ username: "alice" });
    await joinProject(user.id, "team-b");
    pending({ requestedScope: "default team-c" });
    expect(logins.approveLogin(env.db, "l1", user.id, ["default", "team-b", "team-c", "team-b"], NOW)).toBe(true);
    expect(grants("l1")).toEqual(["default", "team-b"]);
    expect(row("l1")).toMatchObject({ status: "approved", user_id: user.id, user_code: "BCDF-GHJK", requested_scope: null, approved_at: NOW });
    expect(logins.approveLogin(env.db, "l1", user.id, ["team-c"], NOW)).toBe(false);
    expect(grants("l1")).toEqual(["default", "team-b"]);
  });

  it("refuses to approve an expired or denied request", async () => {
    const { user } = await seedUser({ username: "alice" });
    pending();
    expect(logins.approveLogin(env.db, "l1", user.id, ["default"], NOW + 600_000)).toBe(false);
    pending({ id: "l2", userCode: "CDFG-HJKL" });
    expect(logins.denyLogin(env.db, "l2", user.id, NOW)).toBe(true);
    expect(logins.approveLogin(env.db, "l2", user.id, ["default"], NOW)).toBe(false);
    expect(row("l2")).toMatchObject({ status: "denied", user_id: user.id });
    expect(grants("l2")).toEqual([]);
  });

  it("approves nothing when the approver is in none of the chosen projects", async () => {
    const { user } = await seedUser({ username: "alice" });
    pending();
    expect(logins.approveLogin(env.db, "l1", user.id, ["team-b", "team-c"], NOW)).toBe(false);
    expect(logins.approveLogin(env.db, "l1", user.id, [], NOW)).toBe(false);
    expect(row("l1")).toMatchObject({ status: "pending", user_id: null, approved_at: null });
    expect(grants("l1")).toEqual([]);
  });

  it("hands the token out once and forgets the device code and the user code", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { deviceCodeHash } = pending();
    logins.approveLogin(env.db, "l1", user.id, ["default"], NOW);
    expect(logins.getLoginByDeviceCodeHash(env.db, deviceCodeHash)?.status).toBe("approved");
    expect(logins.activateLogin(env.db, "l1", "token-hash", NOW + 5)).toBe(true);
    expect(logins.activateLogin(env.db, "l1", "other-hash", NOW + 6)).toBe(false);
    expect(logins.getLoginByDeviceCodeHash(env.db, deviceCodeHash)).toBeNull();
    expect(row("l1")).toMatchObject({ status: "active", token_hash: "token-hash", user_code: null, device_code_hash: null, last_used_at: NOW + 5 });
    expect(logins.getLoginByUserCode(env.db, "BCDF-GHJK")).toBeNull();
    expect(logins.loginProjects(env.db, "l1")).toEqual(["default"]);
  });

  it("refuses to activate an expired device sign-in", async () => {
    const { user } = await seedUser({ username: "alice" });
    pending();
    logins.approveLogin(env.db, "l1", user.id, ["default"], NOW);
    expect(logins.activateLogin(env.db, "l1", "token-hash", NOW + 600_000)).toBe(false);
    expect(row("l1")?.status).toBe("approved");
  });
});

describe("access and cleanup", () => {
  beforeEach(async () => {
    await resetDb();
    await seedProject("team-b", "Team B");
  });

  function active(userId: string, projects: string[]) {
    pending();
    logins.approveLogin(env.db, "l1", userId, projects, NOW);
    logins.activateLogin(env.db, "l1", "token-hash", NOW);
  }

  it("reports the sign-in's user and the granted projects the user is still in", async () => {
    const { user } = await seedUser({ username: "alice" });
    await joinProject(user.id, "team-b");
    active(user.id, ["team-b", "default"]);
    expect(logins.loginAccessByTokenHash(env.db, "token-hash")).toEqual({
      id: "l1", user_id: user.id, username: "alice", device_name: "laptop", last_used_at: NOW, granted: ["default", "team-b"],
    });
    expect(logins.loginAccessByTokenHash(env.db, "nope")).toBeNull();
  });

  it("drops a project's grants when the member leaves it, so rejoining does not revive them", async () => {
    const { user } = await seedUser({ username: "alice" });
    await joinProject(user.id, "team-b");
    active(user.id, ["default", "team-b"]);
    deleteMembership(env.db, "team-b", user.id);
    await joinProject(user.id, "team-b");
    expect(logins.loginAccessByTokenHash(env.db, "token-hash")?.granted).toEqual(["default"]);
  });

  it("drops grants with their project, and sign-ins with their user", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { user: root } = await seedUser({ username: "root", project: null });
    await joinProject(user.id, "team-b");
    active(user.id, ["default", "team-b"]);
    deleteMembership(env.db, "team-b", user.id);
    expect(deleteProject(env.db, "team-b")).toBe(true);
    expect(grants("l1")).toEqual(["default"]);
    logins.claimCodeAttempt(env.db, user.id, NOW);
    deleteUserReassigning(env.db, user.id, root.id);
    expect(row("l1")).toBeNull();
    expect(grants("l1")).toEqual([]);
    expect(env.db.prepare("SELECT * FROM device_code_attempts").all()).toEqual([]);
  });

  it("lists a user's active sign-ins with the names of their usable projects, newest first", async () => {
    const { user } = await seedUser({ username: "alice" });
    active(user.id, ["default"]);
    pending({ id: "l2", userCode: "CDFG-HJKL" });
    logins.approveLogin(env.db, "l2", user.id, ["default"], NOW + 1);
    logins.activateLogin(env.db, "l2", "token-2", NOW + 1);
    deleteMembership(env.db, "default", user.id);
    await joinProject(user.id, "default");
    expect(logins.listUserLogins(env.db, user.id)).toEqual([
      { id: "l2", device_name: "laptop", request_country: "NL", approved_at: NOW + 1, last_used_at: NOW + 1, projects: [] },
      { id: "l1", device_name: "laptop", request_country: "NL", approved_at: NOW, last_used_at: NOW, projects: [] },
    ]);
  });

  it("deletes one of a user's sign-ins only for that user", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { user: bob } = await seedUser({ username: "bob" });
    active(user.id, ["default"]);
    expect(logins.deleteUserLogin(env.db, bob.id, "l1")).toBeNull();
    expect(logins.deleteUserLogin(env.db, user.id, "l1")).toEqual({ device_name: "laptop", last_used_at: NOW });
    expect(row("l1")).toBeNull();
    expect(grants("l1")).toEqual([]);
  });
});

describe("wrong-code lockout", () => {
  beforeEach(resetDb);

  it("allows five attempts within ten minutes, and allows more when the window ends", async () => {
    const { user } = await seedUser({ username: "alice" });
    for (let i = 0; i < 5; i++) expect(logins.claimCodeAttempt(env.db, user.id, NOW + i)).toBe(true);
    expect(logins.claimCodeAttempt(env.db, user.id, NOW + 10)).toBe(false);
    expect(logins.claimCodeAttempt(env.db, user.id, NOW + 599_999)).toBe(false);
    expect(logins.claimCodeAttempt(env.db, user.id, NOW + 600_000)).toBe(true);
    for (let i = 1; i < 5; i++) expect(logins.claimCodeAttempt(env.db, user.id, NOW + 600_000 + i)).toBe(true);
    expect(logins.claimCodeAttempt(env.db, user.id, NOW + 600_010)).toBe(false);
  });

  it("gives an attempt back, so right codes never use one up", async () => {
    const { user } = await seedUser({ username: "alice" });
    for (let i = 0; i < 20; i++) {
      expect(logins.claimCodeAttempt(env.db, user.id, NOW + i)).toBe(true);
      logins.refundCodeAttempt(env.db, user.id);
    }
    for (let i = 0; i < 5; i++) expect(logins.claimCodeAttempt(env.db, user.id, NOW + 100 + i)).toBe(true);
    expect(logins.claimCodeAttempt(env.db, user.id, NOW + 200)).toBe(false);
  });

  it("lets only five of many simultaneous attempts through", async () => {
    const { user } = await seedUser({ username: "alice" });
    const claims = Array.from({ length: 30 }, () => logins.claimCodeAttempt(env.db, user.id, NOW));
    expect(claims.filter(Boolean)).toHaveLength(5);
  });
});
