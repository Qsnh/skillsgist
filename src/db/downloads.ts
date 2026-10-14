import { DAY_MS } from "../retention";

export const DOWNLOAD_SOURCES = ["web", "device", "install_key", "anonymous"] as const;

export type DownloadSource = (typeof DOWNLOAD_SOURCES)[number];

export interface Downloader {
  source: DownloadSource;
  userId: string | null;
  username: string | null;
  deviceName: string | null;
}

export const ANONYMOUS_DOWNLOADER: Downloader = { source: "anonymous", userId: null, username: null, deviceName: null };

export type DownloadScope = { kind: "skill"; skillId: string } | { kind: "project"; project: string } | { kind: "all" };

export interface DownloadFilter {
  project: string | null;
  skillId: string | null;
  userId: string | null;
  source: DownloadSource | null;
}

export const NO_FILTER: DownloadFilter = { project: null, skillId: null, userId: null, source: null };

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

export const PRUNE_BATCH = 1000;

export const TOP_SKILLS = 10;

const FROM = `download_logs l
  JOIN skills s ON s.id = l.skill_id
  JOIN projects p ON p.slug = s.project`;

function where(scope: DownloadScope, filter: DownloadFilter, since: number): { sql: string; binds: unknown[] } {
  const clauses = ["l.created_at >= ?"];
  const binds: unknown[] = [since];
  const add = (clause: string, value: unknown) => {
    clauses.push(clause);
    binds.push(value);
  };
  if (scope.kind === "skill") add("l.skill_id = ?", scope.skillId);
  if (scope.kind === "project") add("s.project = ?", scope.project);
  if (filter.project !== null) add("s.project = ?", filter.project);
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.skillId,
        input.version,
        downloader.source,
        downloader.userId,
        downloader.username,
        downloader.deviceName,
        input.country,
        input.at,
      ),
  ]);
}

export async function listDownloadLogs(
  db: D1Database,
  scope: DownloadScope,
  filter: DownloadFilter,
  opts: { since: number; before: number | null; limit: number },
): Promise<{ rows: DownloadLogRow[]; more: boolean }> {
  const { sql, binds } = where(scope, filter, opts.since);
  const cursor = opts.before === null ? "" : " AND l.id < ?";
  const { results } = await db
    .prepare(
      `SELECT l.id, l.skill_id, s.project, p.name AS project_name, s.slug, l.version, l.source,
              l.user_id, l.username, l.device_name, l.country, l.created_at
       FROM ${FROM}
       WHERE ${sql}${cursor}
       ORDER BY l.id DESC
       LIMIT ?`,
    )
    .bind(...binds, ...(opts.before === null ? [] : [opts.before]), opts.limit + 1)
    .all<DownloadLogRow>();
  return { rows: results.slice(0, opts.limit), more: results.length > opts.limit };
}

function breakdownSql(scope: DownloadScope, sql: string): string {
  switch (scope.kind) {
    case "skill":
      return `SELECT CAST(l.version AS TEXT) AS "key", 'v' || l.version AS label, COUNT(*) AS count
              FROM ${FROM} WHERE ${sql}
              GROUP BY l.version ORDER BY count DESC, l.version DESC`;
    case "project":
      return `SELECT l.skill_id AS "key", s.slug AS label, COUNT(*) AS count
              FROM ${FROM} WHERE ${sql}
              GROUP BY l.skill_id ORDER BY count DESC, s.slug LIMIT ${TOP_SKILLS}`;
    case "all":
      return `SELECT s.project AS "key", p.name AS label, COUNT(*) AS count
              FROM ${FROM} WHERE ${sql}
              GROUP BY s.project ORDER BY count DESC, p.name`;
  }
}

export async function downloadStats(
  db: D1Database,
  scope: DownloadScope,
  filter: DownloadFilter,
  since: number,
): Promise<DownloadStats> {
  const { sql, binds } = where(scope, filter, since);
  const [sources, days, shares] = await db.batch([
    db.prepare(`SELECT l.source AS source, COUNT(*) AS count FROM ${FROM} WHERE ${sql} GROUP BY l.source`).bind(...binds),
    db
      .prepare(`SELECT l.created_at / ${DAY_MS} AS day, COUNT(*) AS count FROM ${FROM} WHERE ${sql} GROUP BY day ORDER BY day`)
      .bind(...binds),
    db.prepare(breakdownSql(scope, sql)).bind(...binds),
  ]);
  const bySource = Object.fromEntries(DOWNLOAD_SOURCES.map((source) => [source, 0])) as Record<DownloadSource, number>;
  for (const row of sources.results as Array<{ source: DownloadSource; count: number }>) bySource[row.source] = row.count;
  return {
    total: DOWNLOAD_SOURCES.reduce((sum, source) => sum + bySource[source], 0),
    bySource,
    byDay: days.results as Array<{ day: number; count: number }>,
    breakdown: shares.results as DownloadShare[],
  };
}

export async function pruneDownloadLogs(db: D1Database, cutoff: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const { meta } = await db
      .prepare(
        "DELETE FROM download_logs WHERE id IN (SELECT id FROM download_logs WHERE created_at < ? ORDER BY id LIMIT ?)",
      )
      .bind(cutoff, PRUNE_BATCH)
      .run();
    deleted += meta.changes;
    if (meta.changes < PRUNE_BATCH) return deleted;
  }
}
