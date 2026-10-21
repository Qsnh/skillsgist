import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY, migrate, openDatabase, schemaVersion } from "../src/db/database";
import { MIGRATIONS } from "../src/db/schema";

const pragma = (db: ReturnType<typeof openDatabase>, name: string) => db.pragma(name, { simple: true });

describe("openDatabase", () => {
  it("creates the schema with the default project and turns on foreign keys", () => {
    const db = openDatabase(MEMORY);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(db.prepare("SELECT slug, name FROM projects").all()).toEqual([{ slug: "default", name: "Default" }]);
    db.close();
  });

  it("creates the file and its directory, in WAL mode, and reopens it without migrating again", () => {
    const file = join(mkdtempSync(join(tmpdir(), "skillsgist-db-")), "nested", "skillsgist.db");
    const first = openDatabase(file);
    expect(pragma(first, "journal_mode")).toBe("wal");
    first.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('team-b', 'Team B', 1)").run();
    first.close();
    const second = openDatabase(file);
    expect(migrate(second)).toBe(0);
    expect(second.prepare("SELECT COUNT(*) FROM projects").pluck().get()).toBe(2);
    second.close();
  });

  it("lets a migration rebuild a table without cascading deletes into its children", () => {
    const db = openDatabase(MEMORY);
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'admin', 0);
      INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES ('default', 'u1', 'member', 'k1', 1, 0);
    `);
    const rebuild = `
      CREATE TABLE projects_next (slug TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at INTEGER NOT NULL) STRICT;
      INSERT INTO projects_next SELECT * FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_next RENAME TO projects;
    `;
    expect(migrate(db, [...MIGRATIONS, rebuild])).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM memberships").pluck().get()).toBe(1);
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.close();
  });

  it("rolls back a migration that leaves rows pointing nowhere", () => {
    const db = openDatabase(MEMORY);
    db.exec("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'admin', 0)");
    const orphan = "INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES ('nope', 'u1', 'member', 'k', 1, 0)";
    expect(() => migrate(db, [...MIGRATIONS, orphan])).toThrow(/memberships pointing at missing projects/);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT COUNT(*) FROM memberships").pluck().get()).toBe(0);
    expect(pragma(db, "foreign_keys")).toBe(1);
    db.close();
  });

  it("refuses a database written by a newer build", () => {
    const db = openDatabase(MEMORY);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
    db.close();
  });
});

describe("the schema", () => {
  const seeded = () => {
    const db = openDatabase(MEMORY);
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'admin', 0);
      INSERT INTO memberships (project, user_id, role, install_key, can_publish, created_at) VALUES ('default', 'u1', 'member', 'k1', 1, 0);
      INSERT INTO skills (id, project, slug, description, owner_id, latest_version, created_at, updated_at)
        VALUES ('s1', 'default', 'demo', 'd', 'u1', 1, 0, 0);
      INSERT INTO versions (skill_id, version, digest, size, name, description, skill_md, html, html_rev, files, object_key, author_id, created_at)
        VALUES ('s1', 1, 'sha256:x', 1, 'demo', 'd', 'x', 'x', 1, '[]', 'k', 'u1', 0);
      INSERT INTO download_logs (skill_id, version, source, created_at) VALUES ('s1', 1, 'anonymous', 0);
      INSERT INTO download_days (skill_id, day, version, source, count) VALUES ('s1', 0, 1, 'anonymous', 1);
    `);
    return db;
  };

  it("deletes a skill's versions and download records with it", () => {
    const db = seeded();
    db.prepare("DELETE FROM skills WHERE id = 's1'").run();
    for (const table of ["versions", "download_logs", "download_days"]) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    db.close();
  });

  it("refuses to delete an account that still owns skills, and a project that still has them", () => {
    const db = seeded();
    expect(() => db.prepare("DELETE FROM users WHERE id = 'u1'").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("DELETE FROM projects WHERE slug = 'default'").run()).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("removes memberships and their CLI grants with the account", () => {
    const db = seeded();
    db.exec(`
      DELETE FROM skills;
      INSERT INTO cli_logins (id, status, user_id, device_name, poll_interval, created_at, expires_at) VALUES ('l1', 'active', 'u1', 'x', 5, 0, 0);
      INSERT INTO cli_login_projects (login_id, project, user_id) VALUES ('l1', 'default', 'u1');
      DELETE FROM users WHERE id = 'u1';
    `);
    for (const table of ["memberships", "cli_logins", "cli_login_projects"]) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    db.close();
  });

  it("rejects values of the wrong type", () => {
    const db = openDatabase(MEMORY);
    expect(() =>
      db.prepare("INSERT INTO projects (slug, name, created_at) VALUES ('p', 'P', 'yesterday')").run(),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
    db.close();
  });
});
