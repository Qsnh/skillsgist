export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin" | "member";
  install_key: string;
  api_token_hash: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface SkillRow {
  slug: string;
  description: string;
  visibility: "public" | "private";
  owner_id: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  slug: string;
  version: number;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  files: string;
  r2_key: string;
  author_id: string;
  created_at: number;
}

/** Just the version rows a version list renders — see `listVersions`. */
export type VersionSummary = Pick<VersionRow, "version" | "created_at">;

export interface ArtifactRef {
  r2_key: string;
  visibility: "public" | "private";
}

export interface InsertVersionInput {
  slug: string;
  digest: string;
  size: number;
  name: string;
  description: string;
  skill_md: string;
  html: string;
  files: string;
  authorId: string;
  visibility: "public" | "private";
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createUser(
  db: D1Database,
  input: { id: string; username: string; passwordHash: string; role: "admin" | "member"; installKey: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, install_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(input.id, input.username, input.passwordHash, input.role, input.installKey, Date.now())
    .run();
}

// Atomically creates the first admin. Guards the "no users exist yet" check
// and the insert in a single statement so two concurrent `POST /setup`
// requests can't both pass a separate `countUsers` check and both insert a
// bootstrap admin. Returns whether this call actually inserted the row.
export async function createFirstAdmin(
  db: D1Database,
  input: { id: string; username: string; passwordHash: string; installKey: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, install_key, created_at)
       SELECT ?, ?, ?, 'admin', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(input.id, input.username, input.passwordHash, input.installKey, Date.now())
    .run();
  return result.meta.changes === 1;
}

export function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export function getUserByInstallKey(db: D1Database, key: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE install_key = ?").bind(key).first<UserRow>();
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

// Deletes a user while keeping the foreign keys that reference them intact:
// `skills.owner_id` and `versions.author_id` both `REFERENCES users(id)`
// with no ON DELETE clause, so an unqualified delete would fail (or, if it
// somehow didn't, leave dangling references). Reassigning both to the
// acting admin first, in the same batch as the delete, keeps every skill
// the departed user owned or published downloadable and attributed to a
// user that still exists.
//
// `reassignTo` must be a *different* user: with both sides equal the two
// UPDATEs are a no-op against the row about to be deleted, leaving those
// foreign keys pointing at an id that no longer exists. The precondition
// belongs here rather than in each caller, so a second caller (a cleanup
// job, a bulk delete) can't reintroduce the corruption by forgetting it.
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
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

export async function listSkills(
  db: D1Database,
  opts: { includePrivate: boolean; q?: string },
): Promise<Array<SkillRow & { author: string }>> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includePrivate) clauses.push("s.visibility = 'public'");
  if (opts.q) {
    clauses.push(
      "(s.slug LIKE ?1 OR s.description LIKE ?1 OR EXISTS (SELECT 1 FROM versions v WHERE v.slug = s.slug AND v.version = s.latest_version AND v.skill_md LIKE ?1))",
    );
    binds.push(`%${opts.q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT s.*, u.username AS author FROM skills s JOIN users u ON u.id = s.owner_id ${where} ORDER BY s.updated_at DESC`;
  const { results } = await db.prepare(sql).bind(...binds).all<SkillRow & { author: string }>();
  return results;
}

export function getSkill(db: D1Database, slug: string): Promise<SkillRow | null> {
  return db.prepare("SELECT * FROM skills WHERE slug = ?").bind(slug).first<SkillRow>();
}

/** `getSkill` with the owner's username folded in, the way `listSkills` does. */
export function getSkillWithAuthor(
  db: D1Database,
  slug: string,
): Promise<(SkillRow & { author: string }) | null> {
  return db
    .prepare("SELECT s.*, u.username AS author FROM skills s JOIN users u ON u.id = s.owner_id WHERE s.slug = ?")
    .bind(slug)
    .first<SkillRow & { author: string }>();
}

export function getVersion(db: D1Database, slug: string, version: number): Promise<VersionRow | null> {
  return db
    .prepare("SELECT * FROM versions WHERE slug = ? AND version = ?")
    .bind(slug, version)
    .first<VersionRow>();
}

// Only the two columns the version list renders. `skill_md` and `html` are
// the widest columns in the table, and `SELECT *` pulled both for every
// version of the skill just to print a number and a date.
export async function listVersions(db: D1Database, slug: string): Promise<VersionSummary[]> {
  const { results } = await db
    .prepare("SELECT version, created_at FROM versions WHERE slug = ? ORDER BY version DESC")
    .bind(slug)
    .all<VersionSummary>();
  return results;
}

export async function listPublishedForIndex(
  db: D1Database,
  includePrivate: boolean,
): Promise<Array<{ slug: string; description: string; digest: string }>> {
  const where = includePrivate ? "" : "WHERE s.visibility = 'public'";
  const sql = `SELECT s.slug, v.description, v.digest
               FROM skills s
               JOIN versions v ON v.slug = s.slug AND v.version = s.latest_version
               ${where}
               ORDER BY s.slug`;
  const { results } = await db.prepare(sql).all<{ slug: string; description: string; digest: string }>();
  return results;
}

// Returns the `r2_key` it recorded as well as the version number: the caller
// has to write the R2 object under exactly that key, and deriving the same
// string a second time at the call site is how the stored key and the written
// object drift apart.
export async function insertVersion(
  db: D1Database,
  input: InsertVersionInput,
): Promise<{ version: number; r2Key: string }> {
  const now = Date.now();
  const next = await db
    .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM versions WHERE slug = ?")
    .bind(input.slug)
    .first<{ n: number }>();
  const version = next?.n ?? 1;
  const r2Key = `skills/${input.slug}/${version}.zip`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO skills (slug, description, visibility, owner_id, latest_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET description = excluded.description,
                                         latest_version = excluded.latest_version,
                                         updated_at = excluded.updated_at`,
      )
      .bind(input.slug, input.description, input.visibility, input.authorId, version, now, now),
    db
      .prepare(
        `INSERT INTO versions (slug, version, digest, size, name, description, skill_md, html, files, r2_key, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.slug, version, input.digest, input.size, input.name, input.description,
        input.skill_md, input.html, input.files, r2Key, input.authorId, now,
      ),
  ]);

  return { version, r2Key };
}

export async function setVisibility(
  db: D1Database,
  slug: string,
  visibility: "public" | "private",
): Promise<void> {
  await db
    .prepare("UPDATE skills SET visibility = ?, updated_at = ? WHERE slug = ?")
    .bind(visibility, Date.now(), slug)
    .run();
}

export async function deleteSkill(db: D1Database, slug: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT r2_key FROM versions WHERE slug = ?")
    .bind(slug)
    .all<{ r2_key: string }>();
  await db.batch([
    db.prepare("DELETE FROM versions WHERE slug = ?").bind(slug),
    db.prepare("DELETE FROM skills WHERE slug = ?").bind(slug),
  ]);
  return results.map((r) => r.r2_key);
}

export async function updateInstallKey(db: D1Database, userId: string, key: string): Promise<void> {
  await db.prepare("UPDATE users SET install_key = ? WHERE id = ?").bind(key, userId).run();
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

// The download routes need the object key and the skill's visibility, and
// nothing else — joining beats fetching the whole skill row and then the
// whole version row (which carries `skill_md` and `html`) in two round trips.
const ARTIFACT_SQL =
  "SELECT v.r2_key, s.visibility FROM skills s JOIN versions v ON v.slug = s.slug WHERE s.slug = ?";

/** `version === null` means "whatever the skill's latest is". */
export function getArtifactByVersion(
  db: D1Database,
  slug: string,
  version: number | null,
): Promise<ArtifactRef | null> {
  return db
    .prepare(`${ARTIFACT_SQL} AND v.version = COALESCE(?, s.latest_version)`)
    .bind(slug, version)
    .first<ArtifactRef>();
}

export function getArtifactByDigest(
  db: D1Database,
  slug: string,
  digest: string,
): Promise<ArtifactRef | null> {
  return db.prepare(`${ARTIFACT_SQL} AND v.digest = ?`).bind(slug, digest).first<ArtifactRef>();
}
