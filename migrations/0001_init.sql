CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  install_key    TEXT NOT NULL UNIQUE,
  api_token_hash TEXT,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- Every `PUT /api/skills/:slug` looks a user up by this hash; without an
-- index that is a full table scan (username and install_key get one for
-- free from their UNIQUE constraints).
CREATE INDEX idx_users_api_token_hash ON users(api_token_hash);

CREATE TABLE skills (
  slug           TEXT PRIMARY KEY,
  description    TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  owner_id       TEXT NOT NULL REFERENCES users(id),
  latest_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_skills_visibility ON skills(visibility);

CREATE TABLE versions (
  slug        TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  skill_md    TEXT NOT NULL,
  html        TEXT NOT NULL,
  files       TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);
