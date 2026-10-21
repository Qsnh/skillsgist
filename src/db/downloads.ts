import { DAY_MS } from "../time";
import { all, get, run, transaction } from "./database";
import type { Db } from "./database";

export const DOWNLOAD_SOURCES = ["web", "device", "install_key", "anonymous"] as const;

export type DownloadSource = (typeof DOWNLOAD_SOURCES)[number];

export interface Downloader {
  source: DownloadSource;
  userId: string | null;
  username: string | null;
  deviceName: string | null;
}

export const ANONYMOUS_DOWNLOADER: Downloader = { source: "anonymous", userId: null, username: null, deviceName: null };

export interface DownloadFilter {
  project: string | null;
  skillId: string | null;
  userId: string | null;
  source: DownloadSource | null;
}

export const NO_FILTER: DownloadFilter = { project: null, skillId: null, userId: null, source: null };

export type DownloadBreakdown = "version" | "skill" | "project";

export interface DownloadLogRow {
  id: number;
  skill_id: string;
  project: string;
  project_name: string;
  slug: string;
  version: number;
  source: DownloadSource;
  user_id: string | null;
  username: string | null;
  device_name: string | null;
  country: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface DownloadShare {
  key: string;
  label: string;
  count: number;
}

export interface DownloadStats {
  total: number;
  bySource: Record<DownloadSource, number>;
  byDay: Array<{ day: number; count: number }>;
  breakdown: DownloadShare[];
}

export interface FilterNames {
  project: string | null;
  skill: { slug: string; projectName: string } | null;
  user: string | null;
}

export const PRUNE_BATCH = 5000;

export const TOP_SHARES = 10;

function where(table: "l" | "d", filter: DownloadFilter, since: number): { sql: string; params: unknown[] } {
  const clauses = [table === "l" ? "l.created_at >= ?" : "d.day >= ?"];
  const params: unknown[] = [since];
  const add = (clause: string, value: unknown) => {
    clauses.push(clause);
    params.push(value);
  };
  if (filter.project !== null) add(`${table}.skill_id IN (SELECT id FROM skills WHERE project = ?)`, filter.project);
  if (filter.skillId !== null) add(`${table}.skill_id = ?`, filter.skillId);
  if (filter.userId !== null) add(`${table}.user_id = ?`, filter.userId);
  if (filter.source !== null) add(`${table}.source = ?`, filter.source);
  return { sql: clauses.join(" AND "), params };
}

export function recordDownload(
  db: Db,
  input: {
    skillId: string;
    version: number;
    downloader: Downloader;
    country: string | null;
    ip: string | null;
    userAgent: string | null;
    at: number;
  },
): boolean {
  const { downloader } = input;
  const day = Math.floor(input.at / DAY_MS);
  return transaction(db, () => {
    const logged = run(
      db,
      `INSERT INTO download_logs (skill_id, version, source, user_id, username, device_name, country, ip, user_agent, created_at)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM skills WHERE id = ?`,
      input.version, downloader.source, downloader.userId, downloader.username, downloader.deviceName,
      input.country, input.ip, input.userAgent, input.at, input.skillId,
    );
    if (logged === 0) return false;
    run(
      db,
      `INSERT INTO download_days (skill_id, day, version, source, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (skill_id, day, version, source) DO UPDATE SET count = count + 1`,
      input.skillId, day, input.version, downloader.source,
    );
    if (downloader.userId !== null) {
      run(
        db,
        `INSERT INTO download_user_days (user_id, day, skill_id, version, source, count) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (user_id, day, skill_id, version, source) DO UPDATE SET count = count + 1`,
        downloader.userId, day, input.skillId, input.version, downloader.source,
      );
    }
    run(db, "UPDATE skills SET download_count = download_count + 1 WHERE id = ?", input.skillId);
    return true;
  });
}

export function listDownloadLogs(
  db: Db,
  filter: DownloadFilter,
  opts: { since: number; before: number | null; limit: number },
): { rows: DownloadLogRow[]; more: boolean } {
  const { sql, params } = where("l", filter, opts.since);
  const cursor = opts.before === null ? "" : " AND l.id < ?";
  const rows = all<DownloadLogRow>(
    db,
    `SELECT l.id, l.skill_id, s.project, p.name AS project_name, s.slug, l.version, l.source,
            l.user_id, l.username, l.device_name, l.country, l.ip, l.user_agent, l.created_at
     FROM download_logs l
     JOIN skills s ON s.id = l.skill_id
     JOIN projects p ON p.slug = s.project
     WHERE ${sql}${cursor}
     ORDER BY l.id DESC
     LIMIT ?`,
    ...params, ...(opts.before === null ? [] : [opts.before]), opts.limit + 1,
  );
  return { rows: rows.slice(0, opts.limit), more: rows.length > opts.limit };
}

const perSkill = (from: string, sql: string) =>
  `SELECT d.skill_id, SUM(d.count) AS n FROM ${from} d WHERE ${sql} GROUP BY d.skill_id`;

const BREAKDOWNS: Record<DownloadBreakdown, (from: string, sql: string) => string> = {
  version: (from, sql) =>
    `SELECT CAST(d.version AS TEXT) AS "key", CAST(d.version AS TEXT) AS label, SUM(d.count) AS count
     FROM ${from} d WHERE ${sql}
     GROUP BY d.version ORDER BY count DESC, d.version DESC LIMIT ${TOP_SHARES}`,
  skill: (from, sql) =>
    `SELECT s.id AS "key", s.slug AS label, b.n AS count
     FROM (${perSkill(from, sql)}) b JOIN skills s ON s.id = b.skill_id
     ORDER BY count DESC, s.slug LIMIT ${TOP_SHARES}`,
  project: (from, sql) =>
    `SELECT p.slug AS "key", p.name AS label, SUM(b.n) AS count
     FROM (${perSkill(from, sql)}) b JOIN skills s ON s.id = b.skill_id JOIN projects p ON p.slug = s.project
     GROUP BY p.slug ORDER BY count DESC, p.name LIMIT ${TOP_SHARES}`,
};

export function downloadStats(
  db: Db,
  filter: DownloadFilter,
  breakdown: DownloadBreakdown,
  firstDay: number,
): DownloadStats {
  const from = filter.userId === null ? "download_days" : "download_user_days";
  const { sql, params } = where("d", filter, firstDay);
  const days = all<{ day: number; source: DownloadSource; count: number }>(
    db,
    `SELECT d.day AS day, d.source AS source, SUM(d.count) AS count
     FROM ${from} d WHERE ${sql}
     GROUP BY d.day, d.source ORDER BY d.day`,
    ...params,
  );
  const shares = all<DownloadShare>(db, BREAKDOWNS[breakdown](from, sql), ...params);
  const bySource = Object.fromEntries(DOWNLOAD_SOURCES.map((source) => [source, 0])) as Record<DownloadSource, number>;
  const byDay: Array<{ day: number; count: number }> = [];
  for (const row of days) {
    bySource[row.source] += row.count;
    const last = byDay[byDay.length - 1];
    if (last?.day === row.day) last.count += row.count;
    else byDay.push({ day: row.day, count: row.count });
  }
  return {
    total: DOWNLOAD_SOURCES.reduce((sum, source) => sum + bySource[source], 0),
    bySource,
    byDay,
    breakdown: shares,
  };
}

export function filterNames(db: Db, filter: DownloadFilter, within: DownloadFilter, since: number): FilterNames {
  if (filter.project === null && filter.skillId === null && filter.userId === null) {
    return { project: null, skill: null, user: null };
  }
  const scope = where("l", within, since);
  const user =
    filter.userId === null
      ? { sql: "NULL", params: [] }
      : {
          sql: `(SELECT l.username FROM download_logs l WHERE l.user_id = ? AND ${scope.sql} ORDER BY l.id DESC LIMIT 1)`,
          params: [filter.userId, ...scope.params],
        };
  const row = get<{ project: string | null; skill_slug: string | null; skill_project: string | null; username: string | null }>(
    db,
    `SELECT fp.name AS project, s.slug AS skill_slug, sp.name AS skill_project, ${user.sql} AS username
     FROM (SELECT 1)
     LEFT JOIN projects fp ON fp.slug = ?
     LEFT JOIN skills s ON s.id = ? AND s.project = coalesce(?, s.project)
     LEFT JOIN projects sp ON sp.slug = s.project`,
    ...user.params, filter.project, filter.skillId, within.project,
  );
  return {
    project: row?.project ?? null,
    skill: row?.skill_slug && row.skill_project ? { slug: row.skill_slug, projectName: row.skill_project } : null,
    user: row?.username ?? null,
  };
}

export function pruneDownloadDays(db: Db, cutoff: number): void {
  const firstDay = Math.floor(cutoff / DAY_MS);
  transaction(db, () => {
    run(db, "DELETE FROM download_days WHERE day < ?", firstDay);
    run(db, "DELETE FROM download_user_days WHERE day < ?", firstDay);
  });
}

export function pruneDownloadLogBatch(db: Db, cutoff: number): number {
  return run(
    db,
    "DELETE FROM download_logs WHERE id IN (SELECT id FROM download_logs WHERE created_at < ? LIMIT ?)",
    cutoff, PRUNE_BATCH,
  );
}

export function pruneDownloadLogs(db: Db, cutoff: number): number {
  pruneDownloadDays(db, cutoff);
  let deleted = 0;
  for (;;) {
    const changes = pruneDownloadLogBatch(db, cutoff);
    deleted += changes;
    if (changes < PRUNE_BATCH) return deleted;
  }
}
