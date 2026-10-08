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
);

CREATE INDEX idx_cli_logins_user ON cli_logins(user_id);

CREATE TABLE cli_login_projects (
  login_id TEXT NOT NULL REFERENCES cli_logins(id) ON DELETE CASCADE,
  project  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  PRIMARY KEY (login_id, project)
);

CREATE INDEX idx_cli_login_projects_project ON cli_login_projects(project);

CREATE TABLE device_code_attempts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  failures          INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
