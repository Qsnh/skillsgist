import { createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRUNE_BATCH, PRUNE_MAX_BATCHES, ROLLUP_BATCH, ROLLUP_MAX_BATCHES, rollupDownloads } from "../src/db/downloads";
import { deleteSkill, getSkill } from "../src/db/queries";
import worker from "../src/index";
import { DAY_MS } from "../src/time";
import { env, envWith, GOOD_MD, resetDb, seedLog, seedLogs, seedWithSkills } from "./helpers";

const NOW = Date.UTC(2026, 9, 13, 3, 17);

const runCron = (vars: Record<string, string> = {}) =>
  worker.scheduled(createScheduledController({ scheduledTime: new Date(NOW), cron: "17 * * * *" }), envWith(vars));

const kept = async () =>
  (await env.DB.prepare("SELECT created_at FROM download_logs ORDER BY created_at").all<{ created_at: number }>()).results.map(
    (r) => (NOW - r.created_at) / DAY_MS,
  );

let skillId = "";

describe("the hourly cleanup", () => {
  beforeEach(async () => {
    await resetDb();
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    skillId = (await getSkill(env.DB, "default", "demo-skill"))!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds new downloads to the download count and the daily counts", async () => {
    await seedLog(skillId, { at: NOW - DAY_MS });
    await seedLog(skillId, { at: NOW - 1 });
    await runCron();
    expect((await getSkill(env.DB, "default", "demo-skill"))?.download_count).toBe(2);
    expect(await env.DB.prepare("SELECT SUM(count) AS n FROM download_days").first("n")).toBe(2);
  });

  it("says when the roll-up stops at its limit and leaves the rest for the next run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedLogs(skillId, ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 1, NOW - DAY_MS);
    await runCron();
    expect(warn).toHaveBeenCalledOnce();
    expect((await getSkill(env.DB, "default", "demo-skill"))?.download_count).toBe(ROLLUP_BATCH * ROLLUP_MAX_BATCHES);
    await runCron();
    expect(warn).toHaveBeenCalledOnce();
    expect((await getSkill(env.DB, "default", "demo-skill"))?.download_count).toBe(ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 1);
  });

  it("still deletes expired downloads when the roll-up fails, and reports the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedLog(skillId, { at: NOW - 91 * DAY_MS });
    await rollupDownloads(env.DB);
    await seedLog(skillId, { at: NOW - 1 });
    await env.DB.prepare(
      "CREATE TRIGGER reject_count BEFORE UPDATE OF download_count ON skills BEGIN SELECT RAISE(ABORT, 'count rejected'); END",
    ).run();
    try {
      await expect(runCron()).rejects.toThrow(/count rejected/);
      expect(error).toHaveBeenCalledWith("download roll-up failed", expect.anything());
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_count").run();
    }
    expect(await kept()).toEqual([1 / DAY_MS]);
  });

  it("deletes downloads older than 90 days by default", async () => {
    await seedLog(skillId, { at: NOW - 91 * DAY_MS });
    await seedLog(skillId, { at: NOW - 89 * DAY_MS });
    await runCron();
    expect(await kept()).toEqual([89]);
  });

  it("uses DOWNLOAD_LOG_RETENTION_DAYS when it is a positive whole number", async () => {
    await seedLog(skillId, { at: NOW - 8 * DAY_MS });
    await seedLog(skillId, { at: NOW - 6 * DAY_MS });
    await runCron({ DOWNLOAD_LOG_RETENTION_DAYS: "7" });
    expect(await kept()).toEqual([6]);
  });

  it.each(["0", "-3", "abc", "1.5", ""])("falls back to 90 days for %j and says so", async (value) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedLog(skillId, { at: NOW - 91 * DAY_MS });
    await seedLog(skillId, { at: NOW - 89 * DAY_MS });
    await runCron({ DOWNLOAD_LOG_RETENTION_DAYS: value });
    expect(await kept()).toEqual([89]);
    expect(error).toHaveBeenCalled();
  });

  it("works through a backlog larger than one batch", async () => {
    await seedLogs(skillId, 2500, NOW - 120 * DAY_MS);
    await seedLog(skillId, { at: NOW - DAY_MS });
    await runCron();
    expect(await kept()).toEqual([1]);
  });

  it("deletes the downloads of a deleted skill", async () => {
    await seedLogs(skillId, 1500, NOW - DAY_MS);
    await deleteSkill(env.DB, "default", "demo-skill");
    await runCron();
    expect(await kept()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_purges").first("n")).toBe(0);
  });

  it("says when a run stops at its limit and leaves the rest for the next one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedLogs(skillId, PRUNE_BATCH * PRUNE_MAX_BATCHES + 1, NOW - 120 * DAY_MS);
    await runCron();
    expect(warn).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([120]);
    await runCron();
    expect(warn).toHaveBeenCalledOnce();
    expect(await kept()).toEqual([]);
  });

  it("reports a failed run instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedLog(skillId, { at: NOW - 91 * DAY_MS });
    await env.DB.prepare(
      "CREATE TRIGGER reject_prune BEFORE DELETE ON download_logs BEGIN SELECT RAISE(ABORT, 'prune rejected'); END",
    ).run();
    try {
      await expect(runCron()).rejects.toThrow(/prune rejected/);
      expect(error).toHaveBeenCalledWith("download log prune failed", expect.anything());
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_prune").run();
    }
  });
});
