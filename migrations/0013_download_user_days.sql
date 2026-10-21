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

INSERT INTO download_user_days (user_id, day, skill_id, version, source, count)
SELECT user_id, created_at / 86400000, skill_id, version, source, COUNT(*)
FROM download_logs
WHERE user_id IS NOT NULL
  AND id <= (SELECT last_id FROM download_rollup)
  AND skill_id IN (SELECT id FROM skills)
GROUP BY 1, 2, 3, 4, 5;
