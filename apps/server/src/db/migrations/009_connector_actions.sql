-- Connector credentials obtained at runtime (OAuth refresh tokens). Encrypted with AES-256-GCM; the key
-- (SECRETS_KEY) lives only in the server environment, never in the database.
CREATE TABLE connector_secrets (
  provider   TEXT PRIMARY KEY,               -- 'google'
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  account    TEXT,                           -- connected account (e-mail), shown in the UI
  scopes     TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Agent actions: which approval a tool call waits for, and what it returned.
ALTER TABLE tool_executions ADD COLUMN approval_id TEXT REFERENCES approvals(id);
ALTER TABLE tool_executions ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE tool_executions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tool_exec_task ON tool_executions(task_id, started_at);
CREATE INDEX idx_tool_exec_approval ON tool_executions(approval_id);
