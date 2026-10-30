-- Off-site backup runs (W0): one row per attempt; "verified" only after the uploaded object was downloaded,
-- decrypted, opened and checked (integrity_check + row counts) in a scratch location.
CREATE TABLE backup_runs (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  object_key     TEXT NOT NULL,
  bytes          INTEGER,
  sha256         TEXT,
  schema_version TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running','uploaded','verified','failed')),
  verified_at    TEXT,
  error          TEXT
);
CREATE INDEX idx_backup_runs_started ON backup_runs(started_at);
