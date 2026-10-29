-- Stable desk per agent inside its department (3D office seating survives reloads and roster changes).
ALTER TABLE agents ADD COLUMN workstation INTEGER;

-- Backfill in insertion order (rowid) per department. PostgreSQL port: use ROW_NUMBER() over created_at, id.
UPDATE agents SET workstation = (
  SELECT COUNT(*) FROM agents b
  WHERE b.department_id = agents.department_id AND b.lifecycle <> 'ARCHIVED' AND b.rowid < agents.rowid
)
WHERE lifecycle <> 'ARCHIVED';

CREATE UNIQUE INDEX ux_agents_workstation ON agents(department_id, workstation)
  WHERE lifecycle <> 'ARCHIVED' AND workstation IS NOT NULL;
