import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const beforeProjects = migrations.filter((m) => m.name < "0003");
const fromProjects = migrations.filter((m) => m.name >= "0003");

async function wipe(): Promise<void> {
  for (const table of ["memberships", "versions", "skills", "users", "projects", "d1_migrations"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

const rows = async (sql: string) => (await db.prepare(sql).all()).results;

const VERSION_COLUMNS =
  "slug, version, digest, size, name, description, skill_md, html, html_rev, files, r2_key, author_id, created_at";

const SKILL_COLUMNS = "id, project, slug, description, owner_id, latest_version, created_at, updated_at";

describe("migration 0003 on an instance that already has data", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, beforeProjects);
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role, install_key, api_token_hash, created_at, last_login_at) VALUES ('u1', 'root', 'h1', 'admin', 'key-root', NULL, 1, 5)",
      ),
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role, install_key, api_token_hash, created_at, last_login_at) VALUES ('u2', 'bob', 'h2', 'member', 'key-bob', 'token-hash', 2, NULL)",
      ),
      db.prepare(
        "INSERT INTO skills (slug, description, visibility, owner_id, latest_version, created_at, updated_at, download_count) VALUES ('demo', 'A demo', 'public', 'u2', 2, 10, 20, 7)",
      ),
      db.prepare(
        "INSERT INTO skills (slug, description, visibility, owner_id, latest_version, created_at, updated_at, download_count) VALUES ('other', 'Another', 'private', 'u1', 1, 11, 21, 0)",
      ),
      db.prepare(
        `INSERT INTO versions (${VERSION_COLUMNS}) VALUES ('demo', 1, 'sha256:a', 1, 'demo', 'A demo', 'md1', 'html1', 1, '[]', 'skills/demo/1.zip', 'u2', 10)`,
      ),
      db.prepare(
        `INSERT INTO versions (${VERSION_COLUMNS}) VALUES ('demo', 2, 'sha256:b', 2, 'demo', 'A demo', 'md2', 'html2', 1, '[]', 'skills/demo/2.zip', 'u1', 20)`,
      ),
      db.prepare(
        `INSERT INTO versions (${VERSION_COLUMNS}) VALUES ('other', 1, 'sha256:c', 3, 'other', 'Another', 'md3', 'html3', 1, '[]', 'skills/other/1.zip', 'u1', 11)`,
      ),
    ]);
    await applyD1Migrations(db, fromProjects);
  });

  it("creates the default project", async () => {
    expect(await rows("SELECT slug, name FROM projects")).toEqual([{ slug: "default", name: "Default" }]);
  });

  it("keeps every account and drops install_key from users", async () => {
    expect(await rows("SELECT * FROM users ORDER BY id")).toEqual([
      { id: "u1", username: "root", password_hash: "h1", role: "admin", api_token_hash: null, created_at: 1, last_login_at: 5 },
      { id: "u2", username: "bob", password_hash: "h2", role: "member", api_token_hash: "token-hash", created_at: 2, last_login_at: null },
    ]);
  });

  it("makes every account a member of the default project with the install key it had", async () => {
    expect(await rows("SELECT project, user_id, role, install_key FROM memberships ORDER BY user_id")).toEqual([
      { project: "default", user_id: "u1", role: "admin", install_key: "key-root" },
      { project: "default", user_id: "u2", role: "member", install_key: "key-bob" },
    ]);
  });

  it("puts every skill in the default project under a new id and keeps the rest of the row", async () => {
    const skills = await rows(
      "SELECT id, project, slug, description, visibility, owner_id, latest_version, download_count, created_at, updated_at FROM skills ORDER BY slug",
    );
    expect(skills.map(({ id, ...rest }) => rest)).toEqual([
      { project: "default", slug: "demo", description: "A demo", visibility: "public", owner_id: "u2", latest_version: 2, download_count: 7, created_at: 10, updated_at: 20 },
      { project: "default", slug: "other", description: "Another", visibility: "private", owner_id: "u1", latest_version: 1, download_count: 0, created_at: 11, updated_at: 21 },
    ]);
    for (const { id } of skills) expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(skills[0].id).not.toBe(skills[1].id);
  });

  it("attaches every version to its skill and keeps its R2 key", async () => {
    expect(
      await rows(
        "SELECT s.slug, v.version, v.digest, v.skill_md, v.r2_key, v.author_id FROM versions v JOIN skills s ON s.id = v.skill_id ORDER BY s.slug, v.version",
      ),
    ).toEqual([
      { slug: "demo", version: 1, digest: "sha256:a", skill_md: "md1", r2_key: "skills/demo/1.zip", author_id: "u2" },
      { slug: "demo", version: 2, digest: "sha256:b", skill_md: "md2", r2_key: "skills/demo/2.zip", author_id: "u1" },
      { slug: "other", version: 1, digest: "sha256:c", skill_md: "md3", r2_key: "skills/other/1.zip", author_id: "u1" },
    ]);
  });

  it("allows one name per project, and the same name in another project", async () => {
    await db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-b', 'Team B', 0)").run();
    const insert = (id: string, project: string) =>
      db.prepare(`INSERT INTO skills (${SKILL_COLUMNS}) VALUES (?, ?, 'demo', 'd', 'u1', 1, 0, 0)`).bind(id, project).run();
    await expect(insert("x1", "default")).rejects.toThrow(/UNIQUE/);
    await expect(insert("x2", "team-b")).resolves.toBeDefined();
  });

  it("refuses a second project with the same name in any letter case", async () => {
    await expect(
      db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-c', 'team b', 0)").run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a skill with no project or an unknown one", async () => {
    const insert = (project: string | null) =>
      db.prepare(`INSERT INTO skills (${SKILL_COLUMNS}) VALUES ('y1', ?, 'fresh', 'd', 'u1', 1, 0, 0)`).bind(project).run();
    await expect(insert(null)).rejects.toThrow(/NOT NULL/);
    await expect(insert("nope")).rejects.toThrow(/FOREIGN KEY/);
  });

  it("refuses to orphan memberships or skills", async () => {
    await expect(db.prepare("DELETE FROM users WHERE id = 'u2'").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.prepare("DELETE FROM projects WHERE slug = 'default'").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("still deletes a skill's versions along with it", async () => {
    await db.prepare("DELETE FROM skills WHERE project = 'default' AND slug = 'demo'").run();
    expect(await rows("SELECT r2_key FROM versions ORDER BY r2_key")).toEqual([{ r2_key: "skills/other/1.zip" }]);
  });
});

describe("migration 0003 on a fresh instance", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, migrations);
  });

  it("leaves an empty default project", async () => {
    expect(await rows("SELECT slug, name FROM projects")).toEqual([{ slug: "default", name: "Default" }]);
    expect(await rows("SELECT * FROM memberships")).toEqual([]);
  });
});
