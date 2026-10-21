import { beforeEach, describe, expect, it } from "vitest";
import {
  ANONYMOUS_DOWNLOADER, downloadStats, filterNames, listDownloadLogs, NO_FILTER, PRUNE_BATCH, pruneDownloadLogs,
  recordDownload,
} from "../src/db/downloads";
import type { DownloadFilter } from "../src/db/downloads";
import * as q from "../src/db/queries";
import { DAY_MS } from "../src/time";
import { env, resetDb, seedLog, seedLogs } from "./helpers";

const NOW = Date.UTC(2026, 9, 13, 12);
const TODAY = Math.floor(NOW / DAY_MS);

const skillVersion = (skillId: string, project: string, slug: string, digest = `sha256:${"a".repeat(64)}`) => ({
  skillId,
  project,
  slug,
  digest,
  size: 1,
  name: slug,
  description: "d",
  skill_md: "x",
  html: "x",
  html_rev: 1,
  files: "[]",
  authorId: "u1",
  visibility: "private" as const,
  objectKey: q.objectKeyFor(skillId, digest),
});

const addSkill = (skillId: string, project: string, slug: string) => q.insertVersion(env.db, skillVersion(skillId, project, slug));

function seedSkills() {
  q.createUser(env.db, { id: "u1", username: "alice", passwordHash: "h", role: "admin" });
  q.createProject(env.db, { slug: "team-b", name: "Team B" });
  addSkill("s1", "default", "demo");
  addSkill("s2", "default", "other");
  addSkill("s3", "team-b", "demo");
}

const NOWHERE = { country: null, ip: null, userAgent: null };

const filter = (change: Partial<DownloadFilter> = {}): DownloadFilter => ({ ...NO_FILTER, ...change });

const list = (change: Partial<DownloadFilter>, opts: { since?: number; before?: number | null; limit?: number } = {}) =>
  listDownloadLogs(env.db, filter(change), { since: opts.since ?? 0, before: opts.before ?? null, limit: opts.limit ?? 50 });

const skillsOf = (change: Partial<DownloadFilter>) => list(change).rows.map((r) => r.skill_id);

const scalar = (sql: string) => env.db.prepare(sql).pluck().get();

const rows = (sql: string) => env.db.prepare(sql).all();

const countOf = (slug: string) => q.getSkill(env.db, "default", slug)?.download_count;

describe("recording a download", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
  });

  it("logs who made it and counts it at once, without touching the skill's updated time", () => {
    const before = q.getSkill(env.db, "default", "demo");
    expect(
      recordDownload(env.db, {
        skillId: "s1",
        version: 1,
        downloader: { source: "device", userId: "u1", username: "alice", deviceName: "laptop" },
        country: "NL",
        ip: "203.0.113.7",
        userAgent: "node",
        at: NOW,
      }),
    ).toBe(true);
    recordDownload(env.db, { skillId: "s1", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW + 1 });
    const after = q.getSkill(env.db, "default", "demo");
    expect(after?.download_count).toBe(2);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(
      rows("SELECT skill_id, version, source, user_id, username, device_name, country, ip, user_agent, created_at FROM download_logs ORDER BY id"),
    ).toEqual([
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

  it("adds each download to the count for its skill, UTC day, version and source", () => {
    const record = (version: number, at: number) =>
      recordDownload(env.db, { skillId: "s1", version, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at });
    record(1, NOW);
    record(1, NOW + 1);
    record(2, NOW);
    record(1, (TODAY + 1) * DAY_MS);
    expect(rows("SELECT skill_id, day, version, source, count FROM download_days ORDER BY day, version")).toEqual([
      { skill_id: "s1", day: TODAY, version: 1, source: "anonymous", count: 2 },
      { skill_id: "s1", day: TODAY, version: 2, source: "anonymous", count: 1 },
      { skill_id: "s1", day: TODAY + 1, version: 1, source: "anonymous", count: 1 },
    ]);
  });

  it("adds signed-in downloads to their account's daily counts, and leaves anonymous ones out", () => {
    seedLog("s1", { at: NOW, source: "web", userId: "u1", username: "alice" });
    seedLog("s1", { at: NOW + 1, source: "web", userId: "u1", username: "alice" });
    seedLog("s1", { at: NOW });
    expect(rows("SELECT user_id, day, skill_id, version, source, count FROM download_user_days")).toEqual([
      { user_id: "u1", day: TODAY, skill_id: "s1", version: 1, source: "web", count: 2 },
    ]);
  });

  it("keeps the count and the log when the skill gets a new version", () => {
    seedLog("s1", { at: NOW });
    seedLog("s1", { at: NOW + 1 });
    q.insertVersion(env.db, skillVersion("s1", "default", "demo", `sha256:${"b".repeat(64)}`));
    expect(q.getSkill(env.db, "default", "demo")?.latest_version).toBe(2);
    expect(countOf("demo")).toBe(2);
    expect(scalar("SELECT COUNT(*) FROM download_logs")).toBe(2);
    expect(scalar("SELECT SUM(count) FROM download_days")).toBe(2);
  });

  it("ignores a skill that no longer exists and changes nothing", () => {
    expect(recordDownload(env.db, { skillId: "gone", version: 1, downloader: ANONYMOUS_DOWNLOADER, ...NOWHERE, at: NOW })).toBe(false);
    expect(scalar("SELECT COUNT(*) FROM download_logs")).toBe(0);
    expect(scalar("SELECT COUNT(*) FROM download_days")).toBe(0);
    expect(scalar("SELECT SUM(download_count) FROM skills")).toBe(0);
  });
});

describe("reading the log", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
    seedLog("s1", { at: NOW - 3 * DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s2", { at: NOW - 2 * DAY_MS, source: "install_key", userId: "u2", username: "bob" });
    seedLog("s3", { at: NOW - DAY_MS });
    seedLog("s1", { at: NOW, version: 2 });
  });

  it("lists newest first, with the skill's project and name", async () => {
    const all = list({});
    expect(all.rows.map((r) => r.skill_id)).toEqual(["s1", "s3", "s2", "s1"]);
    expect(all.rows[1]).toMatchObject({ project: "team-b", project_name: "Team B", slug: "demo", source: "anonymous" });
    expect(all.more).toBe(false);
    expect(skillsOf({ project: "default" })).toEqual(["s1", "s2", "s1"]);
    expect((list({ skillId: "s1" })).rows.map((r) => r.version)).toEqual([2, 1]);
  });

  it("applies every filter together", async () => {
    expect(skillsOf({ project: "default", userId: "u1" })).toEqual(["s1"]);
    expect(skillsOf({ project: "default", source: "install_key" })).toEqual(["s2"]);
    expect(skillsOf({ project: "default", skillId: "s3" })).toEqual([]);
    expect(skillsOf({ project: "team-b" })).toEqual(["s3"]);
    expect(skillsOf({ project: "nope" })).toEqual([]);
  });

  it("starts at since, pages by id, and says when there is more", async () => {
    expect((list({}, { since: NOW - 2 * DAY_MS })).rows).toHaveLength(3);
    const first = list({}, { limit: 2 });
    expect(first.rows.map((r) => r.skill_id)).toEqual(["s1", "s3"]);
    expect(first.more).toBe(true);
    const second = list({}, { before: first.rows[1].id, limit: 2 });
    expect(second.rows.map((r) => r.skill_id)).toEqual(["s2", "s1"]);
    expect(second.more).toBe(false);
    const project = list({ project: "default" }, { before: first.rows[0].id, limit: 1 });
    expect(project.rows.map((r) => r.skill_id)).toEqual(["s2"]);
    expect(project.more).toBe(true);
  });

  it("totals by source and by UTC day, and breaks down by version, skill or project", async () => {
    const all = downloadStats(env.db, NO_FILTER, "project", 0);
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
    const project = downloadStats(env.db, filter({ project: "default" }), "skill", 0);
    expect(project.breakdown).toEqual([
      { key: "s1", label: "demo", count: 2 },
      { key: "s2", label: "other", count: 1 },
    ]);
    const one = downloadStats(env.db, filter({ skillId: "s1" }), "version", TODAY - 1);
    expect(one.total).toBe(1);
    expect(one.breakdown).toEqual([{ key: "2", label: "2", count: 1 }]);
    const none = downloadStats(env.db, filter({ source: "device" }), "project", 0);
    expect(none).toEqual({ total: 0, bySource: { web: 0, device: 0, install_key: 0, anonymous: 0 }, byDay: [], breakdown: [] });
  });

  it("counts a new download in every total at once", async () => {
    const before = downloadStats(env.db, NO_FILTER, "project", 0);
    seedLog("s1", { at: NOW + 1 });
    const after = downloadStats(env.db, NO_FILTER, "project", 0);
    expect(after.total).toBe(before.total + 1);
    expect(downloadStats(env.db, filter({ project: "default" }), "skill", 0).breakdown[0]).toEqual({ key: "s1", label: "demo", count: 3 });
    expect(downloadStats(env.db, filter({ skillId: "s1", source: "anonymous" }), "version", 0).bySource.anonymous).toBe(2);
  });

  it("counts one account's downloads from the log itself", async () => {
    seedLog("s3", { at: NOW, source: "device", userId: "u1", username: "alice" });
    const alice = downloadStats(env.db, filter({ userId: "u1" }), "project", 0);
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
    const inProject = downloadStats(env.db, filter({ userId: "u1", project: "team-b" }), "skill", TODAY - 1);
    expect(inProject.total).toBe(1);
    expect(inProject.breakdown).toEqual([{ key: "s3", label: "demo", count: 1 }]);
  });

  it("adds up one day's sources and keeps the days in order", async () => {
    seedLog("s2", { at: NOW, source: "web", userId: "u1", username: "alice" });
    const stats = downloadStats(env.db, NO_FILTER, "project", TODAY - 1);
    expect(stats.byDay).toEqual([
      { day: TODAY - 1, count: 1 },
      { day: TODAY, count: 2 },
    ]);
    expect(stats.bySource).toEqual({ web: 1, device: 0, install_key: 0, anonymous: 2 });
    expect(stats.total).toBe(3);
  });

  it("lists at most ten skills in a project's breakdown, busiest first", async () => {
    for (let i = 0; i < 12; i++) {
      addSkill(`k${i}`, "default", `skill-${i}`);
      seedLogs(`k${i}`, i + 3, NOW);
    }
    const stats = downloadStats(env.db, filter({ project: "default" }), "skill", 0);
    expect(stats.breakdown).toHaveLength(10);
    expect(stats.breakdown[0]).toEqual({ key: "k11", label: "skill-11", count: 14 });
    expect(stats.breakdown[9]).toEqual({ key: "k2", label: "skill-2", count: 5 });
  });

  it("lists at most ten versions and ten projects, busiest first", async () => {
    for (let i = 0; i < 12; i++) {
      q.createProject(env.db, { slug: `p${i}`, name: `Project ${i}` });
      addSkill(`k${i}`, `p${i}`, "demo");
      seedLogs(`k${i}`, i + 3, NOW);
      seedLog("s2", { at: NOW, version: i + 1 });
    }
    const versions = downloadStats(env.db, filter({ skillId: "s2" }), "version", 0);
    expect(versions.breakdown.map((share) => [share.key, share.count])).toEqual([
      ["1", 2], ["12", 1], ["11", 1], ["10", 1], ["9", 1], ["8", 1], ["7", 1], ["6", 1], ["5", 1], ["4", 1],
    ]);
    const projects = downloadStats(env.db, NO_FILTER, "project", 0);
    expect(projects.breakdown).toHaveLength(10);
    expect(projects.breakdown[0]).toEqual({ key: "default", label: "Default", count: 15 });
    expect(projects.breakdown[1]).toEqual({ key: "p11", label: "Project 11", count: 14 });
  });
});

describe("naming the filters", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
    seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s3", { at: NOW, source: "install_key", userId: "u2", username: "bob" });
  });

  it("names the project, the skill with its project, and the account as the log recorded it", async () => {
    expect(filterNames(env.db, filter({ project: "team-b", skillId: "s3", userId: "u2" }), NO_FILTER, 0)).toEqual({
      project: "Team B",
      skill: { slug: "demo", projectName: "Team B" },
      user: "bob",
    });
  });

  it("names nothing outside the page's own project or retention", async () => {
    const within = filter({ project: "default" });
    expect(filterNames(env.db, filter({ skillId: "s3", userId: "u2" }), within, 0)).toEqual({ project: null, skill: null, user: null });
    expect(filterNames(env.db, filter({ skillId: "s1", userId: "u1" }), within, 0)).toEqual({
      project: null,
      skill: { slug: "demo", projectName: "Default" },
      user: "alice",
    });
    expect((filterNames(env.db, filter({ userId: "u1" }), within, NOW)).user).toBeNull();
  });

  it("returns nothing for what it cannot find or was not asked", async () => {
    const none = { project: null, skill: null, user: null };
    expect(filterNames(env.db, filter({ project: "nope", skillId: "gone", userId: "ghost" }), NO_FILTER, 0)).toEqual(none);
    expect(filterNames(env.db, filter({ source: "web" }), NO_FILTER, 0)).toEqual(none);
  });
});

describe("naming the filters", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
    seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s3", { at: NOW, source: "install_key", userId: "u2", username: "bob" });
  });

  it("names the project, the skill with its project, and the account as the log recorded it", async () => {
    expect(filterNames(env.db, filter({ project: "team-b", skillId: "s3", userId: "u2" }), NO_FILTER, 0)).toEqual({
      project: "Team B",
      skill: { slug: "demo", projectName: "Team B" },
      user: "bob",
    });
  });

  it("names nothing outside the page's own project or retention", async () => {
    const within = filter({ project: "default" });
    expect(filterNames(env.db, filter({ skillId: "s3", userId: "u2" }), within, 0)).toEqual({ project: null, skill: null, user: null });
    expect(filterNames(env.db, filter({ skillId: "s1", userId: "u1" }), within, 0)).toEqual({
      project: null,
      skill: { slug: "demo", projectName: "Default" },
      user: "alice",
    });
    expect((filterNames(env.db, filter({ userId: "u1" }), within, NOW)).user).toBeNull();
  });

  it("returns nothing for what it cannot find or was not asked", async () => {
    const none = { project: null, skill: null, user: null };
    expect(filterNames(env.db, filter({ project: "nope", skillId: "gone", userId: "ghost" }), NO_FILTER, 0)).toEqual(none);
    expect(filterNames(env.db, filter({ source: "web" }), NO_FILTER, 0)).toEqual(none);
  });
});

describe("pruning the log", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
  });

  it("deletes rows older than the cutoff in batches, keeps the rest, and reports how many went", () => {
    const cutoff = NOW - 90 * DAY_MS;
    seedLogs("s1", PRUNE_BATCH + 7, cutoff - 1);
    seedLog("s1", { at: cutoff });
    seedLog("s2", { at: NOW });
    expect(pruneDownloadLogs(env.db, cutoff)).toBe(PRUNE_BATCH + 7);
    expect(rows("SELECT created_at FROM download_logs ORDER BY created_at")).toEqual([{ created_at: cutoff }, { created_at: NOW }]);
    expect(pruneDownloadLogs(env.db, cutoff)).toBe(0);
  });

  it("deletes expired rows wherever they sit in the log", () => {
    const cutoff = NOW - 90 * DAY_MS;
    seedLog("s1", { at: cutoff - 2 });
    seedLog("s1", { at: cutoff + 1 });
    seedLog("s1", { at: cutoff - 1 });
    expect(pruneDownloadLogs(env.db, cutoff)).toBe(2);
    expect(rows("SELECT created_at FROM download_logs")).toEqual([{ created_at: cutoff + 1 }]);
  });

  it("deletes the daily counts of days that ended before the cutoff", () => {
    const cutoff = (TODAY - 90) * DAY_MS + 5;
    seedLog("s1", { at: cutoff - 1 });
    seedLog("s1", { at: cutoff - DAY_MS });
    seedLog("s1", { at: NOW });
    pruneDownloadLogs(env.db, cutoff);
    expect(rows("SELECT day, count FROM download_days ORDER BY day")).toEqual([
      { day: TODAY - 90, count: 1 },
      { day: TODAY, count: 1 },
    ]);
  });

  it("deletes the account daily counts of days that ended before the cutoff", () => {
    const cutoff = (TODAY - 90) * DAY_MS + 5;
    seedLog("s1", { at: cutoff - DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s1", { at: NOW, source: "web", userId: "u1", username: "alice" });
    pruneDownloadLogs(env.db, cutoff);
    expect(rows("SELECT day FROM download_user_days")).toEqual([{ day: TODAY }]);
  });

  it("keeps the skill's download count", () => {
    seedLogs("s1", 3, NOW - 100 * DAY_MS);
    pruneDownloadLogs(env.db, NOW - 90 * DAY_MS);
    expect(scalar("SELECT COUNT(*) FROM download_logs")).toBe(0);
    expect(countOf("demo")).toBe(3);
  });
});

describe("deleting a skill", () => {
  beforeEach(async () => {
    await resetDb();
    seedSkills();
    seedLog("s1", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s2", { at: NOW - DAY_MS, source: "web", userId: "u1", username: "alice" });
    seedLog("s1", { at: NOW, source: "web", userId: "u1", username: "alice" });
  });

  it("deletes its log rows and daily counts with it, and drops them from every list and total", () => {
    q.deleteSkill(env.db, "default", "demo");
    const page = list({}, { limit: 1 });
    expect(page.rows.map((r) => r.skill_id)).toEqual(["s2"]);
    expect(page.more).toBe(false);
    expect(skillsOf({ userId: "u1" })).toEqual(["s2"]);
    expect(skillsOf({ source: "web" })).toEqual(["s2"]);
    expect(downloadStats(env.db, NO_FILTER, "project", 0).total).toBe(1);
    expect(downloadStats(env.db, filter({ userId: "u1" }), "project", 0).total).toBe(1);
    expect(rows("SELECT skill_id FROM download_logs")).toEqual([{ skill_id: "s2" }]);
    expect(rows("SELECT skill_id FROM download_days")).toEqual([{ skill_id: "s2" }]);
    expect(rows("SELECT skill_id FROM download_user_days")).toEqual([{ skill_id: "s2" }]);
  });

  it("returns the archive keys of every version", () => {
    q.insertVersion(env.db, skillVersion("s1", "default", "demo", `sha256:${"b".repeat(64)}`));
    expect(q.deleteSkill(env.db, "default", "demo").sort()).toEqual(
      [q.objectKeyFor("s1", `sha256:${"a".repeat(64)}`), q.objectKeyFor("s1", `sha256:${"b".repeat(64)}`)].sort(),
    );
    expect(q.getSkill(env.db, "default", "demo")).toBeNull();
    expect(scalar("SELECT COUNT(*) FROM versions WHERE skill_id = 's1'")).toBe(0);
  });
});
