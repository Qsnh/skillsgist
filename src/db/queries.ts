import { all, get, run, transaction } from "./database";
import type { Db } from "./database";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin" | "member";
  api_token_hash: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface ProjectRow {
  slug: string;
  name: string;
  created_at: number;
}

export interface MembershipRow {
  project: string;
  user_id: string;
  role: "admin" | "member";
  install_key: string;
  created_at: number;
  can_publish: number;
}

export type Membership = MembershipRow & { project_name: string };

export interface Viewer extends UserRow {
  memberships: Membership[];
}

export const DEFAULT_PROJECT = "default";

export interface SkillRow {
  id: string;
  project: string;
  slug: string;
  description: string;
  visibility: "public" | "private";
  owner_id: string;
  latest_version: number;
  download_count: number;
  created_at: number;
  updated_at: number;
}

export type ListedSkill = SkillRow & { author: string; project_name: string };

export interface VersionRow {
  skill_id: string;
  slug: string;
  version: number;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  html_rev: number;
  files: string;
  object_key: string;
  author_id: string;
  created_at: number;
}

export type VersionSummary = Pick<VersionRow, "version" | "created_at">;

export interface ArtifactRef {
  skill_id: string;
  project: string;
  slug: string;
  version: number;
  visibility: "public" | "private";
  object_key: string;
}

export interface InsertVersionInput {
  skillId: string;
  project: string;
  slug: string;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  html_rev: number;
  files: string;
  authorId: string;
  visibility: "public" | "private";
}

export type SkillScope = { kind: "public" } | { kind: "all" } | { kind: "member"; userId: string };

export type IndexFilter = { kind: "root" } | { kind: "project"; project: string; publicOnly: boolean };

export function countUsers(db: Db): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users")?.n ?? 0;
}

export function createUser(
  db: Db,
  input: { id: string; username: string; passwordHash: string; role: "admin" | "member" },
): void {
  run(
    db,
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    input.id, input.username, input.passwordHash, input.role, Date.now(),
  );
}

export function createFirstAdmin(
  db: Db,
  input: { id: string; username: string; passwordHash: string; installKey: string },
): boolean {
  const now = Date.now();
  return transaction(db, () => {
    if (countUsers(db) > 0) return false;
    run(
      db,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      input.id, input.username, input.passwordHash, now,
    );
    run(
      db,
      `INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at)
       SELECT slug, ?, 'member', ?, 1, ? FROM projects WHERE slug = ?`,
      input.id, input.installKey, now, DEFAULT_PROJECT,
    );
    return true;
  });
}

export function getUserByUsername(db: Db, username: string): UserRow | null {
  return get<UserRow>(db, "SELECT * FROM users WHERE username = ?", username);
}

export function getUserById(db: Db, id: string): UserRow | null {
  return get<UserRow>(db, "SELECT * FROM users WHERE id = ?", id);
}

export type UserSummary = Pick<UserRow, "id" | "username" | "role" | "api_token_hash" | "created_at" | "last_login_at"> & {
  projects: number;
  skills: number;
  cli_logins: number;
};

const USER_SUMMARY_SQL = `SELECT u.id, u.username, u.role, u.api_token_hash, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS projects,
         (SELECT COUNT(*) FROM skills s WHERE s.owner_id = u.id) AS skills,
         (SELECT COUNT(*) FROM cli_logins l WHERE l.user_id = u.id AND l.status = 'active' AND l.last_used_at > @usedAfter) AS cli_logins
  FROM users u`;

export function listUserSummaries(db: Db, loginsUsedAfter: number): UserSummary[] {
  return all<UserSummary>(db, `${USER_SUMMARY_SQL} ORDER BY u.created_at, u.username`, { usedAfter: loginsUsedAfter });
}

export function getUserSummary(db: Db, id: string, loginsUsedAfter: number): UserSummary | null {
  return get<UserSummary>(db, `${USER_SUMMARY_SQL} WHERE u.id = @id`, { usedAfter: loginsUsedAfter, id });
}

export function countAdmins(db: Db): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0;
}

export function updateUserRole(db: Db, userId: string, role: "admin" | "member"): void {
  run(db, "UPDATE users SET role = ? WHERE id = ?", role, userId);
}

export function deleteUserReassigning(db: Db, userId: string, reassignTo: string): void {
  if (userId === reassignTo) {
    throw new Error("deleteUserReassigning: cannot reassign a user's rows to itself");
  }
  transaction(db, () => {
    run(db, "UPDATE skills SET owner_id = ? WHERE owner_id = ?", reassignTo, userId);
    run(db, "UPDATE versions SET author_id = ? WHERE author_id = ?", reassignTo, userId);
    run(db, "DELETE FROM users WHERE id = ?", userId);
  });
}

function viewerWhere(db: Db, column: "id" | "api_token_hash", value: string): Viewer | null {
  const user = get<UserRow>(db, `SELECT * FROM users WHERE ${column} = ?`, value);
  if (!user) return null;
  const memberships = all<Membership>(
    db,
    `SELECT m.*, p.name AS project_name
     FROM memberships m
     JOIN projects p ON p.slug = m.project
     WHERE m.user_id = ?
     ORDER BY p.name`,
    user.id,
  );
  return { ...user, memberships };
}

export function getViewer(db: Db, userId: string): Viewer | null {
  return viewerWhere(db, "id", userId);
}

export function getViewerByApiTokenHash(db: Db, hash: string): Viewer | null {
  return viewerWhere(db, "api_token_hash", hash);
}

export function createProject(db: Db, input: { slug: string; name: string }): void {
  run(db, "INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)", input.slug, input.name, Date.now());
}

export function getProject(db: Db, slug: string): ProjectRow | null {
  return get<ProjectRow>(db, "SELECT * FROM projects WHERE slug = ?", slug);
}

export function listProjects(db: Db): ProjectRow[] {
  return all<ProjectRow>(db, "SELECT * FROM projects ORDER BY name");
}

export function addMembership(
  db: Db,
  input: { project: string; userId: string; role: "admin" | "member"; installKey: string; canPublish?: boolean },
): void {
  run(
    db,
    "INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    input.project, input.userId, input.role, input.installKey, input.canPublish ? 1 : 0, Date.now(),
  );
}

export function updateInstallKey(db: Db, project: string, userId: string, key: string): void {
  run(db, "UPDATE memberships SET install_key = ? WHERE project = ? AND user_id = ?", key, project, userId);
}

const deleteUserLogins = (db: Db, userId: string) => run(db, "DELETE FROM cli_logins WHERE user_id = ?", userId);

export function rotateInstallKeys(db: Db, userId: string, nextKey: () => string): void {
  transaction(db, () => {
    for (const { project } of all<{ project: string }>(db, "SELECT project FROM memberships WHERE user_id = ?", userId)) {
      updateInstallKey(db, project, userId, nextKey());
    }
    deleteUserLogins(db, userId);
  });
}

const LISTED_SKILL_SQL = `SELECT s.*, u.username AS author, p.name AS project_name
  FROM skills s
  JOIN users u ON u.id = s.owner_id
  JOIN projects p ON p.slug = s.project`;

export function listSkills(db: Db, opts: { scope: SkillScope; project?: string; q?: string }): ListedSkill[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.scope.kind === "public") clauses.push("s.visibility = 'public'");
  if (opts.scope.kind === "member") {
    params.userId = opts.scope.userId;
    clauses.push(
      "(s.visibility = 'public' OR EXISTS (SELECT 1 FROM memberships m WHERE m.project = s.project AND m.user_id = @userId))",
    );
  }
  if (opts.project !== undefined) {
    params.project = opts.project;
    clauses.push("s.project = @project");
  }
  if (opts.q) {
    params.pattern = `%${opts.q}%`;
    clauses.push(
      "(s.slug LIKE @pattern OR s.description LIKE @pattern OR EXISTS (SELECT 1 FROM versions v WHERE v.skill_id = s.id AND v.version = s.latest_version AND v.skill_md LIKE @pattern))",
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return all<ListedSkill>(db, `${LISTED_SKILL_SQL} ${where} ORDER BY s.updated_at DESC`, params);
}

export function getSkill(db: Db, project: string, slug: string): SkillRow | null {
  return get<SkillRow>(db, "SELECT * FROM skills WHERE project = ? AND slug = ?", project, slug);
}

export function getSkillWithAuthor(db: Db, project: string, slug: string): ListedSkill | null {
  return get<ListedSkill>(db, `${LISTED_SKILL_SQL} WHERE s.project = ? AND s.slug = ?`, project, slug);
}

const SKILL_ID_SQL = "(SELECT id FROM skills WHERE project = ? AND slug = ?)";

export function updateVersionHtml(
  db: Db,
  project: string,
  slug: string,
  version: number,
  html: string,
  rev: number,
): void {
  run(
    db,
    `UPDATE versions SET html = ?, html_rev = ? WHERE skill_id = ${SKILL_ID_SQL} AND version = ?`,
    html, rev, project, slug, version,
  );
}

export function getVersion(db: Db, project: string, slug: string, version: number): VersionRow | null {
  return get<VersionRow>(
    db,
    `SELECT v.*, s.slug FROM versions v JOIN skills s ON s.id = v.skill_id
     WHERE s.project = ? AND s.slug = ? AND v.version = ?`,
    project, slug, version,
  );
}

export function listVersions(db: Db, project: string, slug: string): VersionSummary[] {
  return all<VersionSummary>(
    db,
    `SELECT v.version, v.created_at FROM versions v JOIN skills s ON s.id = v.skill_id
     WHERE s.project = ? AND s.slug = ? ORDER BY v.version DESC`,
    project, slug,
  );
}

export function listPublishedForIndex(
  db: Db,
  filter: IndexFilter,
  slug: string | null = null,
): Array<{ slug: string; description: string; digest: string }> {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.kind === "root") {
    clauses.push(
      "s.visibility = 'public'",
      "NOT EXISTS (SELECT 1 FROM skills o WHERE o.slug = s.slug AND o.id <> s.id AND o.visibility = 'public')",
    );
  } else {
    params.project = filter.project;
    clauses.push("s.project = @project");
    if (filter.publicOnly) clauses.push("s.visibility = 'public'");
  }
  if (slug !== null) {
    params.slug = slug;
    clauses.push("s.slug = @slug");
  }
  return all(
    db,
    `SELECT s.slug, v.description, v.digest
     FROM skills s
     JOIN versions v ON v.skill_id = s.id AND v.version = s.latest_version
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.slug`,
    params,
  );
}

export const objectKeyFor = (skillId: string, digest: string) => `skills/${skillId}/${digest.replace(/^sha256:/, "")}.zip`;

export function insertVersion(db: Db, input: InsertVersionInput & { objectKey: string }): number {
  const now = Date.now();
  return transaction(db, () => {
    const version =
      get<{ n: number }>(db, "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM versions WHERE skill_id = ?", input.skillId)?.n ?? 1;
    run(
      db,
      `INSERT INTO skills (id, project, slug, description, visibility, owner_id, latest_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description,
                                     latest_version = excluded.latest_version,
                                     updated_at = excluded.updated_at`,
      input.skillId, input.project, input.slug, input.description, input.visibility, input.authorId,
      version, now, now,
    );
    run(
      db,
      `INSERT INTO versions (skill_id, version, digest, size, name, description, skill_md, html, html_rev, files, object_key, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.skillId, version, input.digest, input.size, input.name, input.description,
      input.skill_md, input.html, input.html_rev, input.files, input.objectKey, input.authorId, now,
    );
    return version;
  });
}

export function setVisibility(db: Db, project: string, slug: string, visibility: "public" | "private"): void {
  run(db, "UPDATE skills SET visibility = ?, updated_at = ? WHERE project = ? AND slug = ?", visibility, Date.now(), project, slug);
}

export function deleteSkill(db: Db, project: string, slug: string): string[] {
  return transaction(db, () => {
    const keys = all<{ object_key: string }>(
      db,
      `SELECT DISTINCT object_key FROM versions WHERE skill_id = ${SKILL_ID_SQL}`,
      project, slug,
    );
    run(db, "DELETE FROM skills WHERE project = ? AND slug = ?", project, slug);
    return keys.map((r) => r.object_key);
  });
}

export function updateApiTokenHash(db: Db, userId: string, hash: string | null): void {
  run(db, "UPDATE users SET api_token_hash = ? WHERE id = ?", hash, userId);
}

export function updatePassword(db: Db, userId: string, hash: string): void {
  transaction(db, () => {
    run(db, "UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
    deleteUserLogins(db, userId);
  });
}

export function touchLogin(db: Db, userId: string, at: number): void {
  run(db, "UPDATE users SET last_login_at = ? WHERE id = ?", at, userId);
}

const ARTIFACT_SQL =
  "SELECT s.id AS skill_id, s.project, s.slug, v.version, s.visibility, v.object_key FROM skills s JOIN versions v ON v.skill_id = s.id";

export function getArtifactByVersion(db: Db, project: string, slug: string, version: number | null): ArtifactRef | null {
  return get<ArtifactRef>(
    db,
    `${ARTIFACT_SQL} WHERE s.project = ? AND s.slug = ? AND v.version = COALESCE(?, s.latest_version)`,
    project, slug, version,
  );
}

export function getArtifactByDigest(db: Db, project: string, slug: string, digest: string): ArtifactRef | null {
  return get<ArtifactRef>(db, `${ARTIFACT_SQL} WHERE s.project = ? AND s.slug = ? AND v.digest = ?`, project, slug, digest);
}

export function getPublicArtifact(db: Db, slug: string, digest: string): ArtifactRef | null {
  return get<ArtifactRef>(
    db,
    `${ARTIFACT_SQL} WHERE s.slug = ? AND s.visibility = 'public' AND v.digest = ? ORDER BY s.created_at, s.id LIMIT 1`,
    slug, digest,
  );
}

export interface ProjectSummary extends ProjectRow {
  skills: number;
  members: number;
  role: "admin" | "member" | null;
}

export function listProjectSummaries(db: Db, userId: string, everything: boolean): ProjectSummary[] {
  const where = everything ? "" : "WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.project = p.slug AND m.user_id = @userId)";
  return all<ProjectSummary>(
    db,
    `SELECT p.slug, p.name, p.created_at,
            (SELECT COUNT(*) FROM skills s WHERE s.project = p.slug) AS skills,
            (SELECT COUNT(*) FROM memberships m WHERE m.project = p.slug) AS members,
            (SELECT m.role FROM memberships m WHERE m.project = p.slug AND m.user_id = @userId) AS role
     FROM projects p ${where}
     ORDER BY p.name`,
    { userId },
  );
}

export function projectNameTaken(db: Db, name: string, except: string | null): boolean {
  return (
    get(db, "SELECT 1 AS taken FROM projects WHERE name = @name AND (@except IS NULL OR slug <> @except)", { name, except }) !==
    null
  );
}

export function renameProject(db: Db, slug: string, name: string): void {
  run(db, "UPDATE projects SET name = ? WHERE slug = ?", name, slug);
}

export function deleteProject(db: Db, slug: string): boolean {
  return (
    run(db, "DELETE FROM projects WHERE slug = @slug AND NOT EXISTS (SELECT 1 FROM skills WHERE project = @slug)", { slug }) === 1
  );
}

export type Member = Pick<MembershipRow, "user_id" | "role" | "can_publish"> & {
  username: string;
  account_role: UserRow["role"];
};

const MEMBER_SQL = `SELECT m.user_id, m.role, m.can_publish, u.username, u.role AS account_role
  FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project = ?`;

export function listMembers(db: Db, project: string): Member[] {
  return all<Member>(db, `${MEMBER_SQL} ORDER BY u.username`, project);
}

export function getMember(db: Db, project: string, userId: string): Member | null {
  return get<Member>(db, `${MEMBER_SQL} AND m.user_id = ?`, project, userId);
}

export function listNonMembers(db: Db, project: string): Array<Pick<UserRow, "id" | "username">> {
  return all(
    db,
    `SELECT u.id, u.username FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.project = ? AND m.user_id = u.id)
     ORDER BY u.username`,
    project,
  );
}

export function updateMembershipRole(db: Db, project: string, userId: string, role: "admin" | "member"): void {
  run(db, "UPDATE memberships SET role = ? WHERE project = ? AND user_id = ?", role, project, userId);
}

export function updateMembershipPublish(db: Db, project: string, userId: string, canPublish: boolean): void {
  run(db, "UPDATE memberships SET can_publish = ? WHERE project = ? AND user_id = ?", canPublish ? 1 : 0, project, userId);
}

export function deleteMembership(db: Db, project: string, userId: string): void {
  run(db, "DELETE FROM memberships WHERE project = ? AND user_id = ?", project, userId);
}

export function projectHasSkills(db: Db, project: string, publicOnly: boolean): boolean {
  const visibility = publicOnly ? " AND visibility = 'public'" : "";
  return get(db, `SELECT 1 AS found FROM skills WHERE project = ?${visibility} LIMIT 1`, project) !== null;
}

export function projectsWithSkillNamed(db: Db, slug: string): string[] {
  return all<{ project: string }>(db, "SELECT project FROM skills WHERE slug = ?", slug).map((r) => r.project);
}

export function moveSkill(db: Db, project: string, slug: string, target: string): void {
  run(db, "UPDATE skills SET project = ? WHERE project = ? AND slug = ?", target, project, slug);
}

export function getInstallKeyAccess(db: Db, key: string): { project: string; user_id: string; username: string } | null {
  return get(
    db,
    "SELECT m.project, m.user_id, u.username FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.install_key = ?",
    key,
  );
}
