import { json } from "../db/db.js";
import { notFound } from "../lib/errors.js";
import type { Ctx } from "./context.js";

export type { ConnectorDto, DepartmentDto, FloorDto } from "@sag/shared";
import type { ConnectorDto, DepartmentDto, FloorDto } from "@sag/shared";

interface DeptRow {
  id: string; floor_id: string; name: string; short: string; color: string; weight: number; focus: string; is_active: number;
}

export function listDepartments({ db }: Ctx): DepartmentDto[] {
  const links = db.all<{ department_id: string; connector_id: string }>("SELECT * FROM department_connectors");
  return db.all<DeptRow>("SELECT * FROM departments WHERE business_unit_id = 'hq' ORDER BY sort").map((d) => ({
    id: d.id, floorId: d.floor_id, name: d.name, short: d.short, color: d.color, weight: d.weight,
    focus: json(d.focus, []), isActive: !!d.is_active,
    connectors: links.filter((l) => l.department_id === d.id).map((l) => l.connector_id),
  }));
}

export function getDepartment(ctx: Ctx, id: string): DepartmentDto {
  const d = listDepartments(ctx).find((x) => x.id === id);
  if (!d) throw notFound("Bo'lim");
  return d;
}

export function listFloors({ db }: Ctx): FloorDto[] {
  const deps = db.all<{ id: string; floor_id: string }>("SELECT id, floor_id FROM departments WHERE is_active = 1 AND business_unit_id = 'hq' ORDER BY sort");
  return db.all<{ id: string; level: number; title: string }>("SELECT * FROM floors ORDER BY level DESC").map((f) => ({
    ...f, departments: deps.filter((d) => d.floor_id === f.id).map((d) => d.id),
  }));
}

export function listConnectors({ db }: Ctx): ConnectorDto[] {
  const links = db.all<{ department_id: string; connector_id: string }>("SELECT dc.* FROM department_connectors dc JOIN departments d ON d.id = dc.department_id WHERE d.business_unit_id = 'hq'");
  return db
    .all<{
      id: string; name: string; kind: string; auth_status: string; status: string; allowed_actions: string;
      last_sync_at: string | null; last_health_at: string | null; last_error: string | null;
    }>("SELECT * FROM connectors ORDER BY name")
    .map((c) => ({
      id: c.id, name: c.name, kind: c.kind, authStatus: c.auth_status, status: c.status,
      allowedActions: json(c.allowed_actions, []), lastSyncAt: c.last_sync_at, lastHealthAt: c.last_health_at, lastError: c.last_error,
      departments: links.filter((l) => l.connector_id === c.id).map((l) => l.department_id),
    }));
}
