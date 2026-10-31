-- migrate: foreign_keys=off
-- T1 Unified Task Engine (WORK_MANAGEMENT_ROADMAP.md; owner decisions 2026-10-31).
--
-- One task table for people and AI agents, extended rather than replaced:
-- * `lifecycle`: the business lifecycle (BACKLOG … COMPLETED / CANCELLED). The existing `status` stays the AI execution
--   status and the legacy flows' status; triggers below keep `lifecycle` in step whenever `status` changes, so every
--   writer (engine, people's work, AI runtime, store units) is covered. The engine also sets lifecycle-only states
--   (PLANNED, APPROVED) that have no legacy status.
-- * `version`: optimistic concurrency; bumped on every business change.
-- * `start_at` (planned start; the due date stays `deadline`), `idempotency_key` (one task per creator and key).
-- * priority URGENT is renamed CRITICAL (tasks, routines, workload policy).
-- * `task_assignments`: HUMAN / AI_AGENT × OWNER / CONTRIBUTOR / REVIEWER / APPROVER, with assignment state. The legacy
--   single-assignee columns stay and are mirrored into assignments by triggers.
-- * `task_transitions`: append-only log of every lifecycle change with its actor (`last_actor`, set by the writer).
-- SQLite cannot change a CHECK, so tasks and routines are rebuilt (foreign keys off, checked before commit).

-- ---------- tasks rebuild ----------
DROP TRIGGER IF EXISTS trg_task_dep_unit;
DROP TRIGGER IF EXISTS trg_task_dep_unit_upd;

CREATE TABLE tasks_new (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  created_by        TEXT REFERENCES users(id),
  parent_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  department_id     TEXT REFERENCES departments(id),
  agent_id          TEXT REFERENCES agents(id),
  priority          TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
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
  business_unit_id  TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id),
  lease_epoch       INTEGER NOT NULL DEFAULT 0,
  plan              TEXT,
  revision_of       TEXT REFERENCES tasks(id),
  -- T1
  lifecycle         TEXT NOT NULL DEFAULT 'BACKLOG' CHECK (lifecycle IN
                      ('BACKLOG','PLANNED','ASSIGNED','IN_PROGRESS','BLOCKED','IN_REVIEW','REVISION','APPROVED','COMPLETED','CANCELLED')),
  version           INTEGER NOT NULL DEFAULT 0,
  start_at          TEXT,
  idempotency_key   TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 200),
  blocked_reason    TEXT,
  last_actor        TEXT,
  CHECK (kind <> 'human' OR agent_id IS NULL),
  CHECK (assignee_user_id IS NULL OR kind = 'human')
);
INSERT INTO tasks_new (id, title, description, created_by, parent_id, department_id, agent_id, priority, deadline, status,
  progress, stage, result, error, attempts, max_attempts, lease_owner, lease_until, limits, started_at, completed_at,
  tokens_in, tokens_out, cost_usd, created_at, updated_at, kind, requires_approval, scheduled_for, assignee_user_id,
  assigned_by, reviewer_user_id, estimate_hours, actual_hours, is_optional, weight, decline_reason, accepted_at,
  submitted_at, business_unit_id, lease_epoch, plan, revision_of, lifecycle)
SELECT id, title, description, created_by, parent_id, department_id, agent_id,
  CASE priority WHEN 'URGENT' THEN 'CRITICAL' ELSE priority END, deadline, status,
  progress, stage, result, error, attempts, max_attempts, lease_owner, lease_until, limits, started_at, completed_at,
  tokens_in, tokens_out, cost_usd, created_at, updated_at, kind, requires_approval, scheduled_for, assignee_user_id,
  assigned_by, reviewer_user_id, estimate_hours, actual_hours, is_optional, weight, decline_reason, accepted_at,
  submitted_at, business_unit_id, lease_epoch, plan, revision_of,
  CASE status
    WHEN 'QUEUED' THEN 'ASSIGNED' WHEN 'WAITING_FOR_DEPENDENCY' THEN 'PLANNED' WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
    WHEN 'WAITING_APPROVAL' THEN 'IN_REVIEW' WHEN 'BLOCKED' THEN 'BLOCKED' WHEN 'FAILED' THEN 'BLOCKED'
    WHEN 'DONE' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'ASSIGNED' THEN 'ASSIGNED'
    WHEN 'ACCEPTED' THEN 'ASSIGNED' WHEN 'IN_REVIEW' THEN 'IN_REVIEW' WHEN 'CHANGES_REQUESTED' THEN 'REVISION'
    ELSE 'BACKLOG' END
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
CREATE INDEX idx_tasks_unit ON tasks(business_unit_id, status);
CREATE INDEX idx_tasks_lifecycle ON tasks(business_unit_id, lifecycle, priority);
CREATE UNIQUE INDEX ux_tasks_idempotency ON tasks(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER trg_task_unit BEFORE INSERT ON tasks
WHEN (SELECT level FROM org_nodes WHERE id = NEW.business_unit_id) IS NOT 'UNIT'
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.business_unit_id)
  OR (NEW.agent_id IS NOT NULL AND (SELECT business_unit_id FROM agents WHERE id = NEW.agent_id) <> NEW.business_unit_id)
  OR (NEW.parent_id IS NOT NULL AND (SELECT business_unit_id FROM tasks WHERE id = NEW.parent_id) <> NEW.business_unit_id)
  OR (NEW.assignee_user_id IS NOT NULL AND (SELECT home_unit_id FROM users WHERE id = NEW.assignee_user_id) <> NEW.business_unit_id)
  OR (NEW.reviewer_user_id IS NOT NULL AND (SELECT home_unit_id FROM users WHERE id = NEW.reviewer_user_id) <> NEW.business_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task references another unit'); END;
CREATE TRIGGER trg_task_unit_upd BEFORE UPDATE OF business_unit_id, department_id, agent_id, parent_id, assignee_user_id, reviewer_user_id ON tasks
WHEN NEW.business_unit_id IS NOT OLD.business_unit_id
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.business_unit_id)
  OR (NEW.agent_id IS NOT NULL AND (SELECT business_unit_id FROM agents WHERE id = NEW.agent_id) <> NEW.business_unit_id)
  OR (NEW.parent_id IS NOT NULL AND (SELECT business_unit_id FROM tasks WHERE id = NEW.parent_id) <> NEW.business_unit_id)
  OR (NEW.assignee_user_id IS NOT NULL AND (SELECT home_unit_id FROM users WHERE id = NEW.assignee_user_id) <> NEW.business_unit_id)
  OR (NEW.reviewer_user_id IS NOT NULL AND (SELECT home_unit_id FROM users WHERE id = NEW.reviewer_user_id) <> NEW.business_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task references another unit'); END;
CREATE TRIGGER trg_task_dep_unit BEFORE INSERT ON task_dependencies
WHEN (SELECT business_unit_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT business_unit_id FROM tasks WHERE id = NEW.depends_on_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task dependency references another unit'); END;
CREATE TRIGGER trg_task_dep_unit_upd BEFORE UPDATE ON task_dependencies
WHEN (SELECT business_unit_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT business_unit_id FROM tasks WHERE id = NEW.depends_on_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task dependency references another unit'); END;

-- ---------- routines: priority rename ----------
CREATE TABLE routines_new (
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
  created_at        TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);
INSERT INTO routines_new (id, name, description, department_id, agent_id, rrule, timezone, next_run_at, last_run_at, status,
  requires_approval, created_by, created_at, priority)
SELECT id, name, description, department_id, agent_id, rrule, timezone, next_run_at, last_run_at, status,
  requires_approval, created_by, created_at, CASE priority WHEN 'URGENT' THEN 'CRITICAL' ELSE priority END
FROM routines;
DROP TABLE routines;
ALTER TABLE routines_new RENAME TO routines;
CREATE INDEX idx_routines_next ON routines(status, next_run_at);

-- workload policy: default hours per priority
UPDATE settings
SET value = json_set(json_remove(value, '$.defaultHours.URGENT'), '$.defaultHours.CRITICAL', json_extract(value, '$.defaultHours.URGENT'))
WHERE key = 'workload' AND json_valid(value) AND json_extract(value, '$.defaultHours.URGENT') IS NOT NULL;

-- ---------- lifecycle transitions log ----------
CREATE TABLE task_transitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  business_unit_id TEXT NOT NULL,
  from_lifecycle   TEXT,
  to_lifecycle     TEXT NOT NULL,
  status           TEXT NOT NULL,
  -- 'user:<id>', 'agent:<id>' or 'system'
  actor            TEXT NOT NULL,
  reason           TEXT,
  at               TEXT NOT NULL
);
CREATE INDEX idx_task_transitions_task ON task_transitions(task_id, id);
CREATE INDEX idx_task_transitions_unit ON task_transitions(business_unit_id, to_lifecycle, at);

-- the creation of every task is its first transition
INSERT INTO task_transitions (task_id, business_unit_id, from_lifecycle, to_lifecycle, status, actor, reason, at)
SELECT id, business_unit_id, NULL, lifecycle, status, COALESCE('user:' || created_by, 'system'), 'migrated (022)', created_at FROM tasks;

-- legacy status → lifecycle (domain/taskEngine.ts LIFECYCLE_OF mirrors this mapping)
CREATE TRIGGER trg_task_lifecycle_ins AFTER INSERT ON tasks
BEGIN
  -- the creation is logged once, with the state the task starts in; the follow-up update is marked so the log
  -- trigger below does not record it as a second transition
  INSERT INTO task_transitions (task_id, business_unit_id, from_lifecycle, to_lifecycle, status, actor, at)
  VALUES (NEW.id, NEW.business_unit_id, NULL, CASE NEW.status
      WHEN 'QUEUED' THEN 'ASSIGNED' WHEN 'WAITING_FOR_DEPENDENCY' THEN 'PLANNED' WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
      WHEN 'WAITING_APPROVAL' THEN 'IN_REVIEW' WHEN 'BLOCKED' THEN 'BLOCKED' WHEN 'FAILED' THEN 'BLOCKED'
      WHEN 'DONE' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'ASSIGNED' THEN 'ASSIGNED'
      WHEN 'ACCEPTED' THEN 'ASSIGNED' WHEN 'IN_REVIEW' THEN 'IN_REVIEW' WHEN 'CHANGES_REQUESTED' THEN 'REVISION'
      ELSE NEW.lifecycle END, NEW.status,
    COALESCE(NEW.last_actor, 'user:' || NEW.created_by, 'system'), NEW.created_at);
  UPDATE tasks SET lifecycle = CASE NEW.status
      WHEN 'QUEUED' THEN 'ASSIGNED' WHEN 'WAITING_FOR_DEPENDENCY' THEN 'PLANNED' WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
      WHEN 'WAITING_APPROVAL' THEN 'IN_REVIEW' WHEN 'BLOCKED' THEN 'BLOCKED' WHEN 'FAILED' THEN 'BLOCKED'
      WHEN 'DONE' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'ASSIGNED' THEN 'ASSIGNED'
      WHEN 'ACCEPTED' THEN 'ASSIGNED' WHEN 'IN_REVIEW' THEN 'IN_REVIEW' WHEN 'CHANGES_REQUESTED' THEN 'REVISION'
      ELSE NEW.lifecycle END, last_actor = '#create' WHERE id = NEW.id;
  UPDATE tasks SET last_actor = NULL WHERE id = NEW.id;
END;

-- a status change by any writer moves the lifecycle along (unless the same statement set the lifecycle itself)
CREATE TRIGGER trg_task_lifecycle_sync AFTER UPDATE OF status ON tasks
WHEN NEW.status IS NOT OLD.status AND NEW.lifecycle IS OLD.lifecycle
BEGIN
  UPDATE tasks SET lifecycle = CASE NEW.status
      WHEN 'BACKLOG' THEN CASE WHEN NEW.lifecycle = 'PLANNED' THEN 'PLANNED' ELSE 'BACKLOG' END
      WHEN 'QUEUED' THEN 'ASSIGNED' WHEN 'WAITING_FOR_DEPENDENCY' THEN 'PLANNED' WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
      WHEN 'WAITING_APPROVAL' THEN 'IN_REVIEW' WHEN 'BLOCKED' THEN 'BLOCKED' WHEN 'FAILED' THEN 'BLOCKED'
      WHEN 'DONE' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'ASSIGNED' THEN 'ASSIGNED'
      WHEN 'ACCEPTED' THEN 'ASSIGNED' WHEN 'IN_REVIEW' THEN CASE WHEN NEW.lifecycle = 'APPROVED' THEN 'APPROVED' ELSE 'IN_REVIEW' END
      WHEN 'CHANGES_REQUESTED' THEN 'REVISION'
      ELSE NEW.lifecycle END
  WHERE id = NEW.id;
  UPDATE tasks SET last_actor = NULL WHERE id = NEW.id;
END;

-- every lifecycle change is logged with the actor the writer named (system when none)
CREATE TRIGGER trg_task_lifecycle_log AFTER UPDATE OF lifecycle ON tasks
WHEN NEW.lifecycle IS NOT OLD.lifecycle AND NEW.last_actor IS NOT '#create'
BEGIN
  INSERT INTO task_transitions (task_id, business_unit_id, from_lifecycle, to_lifecycle, status, actor, reason, at)
  VALUES (NEW.id, NEW.business_unit_id, OLD.lifecycle, NEW.lifecycle, NEW.status, COALESCE(NEW.last_actor, 'system'),
    CASE WHEN NEW.lifecycle = 'BLOCKED' THEN NEW.blocked_reason END, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE tasks SET last_actor = NULL WHERE id = NEW.id;
END;

-- optimistic concurrency: any business change moves the version on (lease renewals and progress do not)
CREATE TRIGGER trg_task_version AFTER UPDATE OF status, lifecycle, title, description, priority, deadline, start_at,
  department_id, agent_id, assignee_user_id, reviewer_user_id, parent_id, requires_approval ON tasks
WHEN NEW.version = OLD.version
BEGIN
  UPDATE tasks SET version = OLD.version + 1 WHERE id = NEW.id;
END;

-- ---------- assignments ----------
CREATE TABLE task_assignments (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  business_unit_id TEXT NOT NULL REFERENCES org_nodes(id),
  assignee_type    TEXT NOT NULL CHECK (assignee_type IN ('HUMAN', 'AI_AGENT')),
  user_id          TEXT REFERENCES users(id),
  agent_id         TEXT REFERENCES agents(id),
  role             TEXT NOT NULL CHECK (role IN ('OWNER', 'CONTRIBUTOR', 'REVIEWER', 'APPROVER')),
  state            TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (state IN ('ASSIGNED', 'ACCEPTED', 'DECLINED', 'RELEASED')),
  assigned_by      TEXT,
  assigned_at      TEXT NOT NULL,
  accepted_at      TEXT,
  released_at      TEXT,
  reason           TEXT,
  CHECK ((assignee_type = 'HUMAN' AND user_id IS NOT NULL AND agent_id IS NULL)
      OR (assignee_type = 'AI_AGENT' AND agent_id IS NOT NULL AND user_id IS NULL)),
  -- final approval is a person's decision (owner decision 4)
  CHECK (NOT (assignee_type = 'AI_AGENT' AND role = 'APPROVER'))
);
-- one active assignment per task, role and assignee
CREATE UNIQUE INDEX ux_task_assignments_active ON task_assignments(task_id, role, COALESCE(user_id, ''), COALESCE(agent_id, ''))
  WHERE state IN ('ASSIGNED', 'ACCEPTED');
CREATE INDEX idx_task_assignments_user ON task_assignments(user_id, state);
CREATE INDEX idx_task_assignments_agent ON task_assignments(agent_id, state);
CREATE INDEX idx_task_assignments_task ON task_assignments(task_id, state);

-- assignees belong to the task's unit (cross-unit work goes through an authorised handoff, never a direct assignment)
CREATE TRIGGER trg_task_assignment_unit BEFORE INSERT ON task_assignments
WHEN NEW.business_unit_id IS NOT (SELECT business_unit_id FROM tasks WHERE id = NEW.task_id)
  OR (NEW.user_id IS NOT NULL AND (SELECT home_unit_id FROM users WHERE id = NEW.user_id) IS NOT NEW.business_unit_id)
  OR (NEW.agent_id IS NOT NULL AND (SELECT business_unit_id FROM agents WHERE id = NEW.agent_id) IS NOT NEW.business_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: assignee belongs to another unit'); END;

-- backfill from the legacy single-assignee columns
INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at, accepted_at)
SELECT 'asg_' || lower(hex(randomblob(10))), id, business_unit_id, 'HUMAN', assignee_user_id, 'OWNER',
  CASE WHEN accepted_at IS NOT NULL OR status IN ('ACCEPTED','IN_PROGRESS','IN_REVIEW','CHANGES_REQUESTED','DONE') THEN 'ACCEPTED' ELSE 'ASSIGNED' END,
  assigned_by, created_at, accepted_at
FROM tasks WHERE assignee_user_id IS NOT NULL;
INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at)
SELECT 'asg_' || lower(hex(randomblob(10))), id, business_unit_id, 'HUMAN', reviewer_user_id, 'REVIEWER', 'ASSIGNED', assigned_by, created_at
FROM tasks WHERE reviewer_user_id IS NOT NULL;
INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, agent_id, role, state, assigned_at, accepted_at)
SELECT 'asg_' || lower(hex(randomblob(10))), id, business_unit_id, 'AI_AGENT', agent_id, 'OWNER', 'ACCEPTED', created_at, created_at
FROM tasks WHERE agent_id IS NOT NULL;

-- the legacy columns keep working: whoever sets them, the matching assignment follows
CREATE TRIGGER trg_task_assign_legacy_ins AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at, accepted_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'HUMAN', NEW.assignee_user_id, 'OWNER',
    CASE WHEN NEW.accepted_at IS NOT NULL THEN 'ACCEPTED' ELSE 'ASSIGNED' END, NEW.assigned_by, NEW.created_at, NEW.accepted_at
  WHERE NEW.assignee_user_id IS NOT NULL;
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'HUMAN', NEW.reviewer_user_id, 'REVIEWER', 'ASSIGNED', NEW.assigned_by, NEW.created_at
  WHERE NEW.reviewer_user_id IS NOT NULL;
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, agent_id, role, state, assigned_at, accepted_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'AI_AGENT', NEW.agent_id, 'OWNER', 'ACCEPTED', NEW.created_at, NEW.created_at
  WHERE NEW.agent_id IS NOT NULL;
END;

CREATE TRIGGER trg_task_assign_legacy_owner AFTER UPDATE OF assignee_user_id ON tasks
WHEN NEW.assignee_user_id IS NOT OLD.assignee_user_id
BEGIN
  UPDATE task_assignments
  SET state = CASE WHEN NEW.assignee_user_id IS NULL AND NEW.decline_reason IS NOT NULL AND NEW.decline_reason IS NOT OLD.decline_reason THEN 'DECLINED' ELSE 'RELEASED' END,
      released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reason = NEW.decline_reason
  WHERE task_id = NEW.id AND role = 'OWNER' AND user_id IS OLD.assignee_user_id AND state IN ('ASSIGNED', 'ACCEPTED');
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at, accepted_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'HUMAN', NEW.assignee_user_id, 'OWNER',
    CASE WHEN NEW.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at THEN 'ACCEPTED' ELSE 'ASSIGNED' END,
    NEW.assigned_by, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), CASE WHEN NEW.accepted_at IS NOT OLD.accepted_at THEN NEW.accepted_at END
  WHERE NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_assignments WHERE task_id = NEW.id AND role = 'OWNER' AND user_id = NEW.assignee_user_id AND state IN ('ASSIGNED', 'ACCEPTED'));
END;

CREATE TRIGGER trg_task_assign_legacy_accept AFTER UPDATE OF accepted_at ON tasks
WHEN NEW.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at AND NEW.assignee_user_id IS NOT NULL
BEGIN
  UPDATE task_assignments SET state = 'ACCEPTED', accepted_at = NEW.accepted_at
  WHERE task_id = NEW.id AND role = 'OWNER' AND user_id = NEW.assignee_user_id AND state = 'ASSIGNED';
END;

CREATE TRIGGER trg_task_assign_legacy_reviewer AFTER UPDATE OF reviewer_user_id ON tasks
WHEN NEW.reviewer_user_id IS NOT OLD.reviewer_user_id
BEGIN
  UPDATE task_assignments SET state = 'RELEASED', released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE task_id = NEW.id AND role = 'REVIEWER' AND user_id IS OLD.reviewer_user_id AND state IN ('ASSIGNED', 'ACCEPTED');
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, state, assigned_by, assigned_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'HUMAN', NEW.reviewer_user_id, 'REVIEWER', 'ASSIGNED',
    NEW.assigned_by, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.reviewer_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_assignments WHERE task_id = NEW.id AND role = 'REVIEWER' AND user_id = NEW.reviewer_user_id AND state IN ('ASSIGNED', 'ACCEPTED'));
END;

CREATE TRIGGER trg_task_assign_legacy_agent AFTER UPDATE OF agent_id ON tasks
WHEN NEW.agent_id IS NOT OLD.agent_id
BEGIN
  UPDATE task_assignments SET state = 'RELEASED', released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE task_id = NEW.id AND role = 'OWNER' AND agent_id IS OLD.agent_id AND state IN ('ASSIGNED', 'ACCEPTED');
  INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, agent_id, role, state, assigned_at, accepted_at)
  SELECT 'asg_' || lower(hex(randomblob(10))), NEW.id, NEW.business_unit_id, 'AI_AGENT', NEW.agent_id, 'OWNER', 'ACCEPTED',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_assignments WHERE task_id = NEW.id AND role = 'OWNER' AND agent_id = NEW.agent_id AND state IN ('ASSIGNED', 'ACCEPTED'));
END;
