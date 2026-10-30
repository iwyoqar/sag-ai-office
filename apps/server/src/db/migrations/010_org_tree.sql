-- migrate: foreign_keys=off
-- SAG World W1 (subset): organisation tree GROUP → REGION → UNIT, unit ownership of departments, agents, tasks and
-- users, unit memberships, invitations, data-sharing agreements and store import batches.
-- The existing organisation becomes the unit 'hq' (SAG Head Office) under region 'toshkent-viloyat'.
-- Design: docs/SAG_WORLD_DATA_MODEL.md §3.1–3.3. Deviations: legal_entity_id is optional (franchise legal entities
-- are not known yet); agreements are proposed by the owning unit and become active when HQ approves them.

CREATE TABLE legal_entities (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  tin          TEXT UNIQUE,
  country      TEXT NOT NULL DEFAULT 'UZ',
  group_owned  INTEGER NOT NULL CHECK (group_owned IN (0, 1)),
  created_at   TEXT NOT NULL
);

CREATE TABLE store_import_batches (
  id           TEXT PRIMARY KEY,
  source_file  TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_by  TEXT,                                  -- OS user / operator name, informational
  summary      TEXT NOT NULL DEFAULT '{}',            -- JSON: created / unchanged counts
  imported_at  TEXT NOT NULL
);

CREATE TABLE org_nodes (
  id               TEXT PRIMARY KEY,
  level            TEXT NOT NULL CHECK (level IN ('GROUP','REGION','UNIT')),
  parent_id        TEXT REFERENCES org_nodes(id),
  path             TEXT NOT NULL,                     -- '/sag-group/toshkent-viloyat/hq/'
  name             TEXT NOT NULL,
  code             TEXT NOT NULL UNIQUE,
  business_type    TEXT CHECK (business_type IN ('SAG_BRANCH','INDEPENDENT_DEALER','SUBSIDIARY')),
  ownership_model  TEXT CHECK (ownership_model IN ('SAG_OWNED','FRANCHISE','INDEPENDENT','GROUP_OWNED')),
  source_brand     TEXT,                              -- 'HOME_DESIGN' for imported stores
  source_marker    TEXT,                              -- original workbook marker: 'HD' | 'F'
  source_label     TEXT,                              -- original text from the source (region header, store name)
  import_batch_id  TEXT REFERENCES store_import_batches(id),
  legal_entity_id  TEXT REFERENCES legal_entities(id),
  functions        TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','ARCHIVED')),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  reporting_currency TEXT NOT NULL DEFAULT 'UZS',
  address          TEXT,                              -- only real addresses; NULL when unknown
  geo              TEXT,                              -- JSON {lat,lng}; only real coordinates; NULL when unknown
  human_director_user_id TEXT REFERENCES users(id),
  provision_key    TEXT UNIQUE,                       -- idempotency key of the import / provisioning
  created_by       TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((level = 'GROUP') = (parent_id IS NULL)),
  CHECK ((level = 'UNIT') = (business_type IS NOT NULL)),
  CHECK (level = 'UNIT' OR ownership_model IS NULL),
  CHECK (ownership_model IS NULL
    OR (business_type = 'SAG_BRANCH' AND ownership_model = 'SAG_OWNED')
    OR (business_type = 'INDEPENDENT_DEALER' AND ownership_model IN ('FRANCHISE','INDEPENDENT'))
    OR (business_type = 'SUBSIDIARY' AND ownership_model = 'GROUP_OWNED')),
  CHECK (source_marker IS NULL OR source_marker IN ('HD','F'))
);
CREATE INDEX idx_org_parent ON org_nodes(parent_id, status);
CREATE INDEX idx_org_path ON org_nodes(path);
CREATE UNIQUE INDEX ux_org_single_group ON org_nodes(level) WHERE level = 'GROUP';

CREATE TRIGGER trg_org_shape_ins BEFORE INSERT ON org_nodes
WHEN (NEW.level = 'REGION' AND (SELECT level FROM org_nodes WHERE id = NEW.parent_id) IS NOT 'GROUP')
  OR (NEW.level = 'UNIT' AND (SELECT level FROM org_nodes WHERE id = NEW.parent_id) IS NOT 'REGION')
BEGIN SELECT RAISE(ABORT, 'org_tree_shape'); END;
CREATE TRIGGER trg_org_shape_upd BEFORE UPDATE OF level, parent_id ON org_nodes
WHEN (NEW.level = 'REGION' AND (SELECT level FROM org_nodes WHERE id = NEW.parent_id) IS NOT 'GROUP')
  OR (NEW.level = 'UNIT' AND (SELECT level FROM org_nodes WHERE id = NEW.parent_id) IS NOT 'REGION')
  OR (NEW.level <> OLD.level)
BEGIN SELECT RAISE(ABORT, 'org_tree_shape'); END;

INSERT INTO legal_entities (id, name, country, group_owned, created_at)
VALUES ('le-sag', 'SAG Holding', 'UZ', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO org_nodes (id, level, parent_id, path, name, code, created_at, updated_at)
VALUES ('sag-group', 'GROUP', NULL, '/sag-group/', 'SAG GROUP', 'sag-group',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO org_nodes (id, level, parent_id, path, name, code, created_at, updated_at)
VALUES ('toshkent-viloyat', 'REGION', 'sag-group', '/sag-group/toshkent-viloyat/', 'Toshkent viloyati', 'toshkent-viloyat',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO org_nodes (id, level, parent_id, path, name, code, business_type, ownership_model, legal_entity_id, functions,
                       created_at, updated_at)
VALUES ('hq', 'UNIT', 'toshkent-viloyat', '/sag-group/toshkent-viloyat/hq/', 'SAG Head Office', 'hq', 'SAG_BRANCH',
        'SAG_OWNED', 'le-sag', '["HEAD_OFFICE"]',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- departments: owned by a unit; floor only for HQ building floors (stores have no floors)
CREATE TABLE departments_new (
  id               TEXT PRIMARY KEY,
  business_unit_id TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id),
  floor_id         TEXT REFERENCES floors(id),
  name             TEXT NOT NULL,
  short            TEXT NOT NULL,
  color            TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  focus            TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  head_user_id     TEXT REFERENCES users(id),
  UNIQUE (id, business_unit_id)
);
INSERT INTO departments_new (id, business_unit_id, floor_id, name, short, color, weight, sort, focus, is_active, created_at, head_user_id)
SELECT id, 'hq', floor_id, name, short, color, weight, sort, focus, is_active, created_at, head_user_id FROM departments;
DROP TABLE departments;
ALTER TABLE departments_new RENAME TO departments;
CREATE INDEX idx_departments_unit ON departments(business_unit_id, sort);

ALTER TABLE agents ADD COLUMN business_unit_id TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id);
ALTER TABLE agents ADD COLUMN is_primary_director INTEGER NOT NULL DEFAULT 0 CHECK (is_primary_director IN (0, 1));
CREATE INDEX idx_agents_unit ON agents(business_unit_id, lifecycle);
CREATE UNIQUE INDEX ux_agents_one_director ON agents(business_unit_id)
  WHERE is_primary_director = 1 AND lifecycle <> 'ARCHIVED';

ALTER TABLE tasks ADD COLUMN business_unit_id TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id);
CREATE INDEX idx_tasks_unit ON tasks(business_unit_id, status);

ALTER TABLE users ADD COLUMN home_unit_id TEXT NOT NULL DEFAULT 'hq' REFERENCES org_nodes(id);
ALTER TABLE users ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (activation_status IN ('ACTIVE','PENDING_ACTIVATION'));
CREATE INDEX idx_users_unit ON users(home_unit_id, status);

-- Unit ownership is consistent: rows may only point at things in their own unit, and only units own things.
CREATE TRIGGER trg_dept_unit BEFORE INSERT ON departments
WHEN (SELECT level FROM org_nodes WHERE id = NEW.business_unit_id) IS NOT 'UNIT'
BEGIN SELECT RAISE(ABORT, 'cross_unit: department must belong to a unit'); END;
CREATE TRIGGER trg_dept_unit_upd BEFORE UPDATE OF business_unit_id ON departments
BEGIN SELECT RAISE(ABORT, 'cross_unit: department unit is fixed'); END;

CREATE TRIGGER trg_agent_unit BEFORE INSERT ON agents
WHEN (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.business_unit_id
BEGIN SELECT RAISE(ABORT, 'cross_unit: agent department in another unit'); END;
CREATE TRIGGER trg_agent_unit_upd BEFORE UPDATE OF department_id, business_unit_id ON agents
WHEN NEW.business_unit_id IS NOT OLD.business_unit_id
  OR (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.business_unit_id
BEGIN SELECT RAISE(ABORT, 'cross_unit: agent department in another unit'); END;

CREATE TRIGGER trg_user_unit BEFORE INSERT ON users
WHEN (SELECT level FROM org_nodes WHERE id = NEW.home_unit_id) IS NOT 'UNIT'
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.home_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: user department in another unit'); END;
CREATE TRIGGER trg_user_unit_upd BEFORE UPDATE OF department_id, home_unit_id ON users
WHEN (SELECT level FROM org_nodes WHERE id = NEW.home_unit_id) IS NOT 'UNIT'
  OR (NEW.department_id IS NOT NULL AND (SELECT business_unit_id FROM departments WHERE id = NEW.department_id) <> NEW.home_unit_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: user department in another unit'); END;

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

-- Store-level roles (granted per unit through memberships; they carry no company-wide permissions)
INSERT OR IGNORE INTO roles (id, description) VALUES
  ('unit_director', 'Human director of one business unit'),
  ('unit_manager', 'Store manager: assigns work, sees the unit''s people'),
  ('unit_staff', 'Store employee');

CREATE TABLE unit_memberships (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id          TEXT NOT NULL REFERENCES org_nodes(id) ON DELETE CASCADE,
  role_id          TEXT NOT NULL REFERENCES roles(id),
  include_descendants INTEGER NOT NULL DEFAULT 0,
  granted_by       TEXT REFERENCES users(id),        -- NULL only for system provisioning (import)
  granted_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, node_id, role_id)
);
CREATE INDEX idx_membership_node ON unit_memberships(node_id, role_id);
-- exactly one human director per unit
CREATE UNIQUE INDEX ux_membership_one_director ON unit_memberships(node_id) WHERE role_id = 'unit_director';

-- One-time activation / invitation tokens (only the SHA-256 hash is stored)
CREATE TABLE user_invitations (
  id               TEXT PRIMARY KEY,
  node_id          TEXT NOT NULL REFERENCES org_nodes(id),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id          TEXT NOT NULL REFERENCES roles(id),
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       TEXT NOT NULL REFERENCES users(id),
  expires_at       TEXT NOT NULL,
  accepted_at      TEXT,
  revoked_at       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_invitations_user ON user_invitations(user_id, accepted_at, revoked_at);

CREATE TABLE data_sharing_agreements (
  id               TEXT PRIMARY KEY,
  unit_id          TEXT NOT NULL REFERENCES org_nodes(id),     -- data owner (a UNIT)
  grantee_node_id  TEXT NOT NULL REFERENCES org_nodes(id),     -- GROUP, REGION or another UNIT
  data_classes     TEXT NOT NULL,                              -- JSON array, see domain/units.ts DATA_CLASSES
  level            TEXT NOT NULL CHECK (level IN ('AGGREGATE','DETAIL')),
  valid_from       TEXT NOT NULL,
  valid_to         TEXT,
  contract_ref     TEXT NOT NULL,
  signed_by_owner  TEXT NOT NULL REFERENCES users(id),         -- human of the owning unit
  approved_by      TEXT REFERENCES users(id),                  -- human on the grantee side; NULL = not active yet
  approved_at      TEXT,
  revoked_at       TEXT, revoked_by TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  CHECK (unit_id <> grantee_node_id)
);
CREATE INDEX idx_dsa_unit ON data_sharing_agreements(unit_id, revoked_at);
CREATE INDEX idx_dsa_grantee ON data_sharing_agreements(grantee_node_id, revoked_at);

-- owning unit of each audit entry (NULL = platform level); filled by lib/audit.ts
ALTER TABLE audit_logs ADD COLUMN business_unit_id TEXT;
CREATE INDEX idx_audit_unit ON audit_logs(business_unit_id, id);
-- owning unit of each activity event; HQ streams carry only HQ events
ALTER TABLE task_events ADD COLUMN business_unit_id TEXT;

CREATE TABLE unit_policies (
  business_unit_id      TEXT PRIMARY KEY REFERENCES org_nodes(id) ON DELETE CASCADE,
  hiring_policy         TEXT NOT NULL DEFAULT 'APPROVAL' CHECK (hiring_policy IN ('AUTO','APPROVAL','RESTRICTED')),
  max_active_agents     INTEGER NOT NULL DEFAULT 6 CHECK (max_active_agents BETWEEN 1 AND 100),
  max_tokens_per_task   INTEGER NOT NULL DEFAULT 200000,
  updated_by            TEXT REFERENCES users(id),
  updated_at            TEXT NOT NULL
);
INSERT INTO unit_policies (business_unit_id, updated_at) VALUES ('hq', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
