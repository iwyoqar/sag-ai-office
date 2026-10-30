-- migrate: foreign_keys=off
-- Reliable agent execution (W0): fenced leases, execution records, worker liveness, explicit tool outcomes.
-- (Foreign keys are off only while tool_executions is rebuilt to extend its status check; verified afterwards.)

-- Every claim increments lease_epoch. A worker may write to a task only while lease_owner and lease_epoch are still
-- its own, so a run that lost its lease (expiry, recovery, shutdown) can never overwrite the next run's work.
ALTER TABLE tasks ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;

-- Which worker/claim produced a run, and why it ended (succeeded, retryable_error, final_error, aborted,
-- lost_lease, shutdown, orphaned).
ALTER TABLE agent_runs ADD COLUMN worker_id TEXT;
ALTER TABLE agent_runs ADD COLUMN lease_epoch INTEGER;
ALTER TABLE agent_runs ADD COLUMN end_reason TEXT;

-- Live workers. A task held by a worker whose heartbeat is stale is recovered at once, without waiting for the
-- lease to run out.
CREATE TABLE worker_heartbeats (
  worker_id    TEXT PRIMARY KEY,
  pid          INTEGER NOT NULL,
  host         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- tool_executions: + 'unknown' (an approved external action was interrupted mid-call: a person must check the
-- external system — it is never retried automatically), + idempotency_key (one pending request per identical action).
CREATE TABLE tool_executions_new (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  connector_id    TEXT REFERENCES connectors(id),
  input           TEXT NOT NULL DEFAULT '{}',
  output          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','denied','pending_approval','unknown')),
  error           TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  approval_id     TEXT REFERENCES approvals(id),
  agent_id        TEXT REFERENCES agents(id),
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  idempotency_key TEXT
);
INSERT INTO tool_executions_new (id, run_id, tool, connector_id, input, output, status, error, started_at, finished_at, approval_id, agent_id, task_id)
  SELECT id, run_id, tool, connector_id, input, output, status, error, started_at, finished_at, approval_id, agent_id, task_id FROM tool_executions;
DROP TABLE tool_executions;
ALTER TABLE tool_executions_new RENAME TO tool_executions;
CREATE INDEX idx_tool_exec_run ON tool_executions(run_id);
CREATE INDEX idx_tool_exec_task ON tool_executions(task_id, started_at);
CREATE INDEX idx_tool_exec_approval ON tool_executions(approval_id);
CREATE UNIQUE INDEX ux_tool_exec_pending ON tool_executions(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'pending_approval';
