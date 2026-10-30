-- Sensitive AI data gets its own permissions, independent of task visibility (SAG World security model §3.5):
-- other people's agent chats, run records (prompts, stages, models), tool inputs/outputs, and cost figures.
-- Fresh databases get these from the seed (which runs after migrations).
INSERT OR IGNORE INTO permissions (id)
  SELECT p FROM (SELECT 'agent_chat:read_others' p UNION ALL SELECT 'ai_runs:read' UNION ALL SELECT 'tool_io:read' UNION ALL SELECT 'budget:read')
  WHERE EXISTS (SELECT 1 FROM roles);
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'admin', p FROM (SELECT 'agent_chat:read_others' p UNION ALL SELECT 'ai_runs:read' UNION ALL SELECT 'tool_io:read' UNION ALL SELECT 'budget:read')
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'admin');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'director', p FROM (SELECT 'ai_runs:read' p UNION ALL SELECT 'tool_io:read' UNION ALL SELECT 'budget:read')
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'director');
