-- migrate: foreign_keys=off
-- Human employees, organisation hierarchy, scoped permissions, human task workflow, reviews, comments,
-- attachments, notifications. (Foreign keys are off only while `tasks` is rebuilt; checked again afterwards.)

-- ---------- employees = users with employee fields ----------
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES departments(id);
ALTER TABLE users ADD COLUMN floor_id TEXT REFERENCES floors(id);
ALTER TABLE users ADD COLUMN manager_id TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived'));
ALTER TABLE users ADD COLUMN start_date TEXT;
ALTER TABLE users ADD COLUMN capacity_hours_week REAL NOT NULL DEFAULT 40 CHECK (capacity_hours_week >= 0 AND capacity_hours_week <= 80);
ALTER TABLE users ADD COLUMN work_start TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE users ADD COLUMN work_end TEXT NOT NULL DEFAULT '18:00';
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent';
ALTER TABLE users ADD COLUMN last_activity_at TEXT;
ALTER TABLE users ADD COLUMN telegram_user_id INTEGER;
ALTER TABLE users ADD COLUMN workload_level TEXT;
UPDATE users SET status = CASE WHEN is_active = 1 THEN 'active' ELSE 'inactive' END;
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_department ON users(department_id, status);
CREATE INDEX idx_users_manager ON users(manager_id);

CREATE TABLE user_avatars (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE departments ADD COLUMN head_user_id TEXT REFERENCES users(id);

-- ---------- roles & permissions ----------
INSERT OR IGNORE INTO roles (id, description) VALUES
  ('department_head', 'Bo''lim rahbari'),
  ('employee', 'Xodim');
INSERT OR IGNORE INTO permissions (id) VALUES
  ('employees:read_all'), ('employees:manage_all'), ('employees:manage_dept'),
  ('tasks:assign_any'), ('tasks:assign_dept'), ('tasks:read_all'), ('tasks:read_team'),
  ('permissions:delegate'), ('workload:configure');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'admin', id FROM permissions WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'admin');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'director', p FROM (
    SELECT 'employees:read_all' p UNION ALL SELECT 'tasks:assign_any' UNION ALL SELECT 'tasks:read_all'
    UNION ALL SELECT 'permissions:delegate' UNION ALL SELECT 'workload:configure'
  ) WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'director');
-- (fresh databases get these from the seed, which runs after migrations)
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r, p FROM (
    SELECT 'department_head' r, 'tasks:read' p UNION ALL SELECT 'department_head', 'tasks:create'
    UNION ALL SELECT 'department_head', 'agents:read' UNION ALL SELECT 'department_head', 'employees:manage_dept'
    UNION ALL SELECT 'department_head', 'tasks:assign_dept'
    UNION ALL SELECT 'employee', 'tasks:read' UNION ALL SELECT 'employee', 'tasks:create' UNION ALL SELECT 'employee', 'agents:read'
  ) WHERE EXISTS (SELECT 1 FROM permissions WHERE id = 'tasks:read');

-- Per-user grants on top of roles; department_id NULL = everywhere. can_delegate = the holder may pass it on
-- (within its own scope). Granting is audited.
CREATE TABLE user_permissions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  department_id TEXT REFERENCES departments(id),
  can_delegate  INTEGER NOT NULL DEFAULT 0,
  granted_by    TEXT REFERENCES users(id),
  granted_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_user_permissions ON user_permissions(user_id, permission_id, IFNULL(department_id, ''));

-- ---------- tasks: rebuild to extend the status / kind checks (SQLite cannot alter a CHECK) ----------
CREATE TABLE tasks_new (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  created_by        TEXT REFERENCES users(id),
  parent_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  department_id     TEXT REFERENCES departments(id),
  agent_id          TEXT REFERENCES agents(id),
  priority          TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  deadline          TEXT,
  status            TEXT NOT NULL DEFAULT 'BACKLOG' CHECK (status IN
                      ('BACKLOG','QUEUED','IN_PROGRESS','WAITING_FOR_DEPENDENCY','WAITING_APPROVAL','BLOCKED','FAILED','DONE','CANCELLED',
                       'ASSIGNED','ACCEPTED','IN_REVIEW','CHANGES_REQUESTED')),
  progress          INTEGER CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  stage             TEXT,
  result            TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  lease_owner       TEXT,
  lease_until       TEXT,
  limits            TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT,
  completed_at      TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'orchestrate', 'human')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  scheduled_for     TEXT,
  -- human workflow
  assignee_user_id  TEXT REFERENCES users(id),
  assigned_by       TEXT REFERENCES users(id),
  reviewer_user_id  TEXT REFERENCES users(id),
  estimate_hours    REAL CHECK (estimate_hours IS NULL OR (estimate_hours >= 0 AND estimate_hours <= 1000)),
  actual_hours      REAL CHECK (actual_hours IS NULL OR (actual_hours >= 0 AND actual_hours <= 10000)),
  is_optional       INTEGER NOT NULL DEFAULT 0,
  weight            REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
  decline_reason    TEXT,
  accepted_at       TEXT,
  submitted_at      TEXT,
  -- a human task must not be run by an agent, and only human tasks have a human assignee
  CHECK (kind <> 'human' OR agent_id IS NULL),
  CHECK (assignee_user_id IS NULL OR kind = 'human')
);
INSERT INTO tasks_new (id, title, description, created_by, parent_id, department_id, agent_id, priority, deadline, status,
  progress, stage, result, error, attempts, max_attempts, lease_owner, lease_until, limits, started_at, completed_at,
  tokens_in, tokens_out, cost_usd, created_at, updated_at, kind, requires_approval, scheduled_for)
SELECT id, title, description, created_by, parent_id, department_id, agent_id, priority, deadline, status,
  progress, stage, result, error, attempts, max_attempts, lease_owner, lease_until, limits, started_at, completed_at,
  tokens_in, tokens_out, cost_usd, created_at, updated_at, kind, requires_approval, scheduled_for
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_status ON tasks(status, priority, created_at);
CREATE INDEX idx_tasks_department ON tasks(department_id, status);
CREATE INDEX idx_tasks_agent ON tasks(agent_id, status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_scheduled ON tasks(status, scheduled_for);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_user_id, status);
CREATE INDEX idx_tasks_reviewer ON tasks(reviewer_user_id, status);

-- ---------- collaboration ----------
CREATE TABLE task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id),
  kind       TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'progress', 'result', 'decline', 'review', 'system')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

CREATE TABLE task_reviews (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decision    TEXT NOT NULL CHECK (decision IN ('APPROVED', 'CHANGES_REQUESTED')),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_task_reviews_task ON task_reviews(task_id, created_at);

CREATE TABLE task_attachments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_attachments_task ON task_attachments(task_id);

-- ---------- notifications (source of truth stays in tasks; this is the delivery log) ----------
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at    TEXT,
  sent_telegram_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at);
