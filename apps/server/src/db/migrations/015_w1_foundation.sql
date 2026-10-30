-- migrate: foreign_keys=off
-- SAG World W1 completion: typed unit functions, unit budgets in UZS minor units, unit-owned knowledge, connector
-- installations per unit, read/write level on data-sharing agreements.
-- (Foreign keys are off only so ADD COLUMN may carry a REFERENCES clause with a default; checked afterwards.)

-- ---------- unit functions (what a unit does; independent of business_type / ownership) ----------
UPDATE org_nodes SET functions = '[]' WHERE level <> 'UNIT';
UPDATE org_nodes SET functions = '["HEADQUARTERS","OFFICE"]' WHERE id = 'hq';
UPDATE org_nodes SET functions = '["RETAIL"]'
  WHERE level = 'UNIT' AND id <> 'hq' AND (NOT json_valid(functions) OR json_array_length(functions) = 0 OR functions LIKE '%HEADQUARTERS%');

-- valid: a JSON array of distinct known names; units have 1–7, other levels none; HEADQUARTERS only (and always) on hq
CREATE TRIGGER trg_org_functions_ins BEFORE INSERT ON org_nodes
WHEN NOT (json_valid(NEW.functions) AND json_type(NEW.functions) = 'array' AND (
  (NEW.level <> 'UNIT' AND json_array_length(NEW.functions) = 0)
  OR (NEW.level = 'UNIT' AND json_array_length(NEW.functions) BETWEEN 1 AND 7
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.functions) WHERE type <> 'text'
        OR value NOT IN ('RETAIL','WAREHOUSE','FACTORY','OFFICE','LOGISTICS','DEALER','HEADQUARTERS'))
      AND (SELECT COUNT(DISTINCT value) FROM json_each(NEW.functions)) = json_array_length(NEW.functions)
      AND (NEW.id = 'hq') = EXISTS (SELECT 1 FROM json_each(NEW.functions) WHERE value = 'HEADQUARTERS'))))
BEGIN SELECT RAISE(ABORT, 'org_functions: invalid business unit functions'); END;

CREATE TRIGGER trg_org_functions_upd BEFORE UPDATE OF functions, level, id ON org_nodes
WHEN NOT (json_valid(NEW.functions) AND json_type(NEW.functions) = 'array' AND (
  (NEW.level <> 'UNIT' AND json_array_length(NEW.functions) = 0)
  OR (NEW.level = 'UNIT' AND json_array_length(NEW.functions) BETWEEN 1 AND 7
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.functions) WHERE type <> 'text'
        OR value NOT IN ('RETAIL','WAREHOUSE','FACTORY','OFFICE','LOGISTICS','DEALER','HEADQUARTERS'))
      AND (SELECT COUNT(DISTINCT value) FROM json_each(NEW.functions)) = json_array_length(NEW.functions)
      AND (NEW.id = 'hq') = EXISTS (SELECT 1 FROM json_each(NEW.functions) WHERE value = 'HEADQUARTERS'))))
BEGIN SELECT RAISE(ABORT, 'org_functions: invalid business unit functions'); END;

-- ---------- money ----------
CREATE TABLE currencies (
  code        TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
  minor_units INTEGER NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);
INSERT INTO currencies (code, minor_units) VALUES ('UZS', 2), ('USD', 2), ('EUR', 2), ('RUB', 2), ('KZT', 2), ('CNY', 2), ('TRY', 2);

-- A unit's budget for one period and category, in the reporting currency (UZS), integer minor units (tiyin).
CREATE TABLE unit_budgets (
  id               TEXT PRIMARY KEY,
  business_unit_id TEXT NOT NULL REFERENCES org_nodes(id),
  period           TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period, 6, 2) BETWEEN '01' AND '12'),
  category         TEXT NOT NULL CHECK (category IN ('OPERATIONS','AI','MARKETING','PAYROLL','INVENTORY','OTHER')),
  allocated_minor  INTEGER NOT NULL CHECK (typeof(allocated_minor) = 'integer' AND allocated_minor >= 0),
  currency         TEXT NOT NULL DEFAULT 'UZS' REFERENCES currencies(code) CHECK (currency = 'UZS'),
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CLOSED')),
  note             TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL REFERENCES users(id),
  submitted_by     TEXT REFERENCES users(id),
  submitted_at     TEXT,
  decided_by       TEXT REFERENCES users(id),
  decided_at       TEXT,
  decision_reason  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (business_unit_id, period, category)
);
CREATE INDEX idx_unit_budgets_unit ON unit_budgets(business_unit_id, period);

-- Spending against a budget. amount_minor is in UZS (reporting); the original amount and currency are kept, with the
-- exact rate used (UZS per 1 unit of the original currency × 10^8) when they differ. Negative = correction/refund.
CREATE TABLE unit_budget_entries (
  id                    TEXT PRIMARY KEY,
  budget_id             TEXT NOT NULL REFERENCES unit_budgets(id),
  business_unit_id      TEXT NOT NULL REFERENCES org_nodes(id),
  amount_minor          INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor <> 0),
  original_amount_minor INTEGER NOT NULL CHECK (typeof(original_amount_minor) = 'integer' AND original_amount_minor <> 0),
  original_currency     TEXT NOT NULL REFERENCES currencies(code),
  fx_rate_e8            INTEGER CHECK (fx_rate_e8 IS NULL OR (typeof(fx_rate_e8) = 'integer' AND fx_rate_e8 > 0)),
  fx_rate_date          TEXT,
  fx_source             TEXT,
  description           TEXT NOT NULL,
  occurred_on           TEXT NOT NULL,
  recorded_by           TEXT NOT NULL REFERENCES users(id),
  created_at            TEXT NOT NULL,
  CHECK ((original_currency = 'UZS') = (fx_rate_e8 IS NULL)),
  CHECK (original_currency <> 'UZS' OR original_amount_minor = amount_minor),
  CHECK (original_currency = 'UZS' OR (fx_rate_date IS NOT NULL AND fx_source IS NOT NULL))
);
CREATE INDEX idx_budget_entries_budget ON unit_budget_entries(budget_id);
CREATE TRIGGER trg_budget_entry_unit BEFORE INSERT ON unit_budget_entries
WHEN (SELECT business_unit_id FROM unit_budgets WHERE id = NEW.budget_id) IS NOT NEW.business_unit_id
BEGIN SELECT RAISE(ABORT, 'cross_unit: budget entry belongs to another unit'); END;

-- ---------- knowledge owned by a unit ----------
-- visibility: UNIT = only the owning unit; BRANCHES = HQ documents shared down to SAG-owned branches (HQ only).
ALTER TABLE knowledge_documents ADD COLUMN business_unit_id TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id);
ALTER TABLE knowledge_documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'UNIT' CHECK (visibility IN ('UNIT','BRANCHES'));
ALTER TABLE knowledge_documents ADD COLUMN source_label TEXT;
CREATE INDEX idx_kdocs_unit ON knowledge_documents(business_unit_id, is_active);
CREATE TRIGGER trg_kdoc_unit_ins BEFORE INSERT ON knowledge_documents
WHEN (NEW.visibility = 'BRANCHES' AND NEW.business_unit_id <> 'hq')
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) IS NOT NEW.business_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: document scope belongs to another unit'); END;
CREATE TRIGGER trg_kdoc_unit_upd BEFORE UPDATE OF visibility, business_unit_id, department_id ON knowledge_documents
WHEN (NEW.visibility = 'BRANCHES' AND NEW.business_unit_id <> 'hq')
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) IS NOT NEW.business_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: document scope belongs to another unit'); END;

-- ---------- connectors installed per unit (credentials stay server-side; this table never holds them) ----------
CREATE TABLE connector_installations (
  id               TEXT PRIMARY KEY,
  business_unit_id TEXT NOT NULL REFERENCES org_nodes(id),
  connector_id     TEXT NOT NULL REFERENCES connectors(id),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status           TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  credential_scope TEXT NOT NULL CHECK (credential_scope IN ('NONE','SERVER_ENV','SECRET_STORE')),
  last_health_at   TEXT,
  last_error       TEXT,
  created_by       TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (business_unit_id, connector_id)
);
-- HQ keeps every connector it already has (status mirrored by the connector hub on start); new databases get the
-- same rows from the seed (src/connectors/installations.ts)
INSERT INTO connector_installations (id, business_unit_id, connector_id, status, credential_scope, created_at, updated_at)
  SELECT 'ci_hq_' || id, 'hq', id, status,
         CASE WHEN id IN ('internal-api','web-search') THEN 'NONE' WHEN id IN ('gmail','drive','sheets','calendar') THEN 'SECRET_STORE' ELSE 'SERVER_ENV' END,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM connectors;

-- an agent may hold a connector grant only for a connector installed in its own unit
CREATE TRIGGER trg_agent_grant_unit BEFORE INSERT ON agent_connector_permissions
WHEN NOT EXISTS (SELECT 1 FROM connector_installations ci JOIN agents a ON a.business_unit_id = ci.business_unit_id
                 WHERE a.id = NEW.agent_id AND ci.connector_id = NEW.connector_id AND ci.enabled = 1)
BEGIN SELECT RAISE(ABORT, 'cross_unit: connector not installed in the agent''s unit'); END;

-- ---------- data-sharing agreements: explicit access level ----------
ALTER TABLE data_sharing_agreements ADD COLUMN access TEXT NOT NULL DEFAULT 'READ' CHECK (access IN ('READ','READ_WRITE'));
