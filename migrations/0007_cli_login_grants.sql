CREATE TABLE cli_login_projects_next (
  login_id TEXT NOT NULL REFERENCES cli_logins(id) ON DELETE CASCADE,
  project  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (login_id, project),
  FOREIGN KEY (project, user_id) REFERENCES memberships(project, user_id) ON DELETE CASCADE
);

INSERT INTO cli_login_projects_next (login_id, project, user_id)
SELECT clp.login_id, clp.project, l.user_id
FROM cli_login_projects clp
JOIN cli_logins l ON l.id = clp.login_id
JOIN memberships m ON m.project = clp.project AND m.user_id = l.user_id;

DROP TABLE cli_login_projects;

ALTER TABLE cli_login_projects_next RENAME TO cli_login_projects;

CREATE INDEX idx_cli_login_projects_membership ON cli_login_projects(project, user_id);

CREATE INDEX idx_cli_logins_status_expires ON cli_logins(status, expires_at);

CREATE INDEX idx_cli_logins_status_used ON cli_logins(status, last_used_at);
