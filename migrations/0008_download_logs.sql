CREATE TABLE download_logs (
  id          INTEGER PRIMARY KEY,
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('web', 'device', 'install_key', 'anonymous')),
  user_id     TEXT,
  username    TEXT,
  device_name TEXT,
  country     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_download_logs_skill_time ON download_logs(skill_id, created_at);
