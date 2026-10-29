-- Scheduled one-off tasks and routine tracking; user management fields.

-- A task with scheduled_for stays in BACKLOG until that moment, then the scheduler queues it.
ALTER TABLE tasks ADD COLUMN scheduled_for TEXT;
CREATE INDEX idx_tasks_scheduled ON tasks(status, scheduled_for);

ALTER TABLE routines ADD COLUMN priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT'));
CREATE INDEX idx_routine_runs_task ON routine_runs(task_id);

-- Users: last login, who created them (user management UI).
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id);
