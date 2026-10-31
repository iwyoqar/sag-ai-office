-- Giving work to AI agents (tasks, agent chat, the AI Director) spends the AI budget: a permission of its own,
-- for admins, the director, department heads and HR. Plain employees keep human work and reading the office.
INSERT OR IGNORE INTO permissions (id) VALUES ('ai_tasks:create');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, 'ai_tasks:create' FROM roles r WHERE r.id IN ('admin', 'director', 'department_head', 'hr');
