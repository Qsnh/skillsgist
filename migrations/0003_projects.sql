CREATE TABLE projects (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

INSERT INTO projects (slug, name, created_at) VALUES ('default', 'Default', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE users_next (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  api_token_hash TEXT,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

INSERT INTO users_next (id, username, password_hash, role, api_token_hash, created_at, last_login_at)
SELECT id, username, password_hash, role, api_token_hash, created_at, last_login_at FROM users;

CREATE TABLE memberships (
  project     TEXT NOT NULL REFERENCES projects(slug),
  user_id     TEXT NOT NULL REFERENCES users_next(id),
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  install_key TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project, user_id)
);

INSERT INTO memberships (project, user_id, role, install_key, created_at)
SELECT 'default', id, role, install_key, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;

CREATE TABLE skills_next (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL REFERENCES projects(slug),
  slug           TEXT NOT NULL,
  description    TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  owner_id       TEXT NOT NULL REFERENCES users_next(id),
  latest_version INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (project, slug)
);

INSERT INTO skills_next (id, project, slug, description, visibility, owner_id, latest_version, download_count, created_at, updated_at)
SELECT lower(hex(randomblob(8))), 'default', slug, description, visibility, owner_id, latest_version, download_count, created_at, updated_at
FROM skills;

CREATE TABLE versions_next (
  skill_id    TEXT NOT NULL REFERENCES skills_next(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_md    TEXT NOT NULL,
  html        TEXT NOT NULL,
  html_rev    INTEGER NOT NULL,
  files       TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES users_next(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (skill_id, version)
);

INSERT INTO versions_next (skill_id, version, digest, size, name, description, skill_md, html, html_rev, files, r2_key, author_id, created_at)
SELECT s.id, v.version, v.digest, v.size, v.name, v.description, v.skill_md, v.html, v.html_rev, v.files, v.r2_key, v.author_id, v.created_at
FROM versions v JOIN skills_next s ON s.slug = v.slug;

DROP TABLE versions;

DROP TABLE skills;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;

ALTER TABLE skills_next RENAME TO skills;

ALTER TABLE versions_next RENAME TO versions;

CREATE INDEX idx_users_api_token_hash ON users(api_token_hash);

CREATE INDEX idx_skills_visibility ON skills(visibility);

CREATE INDEX idx_skills_slug ON skills(slug);

CREATE INDEX idx_memberships_user ON memberships(user_id);
