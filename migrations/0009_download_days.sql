DROP INDEX idx_download_logs_skill_time;

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

INSERT INTO download_days (skill_id, day, version, source, count)
SELECT skill_id, created_at / 86400000, version, source, COUNT(*)
FROM download_logs
GROUP BY skill_id, created_at / 86400000, version, source;
