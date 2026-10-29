-- Agent runtime: task kinds (orchestrated parents) and per-agent chat history.

-- single      = one agent does the task
-- orchestrate = the Director agent splits it into subtasks, then writes the combined result
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'orchestrate'));

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  user_id    TEXT REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content    TEXT NOT NULL,
  run_id     TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_agent ON chat_messages(agent_id, created_at);
