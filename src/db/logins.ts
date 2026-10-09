import { CODE_ATTEMPT_LIMIT, CODE_LOCK_MS, DEVICE_CODE_TTL_S, loginIdleCutoff, POLL_INTERVAL_S } from "../credentials";

export type LoginStatus = "pending" | "approved" | "denied" | "active";

export interface CliLoginRow {
  id: string;
  user_code: string | null;
  device_code_hash: string | null;
  token_hash: string | null;
  status: LoginStatus;
  user_id: string | null;
  device_name: string;
  request_country: string | null;
  requested_scope: string | null;
  poll_interval: number;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  last_used_at: number | null;
}

export interface LoginAccess {
  id: string;
  user_id: string;
  username: string;
  last_used_at: number | null;
  granted: string[];
}

export interface CliLoginSummary {
  id: string;
  device_name: string;
  request_country: string | null;
  approved_at: number | null;
  last_used_at: number | null;
  projects: string[];
}

export async function createPendingLogin(
  db: D1Database,
  input: {
    id: string;
    userCode: string;
    deviceCodeHash: string;
    deviceName: string;
    country: string | null;
    requestedScope: string | null;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO cli_logins (id, user_code, device_code_hash, status, device_name, request_country, requested_scope, poll_interval, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.id, input.userCode, input.deviceCodeHash, input.deviceName, input.country, input.requestedScope,
      POLL_INTERVAL_S, input.now, input.now + DEVICE_CODE_TTL_S * 1000,
    )
    .run();
  return result.meta.changes === 1;
}

export async function deleteStaleLogins(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM cli_logins WHERE status IN ('pending', 'approved', 'denied') AND expires_at <= ?").bind(now),
    db.prepare("DELETE FROM cli_logins WHERE status = 'active' AND last_used_at <= ?").bind(loginIdleCutoff(now)),
  ]);
}

export function getLoginByUserCode(db: D1Database, userCode: string): Promise<CliLoginRow | null> {
  return db.prepare("SELECT * FROM cli_logins WHERE user_code = ?").bind(userCode).first<CliLoginRow>();
}

export function getLoginByDeviceCodeHash(db: D1Database, hash: string): Promise<CliLoginRow | null> {
  return db.prepare("SELECT * FROM cli_logins WHERE device_code_hash = ?").bind(hash).first<CliLoginRow>();
}

export async function approveLogin(
  db: D1Database,
  id: string,
  userId: string,
  projects: string[],
  now: number,
): Promise<boolean> {
  const grants = [...new Set(projects)].map((project) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO cli_login_projects (login_id, project, user_id)
         SELECT ?1, ?2, ?4
         WHERE EXISTS (SELECT 1 FROM cli_logins WHERE id = ?1 AND status = 'pending' AND expires_at > ?3)
           AND EXISTS (SELECT 1 FROM memberships WHERE project = ?2 AND user_id = ?4)`,
      )
      .bind(id, project, now, userId),
  );
  const results = await db.batch([
    ...grants,
    db
      .prepare(
        `UPDATE cli_logins SET status = 'approved', user_id = ?2, requested_scope = NULL, approved_at = ?3
         WHERE id = ?1 AND status = 'pending' AND expires_at > ?3`,
      )
      .bind(id, userId, now),
  ]);
  return results[results.length - 1].meta.changes === 1;
}

export async function denyLogin(db: D1Database, id: string, userId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cli_logins SET status = 'denied', user_id = ?2, requested_scope = NULL
       WHERE id = ?1 AND status = 'pending' AND expires_at > ?3`,
    )
    .bind(id, userId, now)
    .run();
  return result.meta.changes === 1;
}

export async function getDecidedLogin(
  db: D1Database,
  id: string,
  userId: string,
): Promise<{ status: LoginStatus; projects: string[] } | null> {
  const [login, grants] = await db.batch([
    db.prepare("SELECT status FROM cli_logins WHERE id = ? AND user_id = ?").bind(id, userId),
    db
      .prepare(
        `SELECT p.name FROM cli_login_projects clp
         JOIN projects p ON p.slug = clp.project
         WHERE clp.login_id = ?1 AND clp.user_id = ?2
         ORDER BY p.name`,
      )
      .bind(id, userId),
  ]);
  const row = login.results[0] as { status: LoginStatus } | undefined;
  if (!row) return null;
  return { status: row.status, projects: (grants.results as Array<{ name: string }>).map((g) => g.name) };
}

export async function recordPoll(db: D1Database, id: string, at: number, interval: number): Promise<void> {
  await db.prepare("UPDATE cli_logins SET last_polled_at = ?, poll_interval = ? WHERE id = ?").bind(at, interval, id).run();
}

export async function activateLogin(db: D1Database, id: string, tokenHash: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cli_logins SET status = 'active', token_hash = ?, device_code_hash = NULL, last_used_at = ?
       WHERE id = ? AND status = 'approved' AND expires_at > ?`,
    )
    .bind(tokenHash, now, id, now)
    .run();
  return result.meta.changes === 1;
}

export async function loginProjects(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT project FROM cli_login_projects WHERE login_id = ? ORDER BY project")
    .bind(id)
    .all<{ project: string }>();
  return results.map((r) => r.project);
}

export async function deleteLogin(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM cli_logins WHERE id = ?").bind(id).run();
}

export async function deleteLoginByTokenHash(db: D1Database, hash: string): Promise<void> {
  await db.prepare("DELETE FROM cli_logins WHERE token_hash = ?").bind(hash).run();
}

export async function deleteUserLogin(db: D1Database, userId: string, id: string): Promise<string | null> {
  const row = await db
    .prepare("DELETE FROM cli_logins WHERE id = ? AND user_id = ? AND status = 'active' RETURNING device_name")
    .bind(id, userId)
    .first<{ device_name: string }>();
  return row ? row.device_name : null;
}

export async function loginAccessByTokenHash(db: D1Database, hash: string): Promise<LoginAccess | null> {
  const row = await db
    .prepare(
      `SELECT l.id, l.user_id, l.last_used_at, u.username,
              (SELECT json_group_array(clp.project) FROM cli_login_projects clp WHERE clp.login_id = l.id) AS granted
       FROM cli_logins l JOIN users u ON u.id = l.user_id
       WHERE l.token_hash = ? AND l.status = 'active'`,
    )
    .bind(hash)
    .first<Omit<LoginAccess, "granted"> & { granted: string }>();
  if (!row) return null;
  return { ...row, granted: (JSON.parse(row.granted) as string[]).sort() };
}

export async function markLoginUsed(db: D1Database, id: string, at: number): Promise<void> {
  await db.prepare("UPDATE cli_logins SET last_used_at = ? WHERE id = ?").bind(at, id).run();
}

export async function listUserLogins(db: D1Database, userId: string): Promise<CliLoginSummary[]> {
  const [logins, grants] = await db.batch([
    db
      .prepare(
        `SELECT id, device_name, request_country, approved_at, last_used_at FROM cli_logins
         WHERE user_id = ? AND status = 'active'
         ORDER BY approved_at DESC, id`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT clp.login_id, p.name FROM cli_login_projects clp
         JOIN cli_logins l ON l.id = clp.login_id
         JOIN projects p ON p.slug = clp.project
         WHERE clp.user_id = ? AND l.status = 'active'
         ORDER BY p.name`,
      )
      .bind(userId),
  ]);
  const names = grants.results as Array<{ login_id: string; name: string }>;
  return (logins.results as Array<Omit<CliLoginSummary, "projects">>).map((login) => ({
    ...login,
    projects: names.filter((g) => g.login_id === login.id).map((g) => g.name),
  }));
}

export async function recordCodeFailure(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_code_attempts (user_id, failures, window_started_at) VALUES (?1, 1, ?2)
       ON CONFLICT(user_id) DO UPDATE SET
         failures = CASE WHEN window_started_at > ?2 - ?3 THEN failures + 1 ELSE 1 END,
         window_started_at = CASE WHEN window_started_at > ?2 - ?3 THEN window_started_at ELSE ?2 END`,
    )
    .bind(userId, now, CODE_LOCK_MS)
    .run();
}

export async function codeEntryLocked(db: D1Database, userId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT failures, window_started_at FROM device_code_attempts WHERE user_id = ?")
    .bind(userId)
    .first<{ failures: number; window_started_at: number }>();
  return row !== null && row.failures >= CODE_ATTEMPT_LIMIT && row.window_started_at > now - CODE_LOCK_MS;
}
