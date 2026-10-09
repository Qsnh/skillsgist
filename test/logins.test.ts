import { beforeEach, describe, expect, it } from "vitest";
import { LOGIN_IDLE_MS, newDeviceCode, newDeviceToken, newUserCode, normalizeUserCode } from "../src/credentials";
import * as logins from "../src/db/logins";
import { deleteMembership, deleteProject, deleteUserReassigning } from "../src/db/queries";
import { sha256Hex } from "../src/hash";
import { env, joinProject, resetDb, seedProject, seedUser } from "./helpers";

const NOW = 1_800_000_000_000;

async function pending(overrides: Partial<{ id: string; userCode: string; now: number; requestedScope: string | null }> = {}) {
  const input = {
    id: overrides.id ?? "l1",
    userCode: overrides.userCode ?? "BCDF-GHJK",
    deviceCodeHash: await sha256Hex(newDeviceCode()),
    deviceName: "laptop",
    country: "NL",
    requestedScope: overrides.requestedScope ?? null,
    now: overrides.now ?? NOW,
  };
  expect(await logins.createPendingLogin(env.DB, input)).toBe(true);
  return input;
}

const row = (id: string) => env.DB.prepare("SELECT * FROM cli_logins WHERE id = ?").bind(id).first<logins.CliLoginRow>();
const grants = async (id: string) =>
  (await env.DB.prepare("SELECT project FROM cli_login_projects WHERE login_id = ? ORDER BY project").bind(id).all<{ project: string }>())
    .results.map((r) => r.project);

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

  it("finds a login by user code, and refuses a second one with the same code", async () => {
    await pending();
    expect(await logins.getLoginByUserCode(env.DB, "BCDF-GHJK")).toMatchObject({ id: "l1", status: "pending", expires_at: NOW + 600_000 });
    expect(await logins.getLoginByUserCode(env.DB, "CDFG-HJKL")).toBeNull();
    expect(
      await logins.createPendingLogin(env.DB, {
        id: "l2", userCode: "BCDF-GHJK", deviceCodeHash: "x", deviceName: "", country: null, requestedScope: null, now: NOW,
      }),
    ).toBe(false);
  });

  it("deletes expired requests that never became active and sign-ins unused for 90 days, and keeps the rest", async () => {
    const { user } = await seedUser({ username: "alice" });
    await pending({ id: "old" });
    for (const [id, userCode, usedAt] of [["live", "CDFG-HJKL", NOW], ["idle", "DFGH-JKLM", NOW - LOGIN_IDLE_MS]] as const) {
      await pending({ id, userCode });
      await logins.approveLogin(env.DB, id, user.id, ["default"], NOW);
      await logins.activateLogin(env.DB, id, `token-${id}`, usedAt);
    }
    await logins.deleteStaleLogins(env.DB, NOW + 600_001);
    expect(await row("old")).toBeNull();
    expect(await row("idle")).toBeNull();
    expect(await grants("idle")).toEqual([]);
    expect((await row("live"))?.status).toBe("active");
    expect(await grants("live")).toEqual(["default"]);
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
    await pending({ requestedScope: "default team-c" });
    expect(await logins.approveLogin(env.DB, "l1", user.id, ["default", "team-b", "team-c", "team-b"], NOW)).toBe(true);
    expect(await grants("l1")).toEqual(["default", "team-b"]);
    expect(await row("l1")).toMatchObject({ status: "approved", user_id: user.id, user_code: "BCDF-GHJK", requested_scope: null, approved_at: NOW });
    expect(await logins.approveLogin(env.DB, "l1", user.id, ["team-c"], NOW)).toBe(false);
    expect(await grants("l1")).toEqual(["default", "team-b"]);
  });

  it("refuses to approve an expired or denied request", async () => {
    const { user } = await seedUser({ username: "alice" });
    await pending();
    expect(await logins.approveLogin(env.DB, "l1", user.id, ["default"], NOW + 600_000)).toBe(false);
    await pending({ id: "l2", userCode: "CDFG-HJKL" });
    expect(await logins.denyLogin(env.DB, "l2", user.id, NOW)).toBe(true);
    expect(await logins.approveLogin(env.DB, "l2", user.id, ["default"], NOW)).toBe(false);
    expect(await row("l2")).toMatchObject({ status: "denied", user_id: user.id });
    expect(await grants("l2")).toEqual([]);
  });

  it("approves nothing when the approver is in none of the chosen projects", async () => {
    const { user } = await seedUser({ username: "alice" });
    await pending();
    expect(await logins.approveLogin(env.DB, "l1", user.id, ["team-b", "team-c"], NOW)).toBe(false);
    expect(await logins.approveLogin(env.DB, "l1", user.id, [], NOW)).toBe(false);
    expect(await row("l1")).toMatchObject({ status: "pending", user_id: null, approved_at: null });
    expect(await grants("l1")).toEqual([]);
  });

  it("hands the token out once and forgets the device code and the user code", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { deviceCodeHash } = await pending();
    await logins.approveLogin(env.DB, "l1", user.id, ["default"], NOW);
    expect((await logins.getLoginByDeviceCodeHash(env.DB, deviceCodeHash))?.status).toBe("approved");
    expect(await logins.activateLogin(env.DB, "l1", "token-hash", NOW + 5)).toBe(true);
    expect(await logins.activateLogin(env.DB, "l1", "other-hash", NOW + 6)).toBe(false);
    expect(await logins.getLoginByDeviceCodeHash(env.DB, deviceCodeHash)).toBeNull();
    expect(await row("l1")).toMatchObject({ status: "active", token_hash: "token-hash", user_code: null, device_code_hash: null, last_used_at: NOW + 5 });
    expect(await logins.getLoginByUserCode(env.DB, "BCDF-GHJK")).toBeNull();
    expect(await logins.loginProjects(env.DB, "l1")).toEqual(["default"]);
  });

  it("refuses to activate an expired device sign-in", async () => {
    const { user } = await seedUser({ username: "alice" });
    await pending();
    await logins.approveLogin(env.DB, "l1", user.id, ["default"], NOW);
    expect(await logins.activateLogin(env.DB, "l1", "token-hash", NOW + 600_000)).toBe(false);
    expect((await row("l1"))?.status).toBe("approved");
  });
});

describe("access and cleanup", () => {
  beforeEach(async () => {
    await resetDb();
    await seedProject("team-b", "Team B");
  });

  async function active(userId: string, projects: string[]) {
    await pending();
    await logins.approveLogin(env.DB, "l1", userId, projects, NOW);
    await logins.activateLogin(env.DB, "l1", "token-hash", NOW);
  }

  it("reports the sign-in's user and the granted projects the user is still in", async () => {
    const { user } = await seedUser({ username: "alice" });
    await joinProject(user.id, "team-b");
    await active(user.id, ["team-b", "default"]);
    expect(await logins.loginAccessByTokenHash(env.DB, "token-hash")).toEqual({
      id: "l1", user_id: user.id, username: "alice", last_used_at: NOW, granted: ["default", "team-b"],
    });
    expect(await logins.loginAccessByTokenHash(env.DB, "nope")).toBeNull();
  });

  it("drops a project's grants when the member leaves it, so rejoining does not revive them", async () => {
    const { user } = await seedUser({ username: "alice" });
    await joinProject(user.id, "team-b");
    await active(user.id, ["default", "team-b"]);
    await deleteMembership(env.DB, "team-b", user.id);
    await joinProject(user.id, "team-b");
    expect((await logins.loginAccessByTokenHash(env.DB, "token-hash"))?.granted).toEqual(["default"]);
  });

  it("drops grants with their project, and sign-ins with their user", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { user: root } = await seedUser({ username: "root", project: null });
    await joinProject(user.id, "team-b");
    await active(user.id, ["default", "team-b"]);
    await deleteMembership(env.DB, "team-b", user.id);
    expect(await deleteProject(env.DB, "team-b")).toBe(true);
    expect(await grants("l1")).toEqual(["default"]);
    await logins.claimCodeAttempt(env.DB, user.id, NOW);
    await deleteUserReassigning(env.DB, user.id, root.id);
    expect(await row("l1")).toBeNull();
    expect(await grants("l1")).toEqual([]);
    expect(await env.DB.prepare("SELECT * FROM device_code_attempts").all().then((r) => r.results)).toEqual([]);
  });

  it("lists a user's active sign-ins with the names of their usable projects, newest first", async () => {
    const { user } = await seedUser({ username: "alice" });
    await active(user.id, ["default"]);
    await pending({ id: "l2", userCode: "CDFG-HJKL" });
    await logins.approveLogin(env.DB, "l2", user.id, ["default"], NOW + 1);
    await logins.activateLogin(env.DB, "l2", "token-2", NOW + 1);
    await deleteMembership(env.DB, "default", user.id);
    await joinProject(user.id, "default");
    expect(await logins.listUserLogins(env.DB, user.id)).toEqual([
      { id: "l2", device_name: "laptop", request_country: "NL", approved_at: NOW + 1, last_used_at: NOW + 1, projects: [] },
      { id: "l1", device_name: "laptop", request_country: "NL", approved_at: NOW, last_used_at: NOW, projects: [] },
    ]);
  });

  it("deletes one of a user's sign-ins only for that user", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { user: bob } = await seedUser({ username: "bob" });
    await active(user.id, ["default"]);
    expect(await logins.deleteUserLogin(env.DB, bob.id, "l1")).toBeNull();
    expect(await logins.deleteUserLogin(env.DB, user.id, "l1")).toEqual({ device_name: "laptop", last_used_at: NOW });
    expect(await row("l1")).toBeNull();
    expect(await grants("l1")).toEqual([]);
  });
});

describe("wrong-code lockout", () => {
  beforeEach(resetDb);

  it("allows five attempts within ten minutes, and allows more when the window ends", async () => {
    const { user } = await seedUser({ username: "alice" });
    for (let i = 0; i < 5; i++) expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + i)).toBe(true);
    expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 10)).toBe(false);
    expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 599_999)).toBe(false);
    expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 600_000)).toBe(true);
    for (let i = 1; i < 5; i++) expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 600_000 + i)).toBe(true);
    expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 600_010)).toBe(false);
  });

  it("gives an attempt back, so right codes never use one up", async () => {
    const { user } = await seedUser({ username: "alice" });
    for (let i = 0; i < 20; i++) {
      expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + i)).toBe(true);
      await logins.refundCodeAttempt(env.DB, user.id);
    }
    for (let i = 0; i < 5; i++) expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 100 + i)).toBe(true);
    expect(await logins.claimCodeAttempt(env.DB, user.id, NOW + 200)).toBe(false);
  });

  it("lets only five of many simultaneous attempts through", async () => {
    const { user } = await seedUser({ username: "alice" });
    const claims = await Promise.all(Array.from({ length: 30 }, () => logins.claimCodeAttempt(env.DB, user.id, NOW)));
    expect(claims.filter(Boolean)).toHaveLength(5);
  });
});
