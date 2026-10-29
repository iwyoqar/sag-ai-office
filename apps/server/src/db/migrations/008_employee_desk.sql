-- Stable desk per human employee inside their department (3D office seating survives reloads and roster changes).
-- Separate index space from agents.workstation: the 3D office seats people from the far end of the department's desks.
ALTER TABLE users ADD COLUMN desk INTEGER;

-- Backfill in creation order (rowid) per department. PostgreSQL port: ROW_NUMBER() over created_at, id.
UPDATE users SET desk = (
  SELECT COUNT(*) FROM users b
  WHERE b.department_id = users.department_id AND b.status = 'active' AND b.rowid < users.rowid
)
WHERE status = 'active' AND department_id IS NOT NULL;

CREATE UNIQUE INDEX ux_users_desk ON users(department_id, desk) WHERE status = 'active' AND desk IS NOT NULL;
