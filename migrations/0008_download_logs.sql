CREATE TABLE download_logs (
  id          INTEGER PRIMARY KEY,
  skill_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  user_id     TEXT,
  username    TEXT,
  device_name TEXT,
  country     TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_download_logs_skill_source ON download_logs(skill_id, source);

CREATE INDEX idx_download_logs_user ON download_logs(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE download_days (
  skill_id TEXT NOT NULL,
  day      INTEGER NOT NULL,
  version  INTEGER NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  count    INTEGER NOT NULL,
  PRIMARY KEY (skill_id, day, version, source)
) WITHOUT ROWID;

CREATE INDEX idx_download_days_day ON download_days(day);

CREATE TABLE download_user_days (
  user_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  version  INTEGER NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  count    INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, skill_id, version, source)
) WITHOUT ROWID;

CREATE INDEX idx_download_user_days_day ON download_user_days(day);

CREATE TABLE download_purges (
  skill_id TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE download_rollup (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  last_id INTEGER NOT NULL
);

INSERT INTO download_rollup (id, last_id) VALUES (1, 0);
