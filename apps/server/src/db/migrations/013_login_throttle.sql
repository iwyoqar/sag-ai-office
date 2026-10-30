-- Login throttling (W0): per-account and per-client-IP failure counters with lock-until, in the database so they
-- survive restarts and cannot be reset by restarting the process. Keys: 'user:<username>' and 'ip:<address>'.
CREATE TABLE login_throttle (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
);
CREATE INDEX idx_login_throttle_window ON login_throttle(window_start);
