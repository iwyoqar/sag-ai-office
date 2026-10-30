-- migrate: foreign_keys=off
-- SAG World W2.1 Integration Hub core: connector instances owned by a unit, a region or the group; explicit
-- assignment of region/group instances to units; encrypted per-instance credentials with rotation, revocation and
-- expiry; health/sync run tracking; error classification on tool executions.
-- (Foreign keys are off while connector_installations is rebuilt; checked by the migration runner afterwards.)

-- ---------- catalog: providers prepared for W2 (definitions in src/connectors/registry.ts; none connected) ----------
INSERT OR IGNORE INTO connectors (id, name, kind, created_at) VALUES
  ('gemini', 'Google Gemini', 'api-key', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('anthropic', 'Anthropic Claude', 'api-key', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bitrix24', 'Bitrix24', 'oauth', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sap', 'SAP', 'api-key', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------- instances with an explicit owning scope ----------
-- (the grant trigger reads this table: drop it first, SQLite validates triggers when a table is renamed)
DROP TRIGGER IF EXISTS trg_agent_grant_unit;
CREATE TABLE connector_installations_new (
  id                   TEXT PRIMARY KEY,
  scope_level          TEXT NOT NULL CHECK (scope_level IN ('UNIT','REGION','GROUP')),
  scope_node_id        TEXT NOT NULL REFERENCES org_nodes(id),
  business_unit_id     TEXT REFERENCES org_nodes(id),              -- the owning unit (UNIT scope only)
  connector_id         TEXT NOT NULL REFERENCES connectors(id),
  config               TEXT NOT NULL DEFAULT '{}',                 -- non-secret settings (validated by the registry)
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status               TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  credential_scope     TEXT NOT NULL CHECK (credential_scope IN ('NONE','SERVER_ENV','SECRET_STORE')),
  health_status        TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (health_status IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_health_at       TEXT,
  last_error           TEXT,
  last_error_class     TEXT,
  created_by           TEXT REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (scope_node_id, connector_id),
  CHECK ((scope_level = 'UNIT') = (business_unit_id IS NOT NULL)),
  CHECK (business_unit_id IS NULL OR business_unit_id = scope_node_id)
);
INSERT INTO connector_installations_new (id, scope_level, scope_node_id, business_unit_id, connector_id, enabled, status, credential_scope,
    last_health_at, last_error, created_by, created_at, updated_at)
  SELECT id, 'UNIT', business_unit_id, business_unit_id, connector_id, enabled, status, credential_scope, last_health_at, last_error,
         created_by, created_at, updated_at FROM connector_installations;
DROP TABLE connector_installations;
ALTER TABLE connector_installations_new RENAME TO connector_installations;
CREATE INDEX idx_conn_inst_unit ON connector_installations(business_unit_id, connector_id);
CREATE INDEX idx_conn_inst_scope ON connector_installations(scope_node_id);

-- the scope level must match the node's level
CREATE TRIGGER trg_conn_inst_scope_ins BEFORE INSERT ON connector_installations
WHEN (SELECT level FROM org_nodes WHERE id = NEW.scope_node_id) IS NOT NEW.scope_level
BEGIN SELECT RAISE(ABORT, 'cross_unit: connector scope does not match the organisation node'); END;

-- ---------- region/group instances reach a unit only by explicit assignment ----------
-- Only SAG-owned units (and HQ for group instances) below the instance's node; never a franchise or subsidiary:
-- their connectors are their own. Region membership never creates an assignment.
CREATE TABLE connector_instance_assignments (
  instance_id      TEXT NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  business_unit_id TEXT NOT NULL REFERENCES org_nodes(id),
  granted_by       TEXT NOT NULL REFERENCES users(id),
  granted_at       TEXT NOT NULL,
  PRIMARY KEY (instance_id, business_unit_id)
);
CREATE TRIGGER trg_conn_assign_scope BEFORE INSERT ON connector_instance_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM connector_installations ci JOIN org_nodes s ON s.id = ci.scope_node_id JOIN org_nodes u ON u.id = NEW.business_unit_id
  WHERE ci.id = NEW.instance_id AND ci.scope_level IN ('REGION','GROUP') AND u.level = 'UNIT'
    AND u.path LIKE s.path || '%' AND (u.business_type = 'SAG_BRANCH' OR u.id = 'hq'))
BEGIN SELECT RAISE(ABORT, 'cross_unit: a shared connector can only be assigned to SAG-owned units below its scope'); END;

-- agent grants: the connector must be enabled for the agent's unit (own instance or an assigned shared one)
CREATE TRIGGER trg_agent_grant_unit BEFORE INSERT ON agent_connector_permissions
WHEN NOT EXISTS (
  SELECT 1 FROM agents a JOIN connector_installations ci ON ci.connector_id = NEW.connector_id AND ci.enabled = 1
  WHERE a.id = NEW.agent_id AND (ci.business_unit_id = a.business_unit_id
    OR EXISTS (SELECT 1 FROM connector_instance_assignments x WHERE x.instance_id = ci.id AND x.business_unit_id = a.business_unit_id)))
BEGIN SELECT RAISE(ABORT, 'cross_unit: connector not installed in the agent''s unit'); END;

-- ---------- credentials, encrypted at rest (AES-256-GCM, SECRETS_KEY; AAD binds the row to its instance) ----------
CREATE TABLE connector_credentials (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('API_KEY','OAUTH2','WEBHOOK_SECRET','SERVICE_ACCOUNT')),
  ciphertext    BLOB NOT NULL,
  iv            BLOB NOT NULL,
  tag           BLOB NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  fingerprint   TEXT NOT NULL,          -- first 8 hex chars of sha256(secret): lets people tell keys apart, reveals nothing
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','REVOKED','EXPIRED')),
  expires_at    TEXT,
  last_used_at  TEXT,
  rotated_from  TEXT REFERENCES connector_credentials(id),
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX ux_conn_cred_active ON connector_credentials(instance_id, method) WHERE status = 'ACTIVE';

-- ---------- health checks and (future) syncs ----------
CREATE TABLE connector_runs (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('HEALTH','SYNC')),
  status       TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  error_class  TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  duration_ms  INTEGER
);
CREATE INDEX idx_conn_runs_instance ON connector_runs(instance_id, started_at);

-- ---------- tool executions: which instance, how many attempts, what kind of failure ----------
ALTER TABLE tool_executions ADD COLUMN instance_id TEXT REFERENCES connector_installations(id);
ALTER TABLE tool_executions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tool_executions ADD COLUMN error_class TEXT;
