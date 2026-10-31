-- Stores / branches placed on the 3D world map (POST /api/units).
-- world_x / world_z: lot centre in world metres (what the 3D world draws, kept even if the grid geometry changes);
-- world_rotation: radians about the vertical axis (0 = front facing +z);
-- world_grid_x / world_grid_z: the district grid slot (packages/shared/src/district.ts), the occupancy key.
-- Units without a placement (all imported stores) keep the automatic district layout: every column is NULL for them.
-- description: optional free text entered when the branch is created.
ALTER TABLE org_nodes ADD COLUMN world_x REAL;
ALTER TABLE org_nodes ADD COLUMN world_z REAL;
ALTER TABLE org_nodes ADD COLUMN world_rotation REAL;
ALTER TABLE org_nodes ADD COLUMN world_grid_x INTEGER;
ALTER TABLE org_nodes ADD COLUMN world_grid_z INTEGER;
ALTER TABLE org_nodes ADD COLUMN description TEXT;

-- one live store per grid slot: a second insert into the same slot fails even if two requests race
CREATE UNIQUE INDEX ux_org_world_slot ON org_nodes(world_grid_x, world_grid_z)
  WHERE world_grid_x IS NOT NULL AND status <> 'ARCHIVED';

-- a placement is all-or-nothing and only for units
CREATE TRIGGER trg_org_world_placement_ins BEFORE INSERT ON org_nodes
WHEN (NEW.world_grid_x IS NULL) <> (NEW.world_grid_z IS NULL)
  OR (NEW.world_grid_x IS NULL) <> (NEW.world_x IS NULL)
  OR (NEW.world_grid_x IS NULL) <> (NEW.world_z IS NULL)
  OR (NEW.world_grid_x IS NOT NULL AND (NEW.level <> 'UNIT' OR NEW.world_grid_x < 0 OR NEW.world_grid_z < 0))
BEGIN SELECT RAISE(ABORT, 'org_world_placement'); END;
CREATE TRIGGER trg_org_world_placement_upd BEFORE UPDATE OF world_x, world_z, world_grid_x, world_grid_z ON org_nodes
WHEN (NEW.world_grid_x IS NULL) <> (NEW.world_grid_z IS NULL)
  OR (NEW.world_grid_x IS NULL) <> (NEW.world_x IS NULL)
  OR (NEW.world_grid_x IS NULL) <> (NEW.world_z IS NULL)
  OR (NEW.world_grid_x IS NOT NULL AND (NEW.level <> 'UNIT' OR NEW.world_grid_x < 0 OR NEW.world_grid_z < 0))
BEGIN SELECT RAISE(ABORT, 'org_world_placement'); END;
