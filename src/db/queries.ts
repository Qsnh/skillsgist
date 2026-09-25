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
  project: string;
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
  r2_key: string;
  author_id: string;
  created_at: number;
}

export type VersionSummary = Pick<VersionRow, "version" | "created_at">;

export interface ArtifactRef {
  project: string;
  slug: string;
  visibility: "public" | "private";
  r2_key: string;
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

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createUser(
  db: D1Database,
  input: { id: string; username: string; passwordHash: string; role: "admin" | "member" },
): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(input.id, input.username, input.passwordHash, input.role, Date.now())
    .run();
}

export async function createFirstAdmin(
  db: D1Database,
  input: { id: string; username: string; passwordHash: string; installKey: string },
): Promise<boolean> {
  const now = Date.now();
  const [user] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, created_at)
         SELECT ?, ?, ?, 'admin', ?
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .bind(input.id, input.username, input.passwordHash, now),
    db
      .prepare(
        `INSERT INTO memberships (project, user_id, role, install_key, created_at)
         SELECT slug, ?, 'admin', ?, ? FROM projects
         WHERE slug = ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)`,
      )
      .bind(input.id, input.installKey, now, DEFAULT_PROJECT, input.id),
  ]);
  return user.meta.changes === 1;
}

export function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY created_at").all<UserRow>();
  return results;
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateUserRole(
  db: D1Database,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
}

export async function deleteUserReassigning(
  db: D1Database,
  userId: string,
  reassignTo: string,
): Promise<void> {
  if (userId === reassignTo) {
    throw new Error("deleteUserReassigning: cannot reassign a user's rows to itself");
  }
  await db.batch([
    db.prepare("UPDATE skills SET owner_id = ? WHERE owner_id = ?").bind(reassignTo, userId),
    db.prepare("UPDATE versions SET author_id = ? WHERE author_id = ?").bind(reassignTo, userId),
    db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

export function getMembershipByInstallKey(db: D1Database, key: string): Promise<MembershipRow | null> {
  return db.prepare("SELECT * FROM memberships WHERE install_key = ?").bind(key).first<MembershipRow>();
}

async function viewerWhere(
  db: D1Database,
  column: "id" | "api_token_hash",
  value: string,
): Promise<Viewer | null> {
  const [users, memberships] = await db.batch([
    db.prepare(`SELECT * FROM users WHERE ${column} = ?`).bind(value),
    db
      .prepare(
        `SELECT m.*, p.name AS project_name
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN projects p ON p.slug = m.project
         WHERE u.${column} = ?
         ORDER BY p.name`,
      )
      .bind(value),
  ]);
  const user = users.results[0] as UserRow | undefined;
  return user ? { ...user, memberships: memberships.results as Membership[] } : null;
}

export function getViewer(db: D1Database, userId: string): Promise<Viewer | null> {
  return viewerWhere(db, "id", userId);
}

export function getViewerByApiTokenHash(db: D1Database, hash: string): Promise<Viewer | null> {
  return viewerWhere(db, "api_token_hash", hash);
}

export async function createProject(db: D1Database, input: { slug: string; name: string }): Promise<void> {
  await db
    .prepare("INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)")
    .bind(input.slug, input.name, Date.now())
    .run();
}

export function getProject(db: D1Database, slug: string): Promise<ProjectRow | null> {
  return db.prepare("SELECT * FROM projects WHERE slug = ?").bind(slug).first<ProjectRow>();
}

export async function listProjects(db: D1Database): Promise<ProjectRow[]> {
  const { results } = await db.prepare("SELECT * FROM projects ORDER BY name").all<ProjectRow>();
  return results;
}

export async function addMembership(
  db: D1Database,
  input: { project: string; userId: string; role: "admin" | "member"; installKey: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO memberships (project, user_id, role, install_key, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(input.project, input.userId, input.role, input.installKey, Date.now())
    .run();
}

export async function updateInstallKey(
  db: D1Database,
  project: string,
  userId: string,
  key: string,
): Promise<void> {
  await db
    .prepare("UPDATE memberships SET install_key = ? WHERE project = ? AND user_id = ?")
    .bind(key, project, userId)
    .run();
}

export async function rotateInstallKeys(db: D1Database, userId: string, nextKey: () => string): Promise<void> {
  const { results } = await db
    .prepare("SELECT project FROM memberships WHERE user_id = ?")
    .bind(userId)
    .all<{ project: string }>();
  if (results.length === 0) return;
  await db.batch(
    results.map(({ project }) =>
      db
        .prepare("UPDATE memberships SET install_key = ? WHERE project = ? AND user_id = ?")
        .bind(nextKey(), project, userId),
    ),
  );
}

const LISTED_SKILL_SQL = `SELECT s.*, u.username AS author, p.name AS project_name
  FROM skills s
  JOIN users u ON u.id = s.owner_id
  JOIN projects p ON p.slug = s.project`;

export async function listSkills(
  db: D1Database,
  opts: { scope: SkillScope; q?: string },
): Promise<ListedSkill[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const bind = (value: unknown) => {
    binds.push(value);
    return `?${binds.length}`;
  };
  if (opts.scope.kind === "public") clauses.push("s.visibility = 'public'");
  if (opts.scope.kind === "member") {
    clauses.push(
      `(s.visibility = 'public' OR EXISTS (SELECT 1 FROM memberships m WHERE m.project = s.project AND m.user_id = ${bind(opts.scope.userId)}))`,
    );
  }
  if (opts.q) {
    const pattern = bind(`%${opts.q}%`);
    clauses.push(
      `(s.slug LIKE ${pattern} OR s.description LIKE ${pattern} OR EXISTS (SELECT 1 FROM versions v WHERE v.skill_id = s.id AND v.version = s.latest_version AND v.skill_md LIKE ${pattern}))`,
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`${LISTED_SKILL_SQL} ${where} ORDER BY s.updated_at DESC`)
    .bind(...binds)
    .all<ListedSkill>();
  return results;
}

export function getSkill(db: D1Database, project: string, slug: string): Promise<SkillRow | null> {
  return db
    .prepare("SELECT * FROM skills WHERE project = ? AND slug = ?")
    .bind(project, slug)
    .first<SkillRow>();
}

export function getSkillWithAuthor(db: D1Database, project: string, slug: string): Promise<ListedSkill | null> {
  return db
    .prepare(`${LISTED_SKILL_SQL} WHERE s.project = ? AND s.slug = ?`)
    .bind(project, slug)
    .first<ListedSkill>();
}

const SKILL_ID_SQL = "(SELECT id FROM skills WHERE project = ? AND slug = ?)";

export function updateVersionHtml(
  db: D1Database,
  project: string,
  slug: string,
  version: number,
  html: string,
  rev: number,
): Promise<unknown> {
  return db
    .prepare(`UPDATE versions SET html = ?, html_rev = ? WHERE skill_id = ${SKILL_ID_SQL} AND version = ?`)
    .bind(html, rev, project, slug, version)
    .run();
}

export function getVersion(
  db: D1Database,
  project: string,
  slug: string,
  version: number,
): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT v.*, s.project, s.slug FROM versions v JOIN skills s ON s.id = v.skill_id
       WHERE s.project = ? AND s.slug = ? AND v.version = ?`,
    )
    .bind(project, slug, version)
    .first<VersionRow>();
}

export async function listVersions(db: D1Database, project: string, slug: string): Promise<VersionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT v.version, v.created_at FROM versions v JOIN skills s ON s.id = v.skill_id
       WHERE s.project = ? AND s.slug = ? ORDER BY v.version DESC`,
    )
    .bind(project, slug)
    .all<VersionSummary>();
  return results;
}

export async function listPublishedForIndex(
  db: D1Database,
  filter: IndexFilter,
): Promise<Array<{ slug: string; description: string; digest: string }>> {
  const select = `SELECT s.slug, v.description, v.digest
                  FROM skills s
                  JOIN versions v ON v.skill_id = s.id AND v.version = s.latest_version`;
  const statement =
    filter.kind === "root"
      ? db.prepare(
          `${select}
           WHERE s.visibility = 'public'
             AND NOT EXISTS (SELECT 1 FROM skills o WHERE o.slug = s.slug AND o.id <> s.id AND o.visibility = 'public')
           ORDER BY s.slug`,
        )
      : db
          .prepare(
            `${select} WHERE s.project = ?${filter.publicOnly ? " AND s.visibility = 'public'" : ""} ORDER BY s.slug`,
          )
          .bind(filter.project);
  const { results } = await statement.all<{ slug: string; description: string; digest: string }>();
  return results;
}

export async function insertVersion(
  db: D1Database,
  input: InsertVersionInput,
): Promise<{ version: number; r2Key: string }> {
  const now = Date.now();
  const next = await db
    .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM versions WHERE skill_id = ?")
    .bind(input.skillId)
    .first<{ n: number }>();
  const version = next?.n ?? 1;
  const r2Key = `artifacts/${input.skillId}/${version}.zip`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO skills (id, project, slug, description, visibility, owner_id, latest_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET description = excluded.description,
                                       latest_version = excluded.latest_version,
                                       updated_at = excluded.updated_at`,
      )
      .bind(
        input.skillId, input.project, input.slug, input.description, input.visibility, input.authorId,
        version, now, now,
      ),
    db
      .prepare(
        `INSERT INTO versions (skill_id, version, digest, size, name, description, skill_md, html, html_rev, files, r2_key, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.skillId, version, input.digest, input.size, input.name, input.description,
        input.skill_md, input.html, input.html_rev, input.files, r2Key, input.authorId, now,
      ),
  ]);

  return { version, r2Key };
}

export async function setVisibility(
  db: D1Database,
  project: string,
  slug: string,
  visibility: "public" | "private",
): Promise<void> {
  await db
    .prepare("UPDATE skills SET visibility = ?, updated_at = ? WHERE project = ? AND slug = ?")
    .bind(visibility, Date.now(), project, slug)
    .run();
}

export async function incrementDownloads(db: D1Database, project: string, slug: string): Promise<void> {
  await db
    .prepare("UPDATE skills SET download_count = download_count + 1 WHERE project = ? AND slug = ?")
    .bind(project, slug)
    .run();
}

export async function deleteSkill(db: D1Database, project: string, slug: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT r2_key FROM versions WHERE skill_id = ${SKILL_ID_SQL}`)
    .bind(project, slug)
    .all<{ r2_key: string }>();
  await db.batch([
    db.prepare(`DELETE FROM versions WHERE skill_id = ${SKILL_ID_SQL}`).bind(project, slug),
    db.prepare("DELETE FROM skills WHERE project = ? AND slug = ?").bind(project, slug),
  ]);
  return results.map((r) => r.r2_key);
}

export async function updateApiTokenHash(
  db: D1Database,
  userId: string,
  hash: string | null,
): Promise<void> {
  await db.prepare("UPDATE users SET api_token_hash = ? WHERE id = ?").bind(hash, userId).run();
}

export async function updatePassword(db: D1Database, userId: string, hash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, userId).run();
}

export async function touchLogin(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(at, userId).run();
}

const ARTIFACT_SQL =
  "SELECT s.project, s.slug, s.visibility, v.r2_key FROM skills s JOIN versions v ON v.skill_id = s.id";

export function getArtifactByVersion(
  db: D1Database,
  project: string,
  slug: string,
  version: number | null,
): Promise<ArtifactRef | null> {
  return db
    .prepare(`${ARTIFACT_SQL} WHERE s.project = ? AND s.slug = ? AND v.version = COALESCE(?, s.latest_version)`)
    .bind(project, slug, version)
    .first<ArtifactRef>();
}

export function getArtifactByDigest(
  db: D1Database,
  project: string,
  slug: string,
  digest: string,
): Promise<ArtifactRef | null> {
  return db
    .prepare(`${ARTIFACT_SQL} WHERE s.project = ? AND s.slug = ? AND v.digest = ?`)
    .bind(project, slug, digest)
    .first<ArtifactRef>();
}

export function getPublicArtifact(db: D1Database, slug: string, digest: string): Promise<ArtifactRef | null> {
  return db
    .prepare(`${ARTIFACT_SQL} WHERE s.slug = ? AND s.visibility = 'public' AND v.digest = ? LIMIT 1`)
    .bind(slug, digest)
    .first<ArtifactRef>();
}
