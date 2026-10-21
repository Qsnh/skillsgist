CREATE TABLE download_rollup (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  last_id INTEGER NOT NULL
);

INSERT INTO download_rollup (id, last_id) SELECT 1, COALESCE(MAX(id), 0) FROM download_logs;
