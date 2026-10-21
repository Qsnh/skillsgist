export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  api_token_hash TEXT UNIQUE,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
) STRICT;

CREATE TABLE projects (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO projects (slug, name, created_at) VALUES ('default', 'Default', unixepoch() * 1000);

CREATE TABLE memberships (
  project     TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  install_key TEXT NOT NULL UNIQUE,
  can_publish INTEGER NOT NULL DEFAULT 0 CHECK (can_publish IN (0, 1)),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project, user_id)
) STRICT;

CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL REFERENCES projects(slug),
  slug           TEXT NOT NULL,
  description    TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  latest_version INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (project, slug)
) STRICT;

CREATE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_owner ON skills(owner_id);
CREATE INDEX idx_skills_visibility ON skills(visibility);

CREATE TABLE versions (
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_md    TEXT NOT NULL,
  html        TEXT NOT NULL,
  html_rev    INTEGER NOT NULL,
  files       TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (skill_id, version)
) STRICT;

CREATE INDEX idx_versions_author ON versions(author_id);

CREATE TABLE cli_logins (
  id               TEXT PRIMARY KEY,
  user_code        TEXT UNIQUE,
  device_code_hash TEXT UNIQUE,
  token_hash       TEXT UNIQUE,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'active')),
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_name      TEXT NOT NULL,
  request_country  TEXT,
  requested_scope  TEXT,
  poll_interval    INTEGER NOT NULL,
  last_polled_at   INTEGER,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  approved_at      INTEGER,
  last_used_at     INTEGER
) STRICT;

CREATE INDEX idx_cli_logins_user ON cli_logins(user_id);
CREATE INDEX idx_cli_logins_status_expires ON cli_logins(status, expires_at);
CREATE INDEX idx_cli_logins_status_used ON cli_logins(status, last_used_at);

CREATE TABLE cli_login_projects (
  login_id TEXT NOT NULL REFERENCES cli_logins(id) ON DELETE CASCADE,
  project  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (login_id, project),
  FOREIGN KEY (project, user_id) REFERENCES memberships(project, user_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_cli_login_projects_membership ON cli_login_projects(project, user_id);

CREATE TABLE device_code_attempts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  failures          INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
) STRICT;

CREATE TABLE download_logs (
  id          INTEGER PRIMARY KEY,
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  user_id     TEXT,
  username    TEXT,
  device_name TEXT,
  country     TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_download_logs_skill ON download_logs(skill_id, id);
CREATE INDEX idx_download_logs_user ON download_logs(user_id, id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_download_logs_created ON download_logs(created_at);

CREATE TABLE download_days (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  day      INTEGER NOT NULL,
  version  INTEGER NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  count    INTEGER NOT NULL,
  PRIMARY KEY (skill_id, day, version, source)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_download_days_day ON download_days(day);

CREATE TABLE download_user_days (
  user_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version  INTEGER NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  count    INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, skill_id, version, source)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_download_user_days_day ON download_user_days(day);
CREATE INDEX idx_download_user_days_skill ON download_user_days(skill_id);
`,
];
