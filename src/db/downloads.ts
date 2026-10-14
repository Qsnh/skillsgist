import { DAY_MS } from "../time";

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

export const PRUNE_BATCH = 1000;

export const PRUNE_MAX_BATCHES = 40;

export const TOP_SHARES = 10;

function where(filter: DownloadFilter, since: number): { sql: string; binds: unknown[] } {
  const clauses = ["l.created_at >= ?"];
  const binds: unknown[] = [since];
  const add = (clause: string, value: unknown) => {
    clauses.push(clause);
    binds.push(value);
  };
  if (filter.project !== null) add("l.skill_id IN (SELECT id FROM skills WHERE project = ?)", filter.project);
  if (filter.skillId !== null) add("l.skill_id = ?", filter.skillId);
  if (filter.userId !== null) add("l.user_id = ?", filter.userId);
  if (filter.source !== null) add("l.source = ?", filter.source);
  return { sql: clauses.join(" AND "), binds };
}

export async function recordDownload(
  db: D1Database,
  input: { skillId: string; version: number; downloader: Downloader; country: string | null; at: number },
): Promise<void> {
  const { downloader } = input;
  await db.batch([
    db.prepare("UPDATE skills SET download_count = download_count + 1 WHERE id = ?").bind(input.skillId),
    db
      .prepare(
        `INSERT INTO download_logs (skill_id, version, source, user_id, username, device_name, country, created_at)
         SELECT id, ?, ?, ?, ?, ?, ?, ? FROM skills WHERE id = ?`,
      )
      .bind(
        input.version,
        downloader.source,
        downloader.userId,
        downloader.username,
        downloader.deviceName,
        input.country,
        input.at,
        input.skillId,
      ),
  ]);
}

export async function listDownloadLogs(
  db: D1Database,
  filter: DownloadFilter,
  opts: { since: number; before: number | null; limit: number },
): Promise<{ rows: DownloadLogRow[]; more: boolean }> {
  const { sql, binds } = where(filter, opts.since);
  const cursor = opts.before === null ? "" : " AND l.id < ?";
  const { results } = await db
    .prepare(
      `SELECT l.id, l.skill_id, s.project, p.name AS project_name, s.slug, l.version, l.source,
              l.user_id, l.username, l.device_name, l.country, l.created_at
       FROM download_logs l
       JOIN skills s ON s.id = l.skill_id
       JOIN projects p ON p.slug = s.project
       WHERE l.id IN (SELECT l.id FROM download_logs l WHERE ${sql}${cursor} ORDER BY l.id DESC LIMIT ?)
       ORDER BY l.id DESC`,
    )
    .bind(...binds, ...(opts.before === null ? [] : [opts.before]), opts.limit + 1)
    .all<DownloadLogRow>();
  return { rows: results.slice(0, opts.limit), more: results.length > opts.limit };
}

const perSkill = (sql: string) => `SELECT l.skill_id, COUNT(*) AS n FROM download_logs l WHERE ${sql} GROUP BY l.skill_id`;

const BREAKDOWNS: Record<DownloadBreakdown, (sql: string) => string> = {
  version: (sql) =>
    `SELECT CAST(l.version AS TEXT) AS "key", CAST(l.version AS TEXT) AS label, COUNT(*) AS count
     FROM download_logs l WHERE ${sql}
     GROUP BY l.version ORDER BY count DESC, l.version DESC LIMIT ${TOP_SHARES}`,
  skill: (sql) =>
    `SELECT s.id AS "key", s.slug AS label, b.n AS count
     FROM (${perSkill(sql)}) b JOIN skills s ON s.id = b.skill_id
     ORDER BY count DESC, s.slug LIMIT ${TOP_SHARES}`,
  project: (sql) =>
    `SELECT p.slug AS "key", p.name AS label, SUM(b.n) AS count
     FROM (${perSkill(sql)}) b JOIN skills s ON s.id = b.skill_id JOIN projects p ON p.slug = s.project
     GROUP BY p.slug ORDER BY count DESC, p.name LIMIT ${TOP_SHARES}`,
};

export async function downloadStats(
  db: D1Database,
  filter: DownloadFilter,
  breakdown: DownloadBreakdown,
  since: number,
): Promise<DownloadStats> {
  const { sql, binds } = where(filter, since);
  const [days, shares] = await db.batch([
    db
      .prepare(
        `SELECT l.created_at / ${DAY_MS} AS day, l.source AS source, COUNT(*) AS count
         FROM download_logs l WHERE ${sql}
         GROUP BY day, l.source ORDER BY day`,
      )
      .bind(...binds),
    db.prepare(BREAKDOWNS[breakdown](sql)).bind(...binds),
  ]);
  const bySource = Object.fromEntries(DOWNLOAD_SOURCES.map((source) => [source, 0])) as Record<DownloadSource, number>;
  const byDay: Array<{ day: number; count: number }> = [];
  for (const row of days.results as Array<{ day: number; source: DownloadSource; count: number }>) {
    bySource[row.source] += row.count;
    const last = byDay[byDay.length - 1];
    if (last?.day === row.day) last.count += row.count;
    else byDay.push({ day: row.day, count: row.count });
  }
  return {
    total: DOWNLOAD_SOURCES.reduce((sum, source) => sum + bySource[source], 0),
    bySource,
    byDay,
    breakdown: shares.results as DownloadShare[],
  };
}

export async function filterNames(
  db: D1Database,
  filter: DownloadFilter,
  within: DownloadFilter,
  since: number,
): Promise<FilterNames> {
  if (filter.project === null && filter.skillId === null && filter.userId === null) {
    return { project: null, skill: null, user: null };
  }
  const scope = where(within, since);
  const user =
    filter.userId === null
      ? { sql: "NULL", binds: [] }
      : {
          sql: `(SELECT l.username FROM download_logs l WHERE l.user_id = ? AND ${scope.sql} ORDER BY l.id DESC LIMIT 1)`,
          binds: [filter.userId, ...scope.binds],
        };
  const row = await db
    .prepare(
      `SELECT fp.name AS project, s.slug AS skill_slug, sp.name AS skill_project, ${user.sql} AS username
       FROM (SELECT 1)
       LEFT JOIN projects fp ON fp.slug = ?
       LEFT JOIN skills s ON s.id = ? AND s.project = coalesce(?, s.project)
       LEFT JOIN projects sp ON sp.slug = s.project`,
    )
    .bind(...user.binds, filter.project, filter.skillId, within.project)
    .first<{ project: string | null; skill_slug: string | null; skill_project: string | null; username: string | null }>();
  return {
    project: row?.project ?? null,
    skill: row?.skill_slug && row.skill_project ? { slug: row.skill_slug, projectName: row.skill_project } : null,
    user: row?.username ?? null,
  };
}

export async function pruneDownloadLogs(db: D1Database, cutoff: number): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const { meta } = await db
      .prepare(
        "DELETE FROM download_logs WHERE id IN (SELECT id FROM download_logs ORDER BY id LIMIT ?) AND created_at < ?",
      )
      .bind(PRUNE_BATCH, cutoff)
      .run();
    deleted += meta.changes;
    if (meta.changes < PRUNE_BATCH) break;
  }
  return deleted;
}
