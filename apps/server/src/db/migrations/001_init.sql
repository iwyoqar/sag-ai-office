-- SAG AI OFFICE — initial schema.
-- Portable SQL (SQLite in dev, PostgreSQL in prod): TEXT ids, ISO-8601 TEXT timestamps, JSON stored as TEXT.

-- ---------- identity & access ----------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Session tokens are stored hashed; the raw token only lives in the user's cookie.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------- organisation ----------
CREATE TABLE floors (
  id    TEXT PRIMARY KEY,
  level INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL
);

CREATE TABLE departments (
  id         TEXT PRIMARY KEY,
  floor_id   TEXT NOT NULL REFERENCES floors(id),
  name       TEXT NOT NULL,
  short      TEXT NOT NULL,
  color      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  focus      TEXT NOT NULL DEFAULT '[]',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_departments_floor ON departments(floor_id);

CREATE TABLE agents (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL,
  department_id         TEXT NOT NULL REFERENCES departments(id),
  status                TEXT NOT NULL DEFAULT 'IDLE' CHECK (status IN
                          ('IDLE','WORKING','THINKING','COMMUNICATING','WAITING_APPROVAL','BLOCKED','ERROR','COMPLETED')),
  lifecycle             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','PAUSED','ARCHIVED')),
  model                 TEXT,
  skills                TEXT NOT NULL DEFAULT '[]',
  responsibilities      TEXT NOT NULL DEFAULT '',
  max_tokens_per_task   INTEGER,
  max_cost_per_task_usd REAL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  archived_at           TEXT
);
CREATE INDEX idx_agents_department ON agents(department_id, lifecycle);

-- Global / department / agent instructions, versioned (covers AgentInstruction).
CREATE TABLE instructions (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('GLOBAL','DEPARTMENT','AGENT')),
  scope_id   TEXT,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (scope, scope_id, title, version)
);
CREATE INDEX idx_instructions_scope ON instructions(scope, scope_id, is_active);

-- ---------- connectors ----------
CREATE TABLE connectors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('oauth','api-key','mcp','internal')),
  auth_status     TEXT NOT NULL DEFAULT 'not_configured' CHECK (auth_status IN ('not_configured','configured','authenticated','error')),
  status          TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  last_sync_at    TEXT,
  last_health_at  TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);

-- Only a pointer into the secret store (env var name / vault path). Never the secret itself.
CREATE TABLE connector_credential_refs (
  id           TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  secret_ref   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE department_connectors (
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  connector_id  TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  PRIMARY KEY (department_id, connector_id)
);

CREATE TABLE agent_connector_permissions (
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connector_id    TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (agent_id, connector_id)
);

-- ---------- tasks ----------
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_by    TEXT REFERENCES users(id),
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  department_id TEXT REFERENCES departments(id),
  agent_id      TEXT REFERENCES agents(id),
  priority      TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  deadline      TEXT,
  status        TEXT NOT NULL DEFAULT 'BACKLOG' CHECK (status IN
                  ('BACKLOG','QUEUED','IN_PROGRESS','WAITING_FOR_DEPENDENCY','WAITING_APPROVAL','BLOCKED','FAILED','DONE','CANCELLED')),
  progress      INTEGER CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  stage         TEXT,
  result        TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  lease_owner   TEXT,
  lease_until   TEXT,
  limits        TEXT NOT NULL DEFAULT '{}',
  started_at    TEXT,
  completed_at  TEXT,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks(status, priority, created_at);
CREATE INDEX idx_tasks_department ON tasks(department_id, status);
CREATE INDEX idx_tasks_agent ON tasks(agent_id, status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_task_deps_on ON task_dependencies(depends_on_id);

-- Activity log + realtime event stream (SSE replays from here after reconnect/restart).
CREATE TABLE task_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id),
  department_id TEXT REFERENCES departments(id),
  actor         TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, id);
CREATE INDEX idx_task_events_created ON task_events(created_at);

CREATE TABLE agent_messages (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id TEXT REFERENCES agents(id),
  to_agent_id   TEXT REFERENCES agents(id),
  kind          TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','handoff','question','answer','note')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_agent_messages_task ON agent_messages(task_id, created_at);

CREATE TABLE deliverables (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id   TEXT REFERENCES agents(id),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'markdown',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_deliverables_task ON deliverables(task_id);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id     TEXT REFERENCES agents(id),
  action       TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  requested_at TEXT NOT NULL,
  decided_by   TEXT REFERENCES users(id),
  decided_at   TEXT,
  reason       TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, requested_at);

-- ---------- agent execution & usage ----------
CREATE TABLE agent_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  correlation_id TEXT NOT NULL,
  model          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','mock')),
  status         TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  error          TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);

CREATE TABLE tool_executions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool         TEXT NOT NULL,
  connector_id TEXT REFERENCES connectors(id),
  input        TEXT NOT NULL DEFAULT '{}',
  output       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','denied','pending_approval')),
  error        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_tool_exec_run ON tool_executions(run_id);

CREATE TABLE usage_records (
  id            TEXT PRIMARY KEY,
  run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_id      TEXT REFERENCES agents(id),
  department_id TEXT REFERENCES departments(id),
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  is_estimate   INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_usage_dept_time ON usage_records(department_id, created_at);
CREATE INDEX idx_usage_agent_time ON usage_records(agent_id, created_at);

-- ---------- scheduling ----------
CREATE TABLE routines (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  department_id     TEXT REFERENCES departments(id),
  agent_id          TEXT REFERENCES agents(id),
  rrule             TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  next_run_at       TEXT,
  last_run_at       TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_routines_next ON routines(status, next_run_at);

CREATE TABLE routine_runs (
  id            TEXT PRIMARY KEY,
  routine_id    TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','skipped')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT,
  UNIQUE (routine_id, scheduled_for)
);

-- ---------- knowledge (The Brain) ----------
CREATE TABLE knowledge_sources (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('upload','connector','manual')),
  created_at TEXT NOT NULL
);

CREATE TABLE knowledge_documents (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  filename      TEXT,
  mime          TEXT,
  size_bytes    INTEGER,
  sha256        TEXT,
  department_id TEXT REFERENCES departments(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexed','failed')),
  error         TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE knowledge_chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  content     TEXT NOT NULL,
  tokens      INTEGER,
  UNIQUE (document_id, ord)
);

CREATE TABLE company_memory (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('decision','correction','lesson','rule','result')),
  content       TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  department_id TEXT REFERENCES departments(id),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- ---------- audit ----------
CREATE TABLE audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_id       TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  correlation_id TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
