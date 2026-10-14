import { beforeEach, describe, expect, it } from "vitest";
import {
  ANONYMOUS_DOWNLOADER, downloadStats, filterNames, listDownloadLogs, NO_FILTER, PRUNE_BATCH, PRUNE_MAX_BATCHES,
  pruneDownloadLogs, recordDownload,
} from "../src/db/downloads";
import type { DownloadFilter } from "../src/db/downloads";
import * as q from "../src/db/queries";
import { DAY_MS } from "../src/time";
import { env, resetDb, seedLog, seedLogs } from "./helpers";

const NOW = Date.UTC(2026, 9, 13, 12);
const TODAY = Math.floor(NOW / DAY_MS);

const addSkill = (skillId: string, project: string, slug: string) =>
  q.insertVersion(env.DB, {
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
    visibility: "private",
  });

async function seedSkills() {
  await q.createUser(env.DB, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });
  await q.createProject(env.DB, { slug: "team-b", name: "Team B" });
  await addSkill("s1", "default", "demo");
  await addSkill("s2", "default", "other");
  await addSkill("s3", "team-b", "demo");
}

const filter = (change: Partial<DownloadFilter> = {}): DownloadFilter => ({ ...NO_FILTER, ...change });

const list = (change: Partial<DownloadFilter>, opts: { since?: number; before?: number | null; limit?: number } = {}) =>
  listDownloadLogs(env.DB, filter(change), { since: opts.since ?? 0, before: opts.before ?? null, limit: opts.limit ?? 50 });

const skillsOf = async (change: Partial<DownloadFilter>) => (await list(change)).rows.map((r) => r.skill_id);

describe("recording a download", () => {
  beforeEach(async () => {
    await resetDb();
    await seedSkills();
  });

  it("counts it and logs who made it in one write that leaves updated_at alone", async () => {
    const before = await q.getSkill(env.DB, "default", "demo");
    await recordDownload(env.DB, {
      skillId: "s1",
      version: 1,
      downloader: { source: "device", userId: "u1", username: "alice", deviceName: "laptop" },
      country: "NL",
      at: NOW,
    });
    await recordDownload(env.DB, { skillId: "s1", version: 1, downloader: ANONYMOUS_DOWNLOADER, country: null, at: NOW + 1 });
    const after = await q.getSkill(env.DB, "default", "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);
    const { results } = await env.DB.prepare(
      "SELECT skill_id, version, source, user_id, username, device_name, country, created_at FROM download_logs ORDER BY id",
    ).all();
    expect(results).toEqual([
      { skill_id: "s1", version: 1, source: "device", user_id: "u1", username: "alice", device_name: "laptop", country: "NL", created_at: NOW },
      { skill_id: "s1", version: 1, source: "anonymous", user_id: null, username: null, device_name: null, country: null, created_at: NOW + 1 },
    ]);
  });

  it("ignores a skill that no longer exists and changes nothing", async () => {
    await expect(
      recordDownload(env.DB, { skillId: "gone", version: 1, downloader: ANONYMOUS_DOWNLOADER, country: null, at: NOW }),
    ).resolves.toBeUndefined();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT SUM(download_count) AS n FROM skills").first("n")).toBe(0);
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
    const one = await downloadStats(env.DB, filter({ skillId: "s1" }), "version", NOW - DAY_MS);
    expect(one.total).toBe(1);
    expect(one.breakdown).toEqual([{ key: "2", label: "2", count: 1 }]);
    const none = await downloadStats(env.DB, filter({ source: "device" }), "project", 0);
    expect(none).toEqual({ total: 0, bySource: { web: 0, device: 0, install_key: 0, anonymous: 0 }, byDay: [], breakdown: [] });
  });

  it("adds up one day's sources and keeps the days in order", async () => {
    await seedLog("s2", { at: NOW, source: "web", userId: "u1", username: "alice" });
    const stats = await downloadStats(env.DB, NO_FILTER, "project", NOW - DAY_MS);
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
    expect(await pruneDownloadLogs(env.DB, cutoff)).toBe(2500);
    const { results } = await env.DB.prepare("SELECT created_at FROM download_logs ORDER BY created_at").all();
    expect(results).toEqual([{ created_at: cutoff }, { created_at: NOW }]);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toBe(0);
  });

  it("stops after a fixed number of batches and leaves the rest for the next run", async () => {
    const cutoff = NOW - 90 * DAY_MS;
    await seedLogs("s1", PRUNE_BATCH * PRUNE_MAX_BATCHES + 5, cutoff - 1);
    await seedLog("s2", { at: NOW });
    expect(await pruneDownloadLogs(env.DB, cutoff)).toBe(PRUNE_BATCH * PRUNE_MAX_BATCHES);
    expect(await pruneDownloadLogs(env.DB, cutoff)).toBe(5);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM download_logs").first("n")).toBe(1);
  });
});
