// The marketplace catalog seeded from the agents already working at HQ: one template per department + role, so their
// settings survive when the agents themselves are archived. Runs once (only while no template exists).
import type { TemplateTool, TemplateVersionDto } from "@sag/shared";
import { json, now, type Db } from "../db/db.js";
import { slug } from "../lib/ids.js";

export interface SourceAgent {
  id: string; name: string; role: string; departmentId: string; skills: string[]; responsibilities: string;
  model: string | null; maxTokensPerTask: number | null; instructions: string; tools: TemplateTool[];
}

export interface TemplateSeed {
  id: string; name: string; category: string; departmentId: string;
  version: Omit<TemplateVersionDto, "version" | "approvedAt" | "approvedNote">;
  agentIds: string[];
}

const normRole = (r: string) => r.trim().replace(/\s+/g, " ").toLowerCase();

/** Union of connector grants, actions merged per connector. */
export function mergeTools(lists: TemplateTool[][]): TemplateTool[] {
  const by = new Map<string, Set<"read" | "write">>();
  for (const l of lists) for (const t of l) {
    const s = by.get(t.connectorId) ?? new Set();
    for (const a of t.actions) s.add(a);
    by.set(t.connectorId, s);
  }
  return [...by].map(([connectorId, s]) => ({ connectorId, actions: [...s] }));
}

/** A template that may grant a write action is HIGH risk (the hire always goes to the admin). */
export const riskOf = (tools: TemplateTool[]): "LOW" | "HIGH" => (tools.some((t) => t.actions.includes("write")) ? "HIGH" : "LOW");

/** Pure: groups agents by department + normalised role; texts from the first agent (by id), tools unioned. */
export function groupAgents(agents: SourceAgent[]): TemplateSeed[] {
  const groups = new Map<string, SourceAgent[]>();
  for (const a of [...agents].sort((x, y) => x.id.localeCompare(y.id))) {
    const k = `${a.departmentId}\u0000${normRole(a.role)}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  return [...groups.values()].map((g) => {
    const f = g[0];
    const tools = mergeTools(g.map((a) => a.tools));
    return {
      id: slug(`${f.departmentId}-${f.role}`), name: f.role.trim(), category: f.departmentId, departmentId: f.departmentId,
      version: {
        role: f.role.trim(), responsibilities: f.responsibilities, skills: f.skills, instructions: f.instructions, tools,
        model: f.model, maxTokensPerTask: f.maxTokensPerTask, estMonthlyMinor: 0, riskLevel: riskOf(tools),
      },
      agentIds: g.map((a) => a.id),
    };
  });
}

/** Seeds the catalog from the non-archived HQ agents when there is no template yet. Returns templates created. */
export function ensureAgentTemplates(db: Db): number {
  if (db.get("SELECT 1 FROM agent_templates LIMIT 1")) return 0;
  const rows = db.all<{ id: string; name: string; role: string; department_id: string; skills: string; responsibilities: string; model: string | null; max_tokens_per_task: number | null }>(
    "SELECT id, name, role, department_id, skills, responsibilities, model, max_tokens_per_task FROM agents WHERE business_unit_id = 'hq' AND lifecycle <> 'ARCHIVED' AND is_primary_director = 0",
  );
  if (!rows.length) return 0;
  const agents: SourceAgent[] = rows.map((r) => ({
    id: r.id, name: r.name, role: r.role, departmentId: r.department_id, skills: json(r.skills, []), responsibilities: r.responsibilities,
    model: r.model, maxTokensPerTask: r.max_tokens_per_task,
    instructions: db.get<{ content: string }>(
      "SELECT content FROM instructions WHERE scope = 'AGENT' AND scope_id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1", r.id,
    )?.content ?? "",
    tools: db.all<{ connector_id: string; allowed_actions: string }>(
      "SELECT connector_id, allowed_actions FROM agent_connector_permissions WHERE agent_id = ?", r.id,
    ).map((p) => ({ connectorId: p.connector_id, actions: json<("read" | "write")[]>(p.allowed_actions, ["read"]) })),
  }));
  const seeds = groupAgents(agents);
  const t = now();
  db.tx(() => {
    const used = new Set<string>();
    for (const s of seeds) {
      let id = s.id || "andoza";
      for (let i = 2; used.has(id); i++) id = `${s.id}-${i}`;
      used.add(id);
      const v = s.version;
      db.run(
        "INSERT INTO agent_templates (id, name, category, status, allowed_departments, current_version, created_at) VALUES (?, ?, ?, 'APPROVED', ?, 1, ?)",
        id, s.name, s.category, JSON.stringify([s.departmentId]), t,
      );
      db.run(
        `INSERT INTO agent_template_versions (template_id, version, role, responsibilities, skills, instructions, tools, model, max_tokens_per_task,
           est_monthly_minor, risk_level, created_at, approved_at, approved_note)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'mavjud agentlardan')`,
        id, v.role, v.responsibilities, JSON.stringify(v.skills), v.instructions, JSON.stringify(v.tools), v.model, v.maxTokensPerTask, v.riskLevel, t, t,
      );
      for (const a of s.agentIds) db.run("UPDATE agents SET template_id = ?, template_version = 1 WHERE id = ?", id, a);
    }
  });
  return seeds.length;
}
