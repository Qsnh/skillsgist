import { beforeEach, describe, expect, it } from "vitest";
import {
  ANONYMOUS_DOWNLOADER, downloadStats, filterNames, listDownloadLogs, NO_FILTER, PRUNE_BATCH, PRUNE_MAX_BATCHES,
  pruneDownloadLogs, recordDownload, ROLLUP_BATCH, ROLLUP_MAX_BATCHES, rollupDownloads,
} from "../src/db/downloads";
import type { DownloadFilter } from "../src/db/downloads";
import * as q from "../src/db/queries";
import { DAY_MS } from "../src/time";
import { env, resetDb, seedLog, seedLogs } from "./helpers";

const NOW = Date.UTC(2026, 9, 13, 12);
const TODAY = Math.floor(NOW / DAY_MS);

const skillVersion = (skillId: string, project: string, slug: string) => ({
  skillId,
  project,
  slug,
  digest: `sha256:${"a".repeat(64)}`,
  size: 1,
  name: slug,
  description: "d",
  skill_md: "x",
  html: "x",
  html_rev: 1,
  files: "[]",
  authorId: "u1",
  visibility: "private" as const,
});

const addSkill = (skillId: string, project: string, slug: string) => q.insertVersion(env.DB, skillVersion(skillId, project, slug));

async function seedSkills() {
  await q.createUser(env.DB, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });
  await q.createProject(env.DB, { slug: "team-b", name: "Team B" });
  await addSkill("s1", "default", "demo");
  await addSkill("s2", "default", "other");
  await addSkill("s3", "team-b", "demo");
}

const NOWHERE = { country: null, ip: null, userAgent: null };

const filter = (change: Partial<DownloadFilter> = {}): DownloadFilter => ({ ...NO_FILTER, ...change });

const list = (change: Partial<DownloadFilter>, opts: { since?: number; before?: number | null; limit?: number } = {}) =>
  listDownloadLogs(env.DB, filter(change), { since: opts.since ?? 0, before: opts.before ?? null, limit: opts.limit ?? 50 });

const skillsOf = async (change: Partial<DownloadFilter>) => (await list(change)).rows.map((r) => r.skill_id);

describe("recording a download", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
  });

  it("logs who made it in one write, and leaves the counts to the hourly roll-up", async () => {
    const before = await q.getSkill(env.DB, "default", "demo");
    await recordDownload(env.DB, {
      skillId: "s1",
      version: 1,
      downloader: { source: "device", userId: "u1", username: "alice", deviceName: "laptop" },
      country: "NL",
      ip: "203.0.113.7",
      userAgent: "node",
      at: NOW,
    });
    await recordDownload(env.DB, { skillId: "s1", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW + 1 });
    expect((await q.getSkill(env.DB, "default", "demo"))?.download_count).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_days").first("n")).toBe(0);
    await rollupDownloads(env.DB);
    const after = await q.getSkill(env.DB, "default", "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);
    const { results } = await env.DB.prepare(
      "SELECT skill_id, version, source, user_id, username, device_name, country, ip, user_agent, created_at FROM download_logs ORDER BY id",
    ).all();
    expect(results).toEqual([
      {
        skill_id: "s1", version: 1, source: "device", user_id: "u1", username: "alice", device_name: "laptop", country: "NL",
        ip: "203.0.113.7", user_agent: "node", created_at: NOW,
      },
      {
        skill_id: "s1", version: 1, source: "anonymous", user_id: null, username: null, device_name: null, country: null,
        ip: null, user_agent: null, created_at: NOW + 1,
      },
    ]);
  });

  it("adds each download to the count for its skill, UTC day, version and source", async () => {
    const record = (version: number, at: number) =>
      recordDownload(env.DB, { skillId: "s1", version, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at });
    await record(1, NOW);
    await record(1, NOW + 1);
    await record(2, NOW);
    await record(1, (TODAY + 1) * DAY_MS);
    await rollupDownloads(env.DB);
    const { results } = await env.DB.prepare(
      "SELECT skill_id, day, version, source, count FROM download_days ORDER BY day, version",
    ).all();
    expect(results).toEqual([
      { skill_id: "s1", day: TODAY, version: 1, source: "anonymous", count: 2 },
      { skill_id: "s1", day: TODAY, version: 2, source: "anonymous", count: 1 },
      { skill_id: "s1", day: TODAY + 1, version: 1, source: "anonymous", count: 1 },
    ]);
  });

  it("keeps the count and the log when the skill gets a new version", async () => {
    await recordDownload(env.DB, { skillId: "s1", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW });
    await recordDownload(env.DB, { skillId: "s1", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW + 1 });
    await q.insertVersion(env.DB, { ...skillVersion("s1", "default", "demo"), digest: `sha256:${"b".repeat(64)}` });
    await rollupDownloads(env.DB);
    expect((await q.getSkill(env.DB, "default", "demo"))?.latest_version).toBe(2);
    expect((await q.getSkill(env.DB, "default", "demo"))?.download_count).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT SUM(count) AS n FROM download_days").first("n")).toBe(2);
  });

  it("ignores a skill that no longer exists and changes nothing", async () => {
    await expect(
      recordDownload(env.DB, { skillId: "gone", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW }),
    ).resolves.toBeUndefined();
    await rollupDownloads(env.DB);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_days").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT SUM(download_count) AS n FROM skills").first("n")).toBe(0);
  });
});

const record = (skillId: string, at = NOW) =>
  recordDownload(env.DB, { skillId, version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at });

const countOf = async (slug: string) => (await q.getSkill(env.DB, "default", slug))?.download_count;

const dayTotal = async () => env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM download_days").first("n");

describe("rolling up downloads", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
  });

  it("adds each download once, however often it runs", async () => {
    await record("s1");
    await record("s1", NOW + 1);
    expect(await rollupDownloads(env.DB)).toEqual({ capped: false });
    expect(await rollupDownloads(env.DB)).toEqual({ capped: false });
    await record("s2", NOW + 2);
    await rollupDownloads(env.DB);
    expect(await countOf("demo")).toBe(2);
    expect(await countOf("other")).toBe(1);
    expect(await dayTotal()).toBe(3);
  });

  it("leaves out the downloads of a skill deleted before they were rolled up", async () => {
    await record("s1");
    await record("s2");
    await q.deleteSkill(env.DB, "default", "demo");
    await rollupDownloads(env.DB);
    expect(await env.DB.prepare("SELECT skill_id, count FROM download_days").all().then((r) => r.results)).toEqual([
      { skill_id: "s2", count: 1 },
    ]);
    expect(await countOf("other")).toBe(1);
  });

  it("counts a download that takes the id of a deleted one", async () => {
    await record("s2");
    await record("s1", NOW + 1);
    await rollupDownloads(env.DB);
    await q.deleteSkill(env.DB, "default", "demo");
    await pruneDownloadLogs(env.DB, 0);
    await record("s2", NOW + 2);
    await rollupDownloads(env.DB);
    expect(await countOf("other")).toBe(2);
  });

  it("counts a download that follows a cleanup of every older one", async () => {
    await record("s1", NOW - 100 * DAY_MS);
    await rollupDownloads(env.DB);
    await pruneDownloadLogs(env.DB, NOW - 90 * DAY_MS);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(0);
    await record("s1");
    await rollupDownloads(env.DB);
    expect(await countOf("demo")).toBe(2);
  });

  it("counts later downloads when a cleanup removes the newest rows during a roll-up", async () => {
    await record("s2");
    await record("s1", NOW + 1);
    await q.deleteSkill(env.DB, "default", "demo");
    let raced = false;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (raced || !sql.startsWith("SELECT last_id")) return statement;
            raced = true;
            return {
              first: async () => {
                const mark = await statement.first();
                await pruneDownloadLogs(env.DB, 0);
                return mark;
              },
            };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rollupDownloads(racing);
    await record("s2", NOW + 2);
    await rollupDownloads(env.DB);
    expect(await countOf("other")).toBe(2);
  });

  it("works through a backlog in batches, stops at its limit, and finishes in a later run", async () => {
    await seedLogs("s1", ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 5, NOW);
    expect(await rollupDownloads(env.DB)).toEqual({ capped: true });
    expect(await countOf("demo")).toBe(ROLLUP_BATCH * ROLLUP_MAX_BATCHES);
    expect(await rollupDownloads(env.DB)).toEqual({ capped: false });
    expect(await countOf("demo")).toBe(ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 5);
    expect(await dayTotal()).toBe(ROLLUP_BATCH * ROLLUP_MAX_BATCHES + 5);
  });

  it("rolls back a batch it cannot finish, and adds it in the next run", async () => {
    await record("s1");
    await env.DB.prepare(
      "CREATE TRIGGER reject_count BEFORE UPDATE OF download_count ON skills BEGIN SELECT RAISE(ABORT, 'count rejected'); END",
    ).run();
    try {
      await expect(rollupDownloads(env.DB)).rejects.toThrow(/count rejected/);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_count").run();
    }
    expect(await dayTotal()).toBe(0);
    await rollupDownloads(env.DB);
    expect(await countOf("demo")).toBe(1);
    expect(await dayTotal()).toBe(1);
  });
});

describe("reading the log", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
    await seedLog("s1", { at: NOW - 3 * DAY_MS, source: "web", userId: "u1", username: "alice" });
    await seedLog("s2", { at: NOW - 2 * DAY_MS, source: "install_key", userId: "u2", username: "bob" });
    await seedLog("s3", { at: NOW - DAY_MS });
    await seedLog("s1", { at: NOW, version: 2 });
  });

  it("lists newest first, with the skill's project and name", async () => {
    const all = await list({});
    expect(all.rows.map((r) => r.skill_id)).toEqual(["s1", "s3", "s2", "s1"]);
    expect(all.rows[1]).toMatchObject({ project: "team-b", project_name: "Team B", slug: "demo", source: "anonymous" });
    expect(all.more).toBe(false);
    expect(await skillsOf({ project: "default" })).toEqual(["s1", "s2", "s1"]);
    expect((await list({ skillId: "s1" })).rows.map((r) => r.version)).toEqual([2, 1]);
  });

  it("applies every filter together", async () => {
    expect(await skillsOf({ project: "default", userId: "u1" })).toEqual(["s1"]);
    expect(await skillsOf({ project: "default", source: "install_key" })).toEqual(["s2"]);
    expect(await skillsOf({ project: "default", skillId: "s3" })).toEqual([]);
    expect(await skillsOf({ project: "team-b" })).toEqual(["s3"]);
    expect(await skillsOf({ project: "nope" })).toEqual([]);
  });

  it("starts at since, pages by id, and says when there is more", async () => {
    expect((await list({}, { since: NOW - 2 * DAY_MS })).rows).toHaveLength(3);
    const first = await list({}, { limit: 2 });
    expect(first.rows.map((r) => r.skill_id)).toEqual(["s1", "s3"]);
    expect(first.more).toBe(true);
    const second = await list({}, { before: first.rows[1].id, limit: 2 });
    expect(second.rows.map((r) => r.skill_id)).toEqual(["s2", "s1"]);
    expect(second.more).toBe(false);
    const project = await list({ project: "default" }, { before: first.rows[0].id, limit: 1 });
    expect(project.rows.map((r) => r.skill_id)).toEqual(["s2"]);
    expect(project.more).toBe(true);
  });

  it("totals by source and by UTC day, and breaks down by version, skill or project", async () => {
    const all = await downloadStats(env.DB, NO_FILTER, "project", 0);
    expect(all.total).toBe(4);
    expect(all.bySource).toEqual({ web: 1, device: 0, install_key: 1, anonymous: 2 });
    expect(all.byDay).toEqual([
      { day: TODAY - 3, count: 1 },
      { day: TODAY - 2, count: 1 },
      { day: TODAY - 1, count: 1 },
      { day: TODAY, count: 1 },
    ]);
    expect(all.breakdown).toEqual([
      { key: "default", label: "Default", count: 3 },
      { key: "team-b", label: "Team B", count: 1 },
    ]);
    const project = await downloadStats(env.DB, filter({ project: "default" }), "skill", 0);
    expect(project.breakdown).toEqual([
      { key: "s1", label: "demo", count: 2 },
      { key: "s2", label: "other", count: 1 },
    ]);
    const one = await downloadStats(env.DB, filter({ skillId: "s1" }), "version", TODAY - 1);
    expect(one.total).toBe(1);
    expect(one.breakdown).toEqual([{ key: "2", label: "2", count: 1 }]);
    const none = await downloadStats(env.DB, filter({ source: "device" }), "project", 0);
    expect(none).toEqual({ total: 0, bySource: { web: 0, device: 0, install_key: 0, anonymous: 0 }, byDay: [], breakdown: [] });
  });

  it("totals the same before, during and after the roll-up", async () => {
    const totals = async () =>
      Promise.all([
        downloadStats(env.DB, NO_FILTER, "project", 0),
        downloadStats(env.DB, filter({ project: "default" }), "skill", 0),
        downloadStats(env.DB, filter({ skillId: "s1", source: "anonymous" }), "version", 0),
      ]);
    const before = await totals();
    await rollupDownloads(env.DB);
    expect(await totals()).toEqual(before);
    await seedLog("s1", { at: NOW + 1 });
    const during = await totals();
    expect(during[0].total).toBe(5);
    expect(during[1].breakdown[0]).toEqual({ key: "s1", label: "demo", count: 3 });
    expect(during[2].bySource.anonymous).toBe(2);
    await rollupDownloads(env.DB);
    expect(await totals()).toEqual(during);
  });

  it("counts one account's downloads from the log itself", async () => {
    await seedLog("s3", { at: NOW, source: "device", userId: "u1", username: "alice" });
    const alice = await downloadStats(env.DB, filter({ userId: "u1" }), "project", 0);
    expect(alice.total).toBe(2);
    expect(alice.bySource).toEqual({ web: 1, device: 1, install_key: 0, anonymous: 0 });
    expect(alice.byDay).toEqual([
      { day: TODAY - 3, count: 1 },
      { day: TODAY, count: 1 },
    ]);
    expect(alice.breakdown).toEqual([
      { key: "default", label: "Default", count: 1 },
      { key: "team-b", label: "Team B", count: 1 },
    ]);
    const inProject = await downloadStats(env.DB, filter({ userId: "u1", project: "team-b" }), "skill", TODAY - 1);
    expect(inProject.total).toBe(1);
    expect(inProject.breakdown).toEqual([{ key: "s3", label: "demo", count: 1 }]);
  });

  it("adds up one day's sources and keeps the days in order", async () => {
    await seedLog("s2", { at: NOW, source: "web", userId: "u1", username: "alice" });
    const stats = await downloadStats(env.DB, NO_FILTER, "project", TODAY - 1);
    expect(stats.byDay).toEqual([
      { day: TODAY - 1, count: 1 },
      { day: TODAY, count: 2 },
    ]);
    expect(stats.bySource).toEqual({ web: 1, device: 0, install_key: 0, anonymous: 2 });
    expect(stats.total).toBe(3);
  });

  it("lists at most ten skills in a project's breakdown, busiest first", async () => {
    for (let i = 0; i < 12; i++) {
      await addSkill(`k${i}`, "default", `skill-${i}`);
      await seedLogs(`k${i}`, i + 3, NOW);
    }
    const stats = await downloadStats(env.DB, filter({ project: "default" }), "skill", 0);
    expect(stats.breakdown).toHaveLength(10);
    expect(stats.breakdown[0]).toEqual({ key: "k11", label: "skill-11", count: 14 });
    expect(stats.breakdown[9]).toEqual({ key: "k2", label: "skill-2", count: 5 });
  });

  it("lists at most ten versions and ten projects, busiest first", async () => {
    for (let i = 0; i < 12; i++) {
      await q.createProject(env.DB, { slug: `p${i}`, name: `Project ${i}` });
      await addSkill(`k${i}`, `p${i}`, "demo");
      await seedLogs(`k${i}`, i + 3, NOW);
      await seedLog("s2", { at: NOW, version: i + 1 });
    }
    const versions = await downloadStats(env.DB, filter({ skillId: "s2" }), "version", 0);
    expect(versions.breakdown.map((share) => [share.key, share.count])).toEqual([
      ["1", 2], ["12", 1], ["11", 1], ["10", 1], ["9", 1], ["8", 1], ["7", 1], ["6", 1], ["5", 1], ["4", 1],
    ]);
    const projects = await downloadStats(env.DB, NO_FILTER, "project", 0);
    expect(projects.breakdown).toHaveLength(10);
    expect(projects.breakdown[0]).toEqual({ key: "default", label: "Default", count: 15 });
    expect(projects.breakdown[1]).toEqual({ key: "p11", label: "Project 11", count: 14 });
  });
});

describe("naming the filters", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
    await seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    await seedLog("s3", { at: NOW, source: "install_key", userId: "u2", username: "bob" });
  });

  it("names the project, the skill with its project, and the account as the log recorded it", async () => {
    expect(await filterNames(env.DB, filter({ project: "team-b", skillId: "s3", userId: "u2" }), NO_FILTER, 0)).toEqual({
      project: "Team B",
      skill: { slug: "demo", projectName: "Team B" },
      user: "bob",
    });
  });

  it("names nothing outside the page's own project or retention", async () => {
    const within = filter({ project: "default" });
    expect(await filterNames(env.DB, filter({ skillId: "s3", userId: "u2" }), within, 0)).toEqual({ project: null, skill: null, user: null });
    expect(await filterNames(env.DB, filter({ skillId: "s1", userId: "u1" }), within, 0)).toEqual({
      project: null,
      skill: { slug: "demo", projectName: "Default" },
      user: "alice",
    });
    expect((await filterNames(env.DB, filter({ userId: "u1" }), within, NOW)).user).toBeNull();
  });

  it("returns nothing for what it cannot find or was not asked", async () => {
    const none = { project: null, skill: null, user: null };
    expect(await filterNames(env.DB, filter({ project: "nope", skillId: "gone", userId: "ghost" }), NO_FILTER, 0)).toEqual(none);
    expect(await filterNames(env.DB, filter({ source: "web" }), NO_FILTER, 0)).toEqual(none);
  });
});

describe("pruning the log", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
  });

  it("deletes rows older than the cutoff in batches, keeps the rest, and reports how many went", async () => {
    const cutoff = NOW - 90 * DAY_MS;
    await seedLogs("s1", 2500, cutoff - 1);
    await seedLog("s1", { at: cutoff });
    await seedLog("s2", { at: NOW });
    await rollupDownloads(env.DB);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: 2500, capped: false });
    const { results } = await env.DB.prepare("SELECT created_at FROM download_logs ORDER BY created_at").all();
    expect(results).toEqual([{ created_at: cutoff }, { created_at: NOW }]);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: 0, capped: false });
  });

  it("deletes the daily counts of days that ended before the cutoff", async () => {
    const cutoff = (TODAY - 90) * DAY_MS + 5;
    await seedLog("s1", { at: cutoff - 1 });
    await seedLog("s1", { at: cutoff - DAY_MS });
    await seedLog("s1", { at: NOW });
    await rollupDownloads(env.DB);
    await pruneDownloadLogs(env.DB, cutoff);
    const { results } = await env.DB.prepare("SELECT day, count FROM download_days ORDER BY day").all();
    expect(results).toEqual([
      { day: TODAY - 90, count: 1 },
      { day: TODAY, count: 1 },
    ]);
  });

  it("stops after a fixed number of batches and leaves the rest for the next run", async () => {
    const cutoff = NOW - 90 * DAY_MS;
    await seedLogs("s1", PRUNE_BATCH * PRUNE_MAX_BATCHES + 5, cutoff - 1);
    await seedLog("s2", { at: NOW });
    await rollupDownloads(env.DB);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: PRUNE_BATCH * PRUNE_MAX_BATCHES, capped: true });
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: 5, capped: false });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(1);
  });

  it("keeps the downloads it has not rolled up yet", async () => {
    const cutoff = NOW - 90 * DAY_MS;
    await seedLog("s1", { at: cutoff - 1 });
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: 0, capped: false });
    await rollupDownloads(env.DB);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: 1, capped: false });
    expect(await countOf("demo")).toBe(1);
  });
});

describe("reading the totals", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
       INSERT INTO download_days (skill_id, day, version, source, count) SELECT 's2', ? - i, 1, 'anonymous', 1 FROM n`,
    )
      .bind(TODAY)
      .run();
    await seedLogs("s2", 3000, NOW - DAY_MS);
    await rollupDownloads(env.DB);
    await seedLog("s1", { at: NOW, source: "web", userId: "u1", username: "alice" });
    await seedLog("s2", { at: NOW });
  });

  async function rowsRead(change: Partial<DownloadFilter>, breakdown: "version" | "skill" | "project"): Promise<number> {
    let read = 0;
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await env.DB.batch(statements);
        for (const result of results) read += result.meta.rows_read;
        return results;
      },
    } as unknown as D1Database;
    const stats = await downloadStats(db, filter(change), breakdown, TODAY - 29);
    expect(stats.total).toBeGreaterThan(0);
    return read;
  }

  it.each<[string, Partial<DownloadFilter>, "version" | "skill" | "project"]>([
    ["everything", {}, "project"],
    ["a source", { source: "web" }, "project"],
    ["a project", { project: "default" }, "skill"],
    ["a busy skill", { skillId: "s2" }, "version"],
    ["a quiet skill", { skillId: "s1" }, "version"],
    ["an account", { userId: "u1" }, "project"],
  ])("reads the window's daily counts and the downloads not rolled up yet, not every row, for %s", async (_, change, breakdown) => {
    expect(await rowsRead(change, breakdown)).toBeLessThan(300);
  });
});

describe("reading a large log", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
    await seedLogs("s2", 3000, NOW - DAY_MS);
    await seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    await seedLog("s3", { at: NOW, source: "install_key" });
    await seedLogs("s2", 3000, NOW);
  });

  async function rowsRead(change: Partial<DownloadFilter>): Promise<number> {
    let read = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => {
            const result = await env.DB.prepare(sql).bind(...values).all();
            read += result.meta.rows_read;
            return result;
          },
        }),
      }),
    } as unknown as D1Database;
    await listDownloadLogs(db, filter(change), { since: 0, before: null, limit: 50 });
    return read;
  }

  it.each<[string, Partial<DownloadFilter>]>([
    ["everything", {}],
    ["a rare source", { source: "install_key" }],
    ["a common source", { source: "anonymous" }],
    ["a project", { project: "default" }],
    ["a project and a source it lacks", { project: "default", source: "install_key" }],
    ["a small project and a common source", { project: "team-b", source: "anonymous" }],
    ["a busy skill", { skillId: "s2" }],
    ["a quiet skill", { skillId: "s1" }],
    ["a skill and a source it lacks", { skillId: "s2", source: "web" }],
    ["an account", { userId: "u1" }],
  ])("reads a page's worth of rows, not the whole log, for %s", async (_, change) => {
    expect(await rowsRead(change)).toBeLessThan(500);
  });
});

describe("deleting a skill", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
    await seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    await seedLog("s2", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    await seedLog("s1", { at: NOW, source: "web", userId: "u1", username: "alice" });
    await rollupDownloads(env.DB);
  });

  it("drops its downloads from every list and total at once", async () => {
    await q.deleteSkill(env.DB, "default", "demo");
    const page = await list({}, { limit: 1 });
    expect(page.rows.map((r) => r.skill_id)).toEqual(["s2"]);
    expect(page.more).toBe(false);
    expect(await skillsOf({ userId: "u1" })).toEqual(["s2"]);
    expect(await skillsOf({ source: "web" })).toEqual(["s2"]);
    expect((await downloadStats(env.DB, NO_FILTER, "project", 0)).total).toBe(1);
    expect((await downloadStats(env.DB, filter({ userId: "u1" }), "project", 0)).total).toBe(1);
    expect(await env.DB.prepare("SELECT skill_id FROM download_days").all().then((r) => r.results)).toEqual([{ skill_id: "s2" }]);
  });

  it("leaves its log rows to the hourly run, which deletes them and then forgets the skill", async () => {
    await q.deleteSkill(env.DB, "default", "demo");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(3);
    expect(await env.DB.prepare("SELECT skill_id FROM download_purges").all().then((r) => r.results)).toEqual([{ skill_id: "s1" }]);
    expect(await pruneDownloadLogs(env.DB, 0)).toEqual({ deleted: 2, capped: false });
    expect(await env.DB.prepare("SELECT skill_id FROM download_logs").all().then((r) => r.results)).toEqual([{ skill_id: "s2" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_purges").first("n")).toBe(0);
  });

  it("shares a run's limit with older downloads, which go first, and finishes in a later run", async () => {
    await resetDb();
    await seedSkills();
    await seedLogs("s2", PRUNE_BATCH * (PRUNE_MAX_BATCHES - 1), NOW - 100 * DAY_MS);
    await seedLog("s2", { at: NOW });
    await seedLogs("s1", PRUNE_BATCH + 500, NOW);
    await rollupDownloads(env.DB);
    await q.deleteSkill(env.DB, "default", "demo");
    const cutoff = NOW - 90 * DAY_MS;
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: PRUNE_BATCH * (PRUNE_MAX_BATCHES - 1), capped: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_purges").first("n")).toBe(1);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toEqual({ deleted: PRUNE_BATCH + 500, capped: false });
    expect(await env.DB.prepare("SELECT skill_id FROM download_logs").all().then((r) => r.results)).toEqual([{ skill_id: "s2" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_purges").first("n")).toBe(0);
  });
});
