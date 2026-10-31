-- S0 (security): a task dependency never crosses business units. The task triggers (010) already keep parent,
-- department, agent, assignee and reviewer inside the task's unit; dependencies had no such guard, so a task could be
-- made to wait on (and receive the result of) another unit's or a franchise's task. Existing data has none.
CREATE TRIGGER trg_task_dep_unit BEFORE INSERT ON task_dependencies
WHEN (SELECT business_unit_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT business_unit_id FROM tasks WHERE id = NEW.depends_on_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task dependency references another unit'); END;
CREATE TRIGGER trg_task_dep_unit_upd BEFORE UPDATE ON task_dependencies
WHEN (SELECT business_unit_id FROM tasks WHERE id = NEW.task_id) IS NOT (SELECT business_unit_id FROM tasks WHERE id = NEW.depends_on_id)
BEGIN SELECT RAISE(ABORT, 'cross_unit: task dependency references another unit'); END;
