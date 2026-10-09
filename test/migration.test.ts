import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const beforeProjects = migrations.filter((m) => m.name < "0003");
const projectsOnly = migrations.filter((m) => m.name >= "0003" && m.name < "0004");
const beforePublishing = migrations.filter((m) => m.name < "0004");
const fromPublishing = migrations.filter((m) => m.name >= "0004");
const beforePrefix = migrations.filter((m) => m.name < "0005");
const fromPrefix = migrations.filter((m) => m.name >= "0005");

async function wipe(): Promise<void> {
  for (const table of [
    "cli_login_projects", "cli_logins", "device_code_attempts", "memberships", "versions", "skills", "users", "projects", "d1_migrations",
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

const rows = async (sql: string) => (await db.prepare(sql).all()).results;

const VERSION_COLUMNS =
  "slug, version, digest, size, name, description, skill_md, html, html_rev, files, r2_key, author_id, created_at";

const SKILL_COLUMNS = "id, project, slug, description, owner_id, latest_version, created_at, updated_at";

const insertSkill = (id: string, project: string | null, slug: string) =>
  db.prepare(`INSERT INTO skills (${SKILL_COLUMNS}) VALUES (?, ?, ?, 'd', 'u1', 1, 0, 0)`).bind(id, project, slug).run();

describe("migration 0003 on an instance that already has data", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, beforeProjects);
    const user = db.prepare(
      "INSERT INTO users (id, username, password_hash, role, install_key, api_token_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const skill = db.prepare(
      "INSERT INTO skills (slug, description, visibility, owner_id, latest_version, created_at, updated_at, download_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const version = db.prepare(`INSERT INTO versions (${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    await db.batch([
      user.bind("u1", "root", "h1", "admin", "key-root", null, 1, 5),
      user.bind("u2", "bob", "h2", "member", "key-bob", "token-hash", 2, null),
      skill.bind("demo", "A demo", "public", "u2", 2, 10, 20, 7),
      skill.bind("other", "Another", "private", "u1", 1, 11, 21, 0),
      version.bind("demo", 1, "sha256:a", 1, "demo", "A demo", "md1", "html1", 1, "[]", "skills/demo/1.zip", "u2", 10),
      version.bind("demo", 2, "sha256:b", 2, "demo", "A demo", "md2", "html2", 1, "[]", "skills/demo/2.zip", "u1", 20),
      version.bind("other", 1, "sha256:c", 3, "other", "Another", "md3", "html3", 1, "[]", "skills/other/1.zip", "u1", 11),
    ]);
    await applyD1Migrations(db, projectsOnly);
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

  it("makes every account a member of the default project, regardless of its instance role", async () => {
    expect(await rows("SELECT project, user_id, role FROM memberships ORDER BY user_id")).toEqual([
      { project: "default", user_id: "u1", role: "member" },
      { project: "default", user_id: "u2", role: "member" },
    ]);
  });

  it("gives every membership a new install key instead of the one the account had", async () => {
    const keys = (await rows("SELECT install_key FROM memberships ORDER BY user_id")).map((r) => r.install_key);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(keys).not.toContain("key-root");
    expect(keys).not.toContain("key-bob");
    expect(new Set(keys).size).toBe(keys.length);
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
    await expect(insertSkill("x1", "default", "demo")).rejects.toThrow(/UNIQUE/);
    await expect(insertSkill("x2", "team-b", "demo")).resolves.toBeDefined();
  });

  it("refuses a second project with the same name in any letter case", async () => {
    await expect(
      db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-c', 'team b', 0)").run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a skill with no project or an unknown one", async () => {
    await expect(insertSkill("y1", null, "fresh")).rejects.toThrow(/NOT NULL/);
    await expect(insertSkill("y1", "nope", "fresh")).rejects.toThrow(/FOREIGN KEY/);
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

describe("migration 0004 on an instance that already has members", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, beforePublishing);
    await db.batch([
      db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'root', 'h', 'admin', 0)"),
      db.prepare("INSERT INTO memberships (project, user_id, role, install_key, created_at) VALUES ('default', 'u1', 'member', 'k1', 0)"),
    ]);
    await applyD1Migrations(db, fromPublishing);
  });

  it("lets every existing member keep publishing", async () => {
    expect(await rows("SELECT user_id, can_publish FROM memberships")).toEqual([{ user_id: "u1", can_publish: 1 }]);
  });

  it("starts a membership added afterwards blocked", async () => {
    await db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'bob', 'h', 'member', 0)").run();
    await db.prepare("INSERT INTO memberships (project, user_id, role, install_key, created_at) VALUES ('default', 'u2', 'member', 'k2', 0)").run();
    expect(await rows("SELECT can_publish FROM memberships WHERE user_id = 'u2'")).toEqual([{ can_publish: 0 }]);
  });

  it("stores the switch as 0 or 1 only", async () => {
    const set = (value: number) =>
      db.prepare("UPDATE memberships SET can_publish = ? WHERE user_id = 'u1'").bind(value).run();
    await expect(set(0)).resolves.toBeDefined();
    await expect(set(2)).rejects.toThrow(/CHECK/);
  });
});

describe("migration 0005 on an instance that already has members", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, beforePrefix);
    await db.batch([
      db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'root', 'h', 'admin', 0)"),
      db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-b', 'Team B', 0)"),
      db.prepare(
        "INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES ('default', 'u1', 'admin', 'k1', 1, 7)",
      ),
      db.prepare(
        "INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES ('team-b', 'u1', 'member', 'k2', 0, 8)",
      ),
    ]);
    await applyD1Migrations(db, fromPrefix);
  });

  it("replaces every install key with a new sgi_ key and keeps the rest of each membership", async () => {
    const memberships = await rows("SELECT * FROM memberships ORDER BY project");
    expect(memberships.map(({ install_key, ...rest }) => rest)).toEqual([
      { project: "default", user_id: "u1", role: "admin", can_publish: 1, created_at: 7 },
      { project: "team-b", user_id: "u1", role: "member", can_publish: 0, created_at: 8 },
    ]);
    const keys = memberships.map((m) => m.install_key as string);
    for (const key of keys) expect(key).toMatch(/^sgi_[a-f0-9]{64}$/);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("migrations 0006 and 0007", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, migrations);
    await db.batch([
      db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'root', 'h', 'admin', 0)"),
      db.prepare("INSERT INTO memberships (project, user_id, role, install_key, created_at) VALUES ('default', 'u1', 'admin', 'sgi_k', 0)"),
      db.prepare(
        "INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at) VALUES ('l1', 'active', 'u1', 'x', 5, 0, 0)",
      ),
      db.prepare("INSERT INTO cli_login_projects (login_id, project, user_id) VALUES ('l1', 'default', 'u1')"),
    ]);
  });

  it("refuses an unknown status or user, and a grant without a membership", async () => {
    const insert = (status: string, user: string) =>
      db.prepare("INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at) VALUES ('l2', ?, ?, 'x', 5, 0, 0)").bind(status, user).run();
    await expect(insert("lost", "u1")).rejects.toThrow(/CHECK/);
    await expect(insert("active", "nobody")).rejects.toThrow(/FOREIGN KEY/);
    const grant = (project: string) =>
      db.prepare("INSERT INTO cli_login_projects (login_id, project, user_id) VALUES ('l1', ?, 'u1')").bind(project).run();
    await expect(grant("nope")).rejects.toThrow(/FOREIGN KEY/);
    await db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-b', 'Team B', 0)").run();
    await expect(grant("team-b")).rejects.toThrow(/FOREIGN KEY/);
  });

  it("drops a grant when its membership ends, and a sign-in when its user is deleted", async () => {
    await db.prepare("DELETE FROM memberships WHERE user_id = 'u1'").run();
    expect(await rows("SELECT * FROM cli_login_projects")).toEqual([]);
    expect(await rows("SELECT id FROM cli_logins")).toEqual([{ id: "l1" }]);
    await db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(await rows("SELECT * FROM cli_logins")).toEqual([]);
  });
});

describe("migration 0007 on an instance that already has sign-ins", () => {
  beforeAll(async () => {
    await wipe();
    await applyD1Migrations(db, migrations.filter((m) => m.name < "0007"));
    await db.batch([
      db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-b', 'Team B', 0)"),
      db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'root', 'h', 'admin', 0)"),
      db.prepare("INSERT INTO memberships (project, user_id, role, install_key, created_at) VALUES ('default', 'u1', 'admin', 'sgi_k', 0)"),
      db.prepare(
        "INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at) VALUES ('l1', 'active', 'u1', 'x', 5, 0, 0)",
      ),
      db.prepare("INSERT INTO cli_login_projects (login_id, project) VALUES ('l1', 'default')"),
      db.prepare("INSERT INTO cli_login_projects (login_id, project) VALUES ('l1', 'team-b')"),
    ]);
    await applyD1Migrations(db, migrations.filter((m) => m.name >= "0007"));
  });

  it("keeps the grants of current memberships, records their user, and drops the rest", async () => {
    expect(await rows("SELECT * FROM cli_login_projects")).toEqual([{ login_id: "l1", project: "default", user_id: "u1" }]);
  });
});
