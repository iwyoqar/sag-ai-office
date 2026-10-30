-- W3.2 HQ AI Director: per-agent provider, provider on runs/usage, structured plans, handoff records, result
-- evaluations (revision rounds keep every earlier deliverable), and the AI Director's settings per unit.

-- per-agent provider selection (NULL = the platform default provider); agents.model stays the model id
ALTER TABLE agents ADD COLUMN provider TEXT CHECK (provider IS NULL OR provider IN ('gemini','anthropic'));
ALTER TABLE agent_runs ADD COLUMN provider TEXT;
ALTER TABLE usage_records ADD COLUMN provider TEXT;

-- the AI Director's structured plan of an orchestrated task (JSON: objective, context, expected outcome, skills, …)
ALTER TABLE tasks ADD COLUMN plan TEXT;
-- a subtask that redoes an earlier one after an evaluation asked for a revision
ALTER TABLE tasks ADD COLUMN revision_of TEXT REFERENCES tasks(id);

-- one record per delegated subtask: who handed what to whom, in which unit, expecting which output
CREATE TABLE task_handoffs (
  id               TEXT PRIMARY KEY,
  parent_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  business_unit_id TEXT NOT NULL REFERENCES org_nodes(id),
  from_agent_id    TEXT NOT NULL REFERENCES agents(id),
  to_agent_id      TEXT REFERENCES agents(id),         -- NULL: no suitable agent yet (a hire request may be pending)
  input            TEXT NOT NULL,                       -- JSON: objective, description, skills, deliverable, dependencies
  output_format    TEXT NOT NULL DEFAULT 'markdown',
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_handoffs_parent ON task_handoffs(parent_task_id);

-- the AI Director's verdict on each subtask result
CREATE TABLE task_evaluations (
  id               TEXT PRIMARY KEY,
  parent_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_id   TEXT REFERENCES deliverables(id),
  round            INTEGER NOT NULL,                    -- 0 = first result, 1.. = revisions
  verdict          TEXT NOT NULL CHECK (verdict IN ('ACCEPTED','NEEDS_REVISION','REJECTED','NEEDS_HUMAN_REVIEW')),
  issues           TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
  feedback         TEXT NOT NULL DEFAULT '',
  revision_task_id TEXT REFERENCES tasks(id),
  evaluator        TEXT NOT NULL,                       -- 'checks' (deterministic) or the director agent id
  created_at       TEXT NOT NULL,
  UNIQUE (task_id)
);
CREATE INDEX idx_evaluations_parent ON task_evaluations(parent_task_id);

-- the unit's AI Director (NULL agent = the active agent of the orchestrator department) and its execution limits
CREATE TABLE ai_director_settings (
  business_unit_id     TEXT PRIMARY KEY REFERENCES org_nodes(id),
  agent_id             TEXT REFERENCES agents(id),
  provider             TEXT CHECK (provider IS NULL OR provider IN ('gemini','anthropic')),
  model                TEXT,
  max_subtasks         INTEGER NOT NULL DEFAULT 6 CHECK (max_subtasks BETWEEN 1 AND 12),
  max_revisions        INTEGER NOT NULL DEFAULT 2 CHECK (max_revisions BETWEEN 0 AND 5),
  max_ai_hire_requests INTEGER NOT NULL DEFAULT 3 CHECK (max_ai_hire_requests BETWEEN 0 AND 20),
  budget_alert_pct     INTEGER NOT NULL DEFAULT 80 CHECK (budget_alert_pct BETWEEN 1 AND 100),
  updated_by           TEXT REFERENCES users(id),
  updated_at           TEXT NOT NULL
);
INSERT INTO ai_director_settings (business_unit_id, updated_at) VALUES ('hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
