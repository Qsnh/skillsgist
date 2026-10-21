import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { MAINTENANCE_MINUTE, msUntilNextRun, retentionCutoff, runMaintenance } from "../src/maintenance";
import { DAY_MS, HOUR_MS } from "../src/time";
import { env, GOOD_MD, resetDb, seedLog, seedLogs, seedUser, seedWithSkills, signInDevice, testConfig } from "./helpers";

const NOW = Date.UTC(2026, 9, 13, 3, 17);

const kept = () =>
  (env.db.prepare("SELECT created_at FROM download_logs ORDER BY created_at").all() as Array<{ created_at: number }>).map(
    (r) => (NOW - r.created_at) / DAY_MS,
  );

let skillId = "";

describe("the hourly maintenance", () => {
  beforeEach(async () => {
    await resetDb();
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    skillId = getSkill(env.db, "default", "demo-skill")!.id;
  });

  it("deletes downloads older than 90 days by default, and keeps the download count", async () => {
    seedLog(skillId, { at: NOW - 91 * DAY_MS });
    seedLog(skillId, { at: NOW - 89 * DAY_MS });
    expect((await runMaintenance(env, NOW)).prunedLogs).toBe(1);
    expect(kept()).toEqual([89]);
    expect(getSkill(env.db, "default", "demo-skill")?.download_count).toBe(2);
  });

  it("uses the configured retention", async () => {
    seedLog(skillId, { at: NOW - 8 * DAY_MS });
    seedLog(skillId, { at: NOW - 6 * DAY_MS });
    await runMaintenance({ db: env.db, config: testConfig({ retentionDays: 7 }) }, NOW);
    expect(kept()).toEqual([6]);
  });

  it("works through a backlog larger than one batch", async () => {
    seedLogs(skillId, 6000, NOW - 120 * DAY_MS);
    seedLog(skillId, { at: NOW - DAY_MS });
    expect((await runMaintenance(env, NOW)).prunedLogs).toBe(6000);
    expect(kept()).toEqual([1]);
  });

  it("deletes expired sign-in requests and CLI sign-ins unused for 90 days", async () => {
    const { user } = await seedUser({ username: "bob" });
    const fresh = await signInDevice(user.id, ["default"], NOW - DAY_MS);
    await signInDevice(user.id, ["default"], NOW - 91 * DAY_MS);
    env.db
      .prepare(
        "INSERT INTO cli_logins (id, status, device_name, poll_interval, created_at, expires_at) VALUES ('stale', 'pending', 'x', 5, ?, ?)",
      )
      .run(NOW - HOUR_MS, NOW - 1);
    expect((await runMaintenance(env, NOW)).staleLogins).toBe(2);
    expect(env.db.prepare("SELECT id FROM cli_logins").pluck().all()).toEqual([fresh.id]);
  });

  it("puts the cutoff that many whole days before now", () => {
    expect(retentionCutoff(7, 10 * DAY_MS)).toBe(3 * DAY_MS);
  });

  it("runs at the same minute of every hour", () => {
    const top = Date.UTC(2026, 9, 13, 3, 0);
    expect(msUntilNextRun(top)).toBe(MAINTENANCE_MINUTE * 60_000);
    expect(msUntilNextRun(top + MAINTENANCE_MINUTE * 60_000)).toBe(HOUR_MS);
    expect(msUntilNextRun(top + (MAINTENANCE_MINUTE + 1) * 60_000)).toBe(HOUR_MS - 60_000);
  });
});
