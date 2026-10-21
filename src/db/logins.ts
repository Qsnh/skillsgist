import { CODE_ATTEMPT_LIMIT, CODE_LOCK_MS, DEVICE_CODE_TTL_S, loginIdleCutoff, POLL_INTERVAL_S } from "../credentials";
import { all, get, run, transaction } from "./database";
import type { Db } from "./database";

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
  device_name: string;
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

export function createPendingLogin(
  db: Db,
  input: {
    id: string;
    userCode: string;
    deviceCodeHash: string;
    deviceName: string;
    country: string | null;
    requestedScope: string | null;
    now: number;
  },
): boolean {
  const changes = run(
    db,
    `INSERT INTO cli_logins (id, user_code, device_code_hash, status, device_name, request_country, requested_scope, poll_interval, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    input.id, input.userCode, input.deviceCodeHash, input.deviceName, input.country, input.requestedScope,
    POLL_INTERVAL_S, input.now, input.now + DEVICE_CODE_TTL_S * 1000,
  );
  return changes === 1;
}

export function deleteStaleLogins(db: Db, now: number): number {
  return transaction(
    db,
    () =>
      run(db, "DELETE FROM cli_logins WHERE status IN ('pending', 'approved', 'denied') AND expires_at <= ?", now) +
      run(db, "DELETE FROM cli_logins WHERE status = 'active' AND last_used_at <= ?", loginIdleCutoff(now)),
  );
}

export function getLoginByUserCode(db: Db, userCode: string): CliLoginRow | null {
  return get<CliLoginRow>(db, "SELECT * FROM cli_logins WHERE user_code = ?", userCode);
}

export function getLoginByDeviceCodeHash(db: Db, hash: string): CliLoginRow | null {
  return get<CliLoginRow>(db, "SELECT * FROM cli_logins WHERE device_code_hash = ?", hash);
}

export function approveLogin(db: Db, id: string, userId: string, projects: string[], now: number): boolean {
  return transaction(db, () => {
    const pending = get(db, "SELECT 1 AS found FROM cli_logins WHERE id = ? AND status = 'pending' AND expires_at > ?", id, now);
    if (!pending) return false;
    run(
      db,
      `INSERT OR IGNORE INTO cli_login_projects (login_id, project, user_id)
       SELECT @id, m.project, m.user_id FROM memberships m
       WHERE m.user_id = @userId AND m.project IN (SELECT value FROM json_each(@projects))`,
      { id, userId, projects: JSON.stringify(projects) },
    );
    return (
      run(
        db,
        `UPDATE cli_logins SET status = 'approved', user_id = @userId, requested_scope = NULL, approved_at = @now
         WHERE id = @id AND EXISTS (SELECT 1 FROM cli_login_projects WHERE login_id = @id AND user_id = @userId)`,
        { id, userId, now },
      ) === 1
    );
  });
}

export function denyLogin(db: Db, id: string, userId: string, now: number): boolean {
  return (
    run(
      db,
      `UPDATE cli_logins SET status = 'denied', user_id = ?, requested_scope = NULL
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      userId, id, now,
    ) === 1
  );
}

export function getDecidedLogin(db: Db, id: string, userId: string): { status: LoginStatus; projects: string[] } | null {
  const row = get<{ status: LoginStatus }>(db, "SELECT status FROM cli_logins WHERE id = ? AND user_id = ?", id, userId);
  if (!row) return null;
  const grants = all<{ name: string }>(
    db,
    `SELECT p.name FROM cli_login_projects clp
     JOIN projects p ON p.slug = clp.project
     WHERE clp.login_id = ? AND clp.user_id = ?
     ORDER BY p.name`,
    id, userId,
  );
  return { status: row.status, projects: grants.map((g) => g.name) };
}

export function recordPoll(db: Db, id: string, at: number, interval: number): void {
  run(db, "UPDATE cli_logins SET last_polled_at = ?, poll_interval = ? WHERE id = ?", at, interval, id);
}

export function activateLogin(db: Db, id: string, tokenHash: string, now: number): boolean {
  return (
    run(
      db,
      `UPDATE cli_logins SET status = 'active', token_hash = ?, user_code = NULL, device_code_hash = NULL, last_used_at = ?
       WHERE id = ? AND status = 'approved' AND expires_at > ?`,
      tokenHash, now, id, now,
    ) === 1
  );
}

export function loginProjects(db: Db, id: string): string[] {
  return all<{ project: string }>(db, "SELECT project FROM cli_login_projects WHERE login_id = ? ORDER BY project", id).map(
    (r) => r.project,
  );
}

export function deleteLogin(db: Db, id: string): void {
  run(db, "DELETE FROM cli_logins WHERE id = ?", id);
}

export function deleteLoginByTokenHash(db: Db, hash: string): void {
  run(db, "DELETE FROM cli_logins WHERE token_hash = ?", hash);
}

export function deleteUserLogin(
  db: Db,
  userId: string,
  id: string,
): { device_name: string; last_used_at: number | null } | null {
  return get(
    db,
    "DELETE FROM cli_logins WHERE id = ? AND user_id = ? AND status = 'active' RETURNING device_name, last_used_at",
    id, userId,
  );
}

export function loginAccessByTokenHash(db: Db, hash: string): LoginAccess | null {
  const row = get<Omit<LoginAccess, "granted"> & { granted: string }>(
    db,
    `SELECT l.id, l.user_id, l.device_name, l.last_used_at, u.username,
            (SELECT json_group_array(clp.project) FROM cli_login_projects clp WHERE clp.login_id = l.id) AS granted
     FROM cli_logins l JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = ? AND l.status = 'active'`,
    hash,
  );
  if (!row) return null;
  return { ...row, granted: (JSON.parse(row.granted) as string[]).sort() };
}

export function markLoginUsed(db: Db, id: string, at: number): void {
  run(db, "UPDATE cli_logins SET last_used_at = ? WHERE id = ?", at, id);
}

export function listUserLogins(db: Db, userId: string): CliLoginSummary[] {
  const logins = all<Omit<CliLoginSummary, "projects">>(
    db,
    `SELECT id, device_name, request_country, approved_at, last_used_at FROM cli_logins
     WHERE user_id = ? AND status = 'active'
     ORDER BY approved_at DESC, id`,
    userId,
  );
  const names = all<{ login_id: string; name: string }>(
    db,
    `SELECT clp.login_id, p.name FROM cli_login_projects clp
     JOIN cli_logins l ON l.id = clp.login_id
     JOIN projects p ON p.slug = clp.project
     WHERE clp.user_id = ? AND l.status = 'active'
     ORDER BY p.name`,
    userId,
  );
  return logins.map((login) => ({
    ...login,
    projects: names.filter((g) => g.login_id === login.id).map((g) => g.name),
  }));
}

export function claimCodeAttempt(db: Db, userId: string, now: number): boolean {
  const row = get(
    db,
    `INSERT INTO device_code_attempts (user_id, failures, window_started_at) VALUES (@userId, 1, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       failures = CASE WHEN window_started_at > @now - @lockMs THEN failures + 1 ELSE 1 END,
       window_started_at = CASE WHEN window_started_at > @now - @lockMs THEN window_started_at ELSE @now END
     WHERE window_started_at <= @now - @lockMs OR failures < @limit
     RETURNING failures`,
    { userId, now, lockMs: CODE_LOCK_MS, limit: CODE_ATTEMPT_LIMIT },
  );
  return row !== null;
}

export function refundCodeAttempt(db: Db, userId: string): void {
  run(db, "UPDATE device_code_attempts SET failures = failures - 1 WHERE user_id = ? AND failures > 0", userId);
}
