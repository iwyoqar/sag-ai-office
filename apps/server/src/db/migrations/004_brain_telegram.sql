-- The Brain (knowledge, memory review), approvals before completion, editable settings, Telegram integration.

-- ---------- settings (editable at runtime from The Brain; env provides defaults) ----------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ---------- knowledge ----------
ALTER TABLE knowledge_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE knowledge_documents ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE knowledge_documents ADD COLUMN text_chars INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_kdocs_active ON knowledge_documents(is_active, department_id);

-- Full-text index over chunks (BM25). SQLite FTS5; the PostgreSQL port uses a tsvector column + GIN index.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, title,
  chunk_id UNINDEXED, document_id UNINDEXED, department_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------- company memory: agents propose, people approve ----------
ALTER TABLE company_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE company_memory ADD COLUMN decided_by TEXT REFERENCES users(id);
ALTER TABLE company_memory ADD COLUMN decided_at TEXT;
CREATE INDEX idx_memory_status ON company_memory(status, department_id);

-- ---------- approval before a result counts as done ----------
ALTER TABLE tasks ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN decided_via TEXT;

-- ---------- Telegram ----------
-- Every update is stored once (update_id is unique) → retried deliveries never create duplicate tasks.
CREATE TABLE telegram_updates (
  update_id    INTEGER PRIMARY KEY,
  chat_id      INTEGER,
  user_id      INTEGER,
  username     TEXT,
  text         TEXT,
  command      TEXT,
  outcome      TEXT,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  received_at  TEXT NOT NULL
);

-- Which Telegram message created / follows a task (for replies and notifications).
CREATE TABLE telegram_task_links (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER,
  user_id    INTEGER,
  created_at TEXT NOT NULL
);

-- ---------- permission for The Brain (knowledge, instructions, memory review, connectors, Telegram settings) ----------
INSERT OR IGNORE INTO permissions (id) SELECT 'brain:manage' WHERE EXISTS (SELECT 1 FROM roles);
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'admin', 'brain:manage' WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'admin');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'director', 'brain:manage' WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'director');
