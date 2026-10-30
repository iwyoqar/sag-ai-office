-- W4 agent marketplace (HQ first): templates with immutable approved versions, hire requests with every check
-- recorded, per-department hiring limits, and the template an agent was hired from.
-- See docs/superpowers/specs/2026-10-30-agent-marketplace-design.md.

CREATE TABLE agent_templates (
  id                  TEXT PRIMARY KEY,
  business_unit_id    TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id),
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  allowed_departments TEXT NOT NULL DEFAULT '[]',          -- JSON array of department ids; empty = any HQ department
  current_version     INTEGER,                              -- the published (approved) version
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL
);

CREATE TABLE agent_template_versions (
  template_id         TEXT NOT NULL REFERENCES agent_templates(id),
  version             INTEGER NOT NULL,
  role                TEXT NOT NULL,
  responsibilities    TEXT NOT NULL DEFAULT '',
  skills              TEXT NOT NULL DEFAULT '[]',
  instructions        TEXT NOT NULL DEFAULT '',
  tools               TEXT NOT NULL DEFAULT '[]',          -- [{connectorId, actions:["read"|"write"]}]: the most a hire may grant
  model               TEXT,
  max_tokens_per_task INTEGER,
  est_monthly_minor   INTEGER NOT NULL DEFAULT 0 CHECK (est_monthly_minor >= 0),   -- UZS tiyin
  risk_level          TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  approved_note       TEXT,
  PRIMARY KEY (template_id, version)
);

CREATE TABLE agent_hire_requests (
  id                TEXT PRIMARY KEY,
  business_unit_id  TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id),
  template_id       TEXT NOT NULL,
  template_version  INTEGER NOT NULL,
  department_id     TEXT NOT NULL REFERENCES departments(id),
  requested_by_type TEXT NOT NULL DEFAULT 'user' CHECK (requested_by_type IN ('user','agent')),
  requested_by_id   TEXT NOT NULL,
  justification     TEXT NOT NULL,
  policy_at_request TEXT NOT NULL CHECK (policy_at_request IN ('AUTO','APPROVAL','RESTRICTED')),
  checks            TEXT NOT NULL,                           -- JSON: every check with its result, kept for audit
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_via       TEXT CHECK (decided_via IN ('user','policy')),
  decided_by        TEXT REFERENCES users(id),
  decision_reason   TEXT,
  override          INTEGER NOT NULL DEFAULT 0 CHECK (override IN (0, 1)),
  agent_id          TEXT REFERENCES agents(id),
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  FOREIGN KEY (template_id, template_version) REFERENCES agent_template_versions(template_id, version),
  CHECK (decided_via <> 'user' OR decided_by IS NOT NULL)
);
CREATE INDEX idx_hire_department ON agent_hire_requests(department_id, status);

CREATE TABLE department_hiring_limits (
  department_id        TEXT PRIMARY KEY REFERENCES departments(id),
  max_agents           INTEGER CHECK (max_agents IS NULL OR max_agents >= 0),
  monthly_budget_minor INTEGER CHECK (monthly_budget_minor IS NULL OR monthly_budget_minor >= 0),
  auto_templates       TEXT NOT NULL DEFAULT '[]',           -- template ids a head may hire without approval
  updated_by           TEXT REFERENCES users(id),
  updated_at           TEXT NOT NULL
);

ALTER TABLE agents ADD COLUMN template_id TEXT REFERENCES agent_templates(id);
ALTER TABLE agents ADD COLUMN template_version INTEGER;
