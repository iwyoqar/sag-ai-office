// W4 agent marketplace (HQ first): catalog from the existing agents, hire checks, AUTO / admin decisions, archive-all.
import { describe, expect, it } from "vitest";
import { OPEN_TASK_STATUSES, type TemplateTool } from "@sag/shared";
import { addUser, makeApp } from "./helpers.js";
import { loadUser } from "../src/lib/auth.js";
import { createTask } from "../src/domain/tasks.js";
import {
  addVersion, approveRequest, archiveAll, archivePreview, approveVersion, checkHire, createTemplate, getLimits, listRequests, rejectRequest, requestHire,
  retireTemplate, setLimit, type VersionInput,
} from "../src/domain/marketplace.js";
import { ensureAgentTemplates, groupAgents, type SourceAgent } from "../src/domain/templatesFromAgents.js";

const src = (p: Partial<SourceAgent> & { id: string; role: string }): SourceAgent => ({
  name: p.id, departmentId: "marketing", skills: [], responsibilities: "", model: null, maxTokensPerTask: null,
  instructions: "", tools: [], ...p,
});

describe("catalog from agents", () => {
  it("groupAgents merges same role in a department, unions tools, flags write as HIGH", () => {
    const seeds = groupAgents([
      src({ id: "a1", role: "SMM Specialist", tools: [{ connectorId: "gmail", actions: ["read"] }] }),
      src({ id: "a2", role: " smm  specialist", tools: [{ connectorId: "gmail", actions: ["write"] }, { connectorId: "drive", actions: ["read"] }] }),
    ]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].agentIds).toEqual(["a1", "a2"]);
    const tools = Object.fromEntries(seeds[0].version.tools.map((t) => [t.connectorId, [...t.actions].sort()]));
    expect(tools).toEqual({ gmail: ["read", "write"], drive: ["read"] });
    expect(seeds[0].version.riskLevel).toBe("HIGH");
    expect(seeds[0].departmentId).toBe("marketing");
  });

  it("ensureAgentTemplates on the seeded DB links every agent and runs once", async () => {
    const { db } = await makeApp();
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_templates")!.n).toBeGreaterThan(0);
    const unlinked = db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE business_unit_id = 'hq' AND lifecycle <> 'ARCHIVED' AND template_id IS NULL")!.n;
    expect(unlinked).toBe(0);
    const bad = db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_templates WHERE status <> 'APPROVED' OR current_version <> 1")!.n;
    expect(bad).toBe(0);
    expect(ensureAgentTemplates(db)).toBe(0);
  });
});

// ---------------------------------------------------------------- checks, templates, limits

const V = (p: Partial<VersionInput> = {}): VersionInput => ({
  role: "Kontent menejer", responsibilities: "Postlar", skills: ["SMM"], instructions: "Qisqa yoz", tools: [],
  model: null, maxTokensPerTask: 4000, estMonthlyMinor: 0, ...p,
});

async function market() {
  const env = await makeApp();
  const { db, deps } = env;
  const admin = loadUser(db, db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id)!;
  const headId = (await addUser(db, "m.head", "employee")).id;
  db.run("UPDATE departments SET head_user_id = ? WHERE id = 'marketing'", headId);
  const head = () => loadUser(db, headId)!;
  const depConnectors = (dep: string) =>
    db.all<{ connector_id: string }>("SELECT connector_id FROM department_connectors WHERE department_id = ?", dep).map((r) => r.connector_id);
  /** an approved template for marketing, on the AUTO list, with generous limits */
  const approved = (p: Partial<VersionInput> = {}, allowedDepartments = ["marketing"]) => {
    const t = createTemplate(deps, admin, { name: "Kontent menejer", category: "marketing", allowedDepartments, version: V(p) });
    approveVersion(deps, admin, t.id, 1);
    setLimit(deps, admin, "marketing", { maxAgents: 100, monthlyBudgetMinor: null, autoTemplates: [t.id] });
    return t.id;
  };
  return { ...env, admin, head, headId, depConnectors, approved };
}
const failing = (checks: { id: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.id);

describe("checks", () => {
  it("each check fails on its own with a recorded detail", async () => {
    const m = await market();
    const id = m.approved();
    const base = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(failing(base.checks)).toEqual([]);
    expect(base.outcome).toBe("hire");
    expect(base.checks.map((c) => c.id)).toEqual(["template_approved", "department_allowed", "tools_within", "pending_cap", "agent_count", "budget", "auto_listed", "risk"]);

    const other = checkHire(m.deps, { templateId: id, departmentId: "procurement", requester: "admin" });
    expect(failing(other.checks)).toContain("department_allowed");
    expect(other.outcome).toBe("reject");

    const active = m.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE department_id = 'marketing' AND lifecycle <> 'ARCHIVED'")!.n;
    setLimit(m.deps, m.admin, "marketing", { maxAgents: active });
    let r = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toEqual(["agent_count"]);
    expect(r.outcome).toBe("pending");
    expect(r.checks.find((c) => c.id === "agent_count")!.detail).toContain(String(active));

    const pricey = m.approved({ estMonthlyMinor: 500 });
    setLimit(m.deps, m.admin, "marketing", { maxAgents: null, monthlyBudgetMinor: 100, autoTemplates: [pricey] });
    r = checkHire(m.deps, { templateId: pricey, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toEqual(["budget"]);
    expect(r.outcome).toBe("pending");

    setLimit(m.deps, m.admin, "marketing", { monthlyBudgetMinor: null, autoTemplates: [] });
    r = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toEqual(["auto_listed"]);
    expect(r.outcome).toBe("pending");

    const risky = m.approved({ tools: [{ connectorId: m.depConnectors("marketing")[0], actions: ["read", "write"] }] });
    r = checkHire(m.deps, { templateId: risky, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toEqual(["risk"]);
    expect(r.outcome).toBe("pending");

    for (let i = 0; i < 5; i++)
      m.db.run(
        `INSERT INTO agent_hire_requests (id, template_id, template_version, department_id, requested_by_id, justification, policy_at_request, checks, created_at)
         VALUES (?, ?, 1, 'marketing', ?, 'x', 'AUTO', '[]', ?)`, `req${i}`, id, m.headId, new Date().toISOString(),
      );
    r = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toContain("pending_cap");
    expect(r.outcome).toBe("reject");

    retireTemplate(m.deps, m.admin, id);
    r = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(failing(r.checks)).toContain("template_approved");
    expect(r.outcome).toBe("reject");
  });

  it("max_agents 0 sends every head request to the admin; null never blocks", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { maxAgents: 0 });
    expect(checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" }).outcome).toBe("pending");
    expect(checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "admin" }).outcome).toBe("hire");
    setLimit(m.deps, m.admin, "marketing", { maxAgents: null });
    expect(checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" }).outcome).toBe("hire");
  });

  it("grants are template tools ∩ department connectors; none allowed still passes", async () => {
    const m = await market();
    const [allowed] = m.depConnectors("marketing");
    const outside = m.db.get<{ id: string }>(
      "SELECT id FROM connectors WHERE id NOT IN (SELECT connector_id FROM department_connectors WHERE department_id = 'marketing') LIMIT 1",
    )!.id;
    const tools: TemplateTool[] = [{ connectorId: allowed, actions: ["read"] }, { connectorId: outside, actions: ["read"] }];
    const id = m.approved({ tools }, []);
    const r = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(r.grants).toEqual([{ connectorId: allowed, actions: ["read"] }]);
    const t = r.checks.find((c) => c.id === "tools_within")!;
    expect(t.ok).toBe(true);
    expect(t.detail).toContain(outside);
    // a department that allows none of the connectors: zero grants, still a pass
    m.db.run("DELETE FROM department_connectors WHERE department_id = 'marketing'");
    const none = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" });
    expect(none.grants).toEqual([]);
    expect(none.checks.find((c) => c.id === "tools_within")!.ok).toBe(true);
  });
});

describe("templates and limits", () => {
  it("approved versions are immutable; edits make drafts", async () => {
    const m = await market();
    const id = m.approved();
    const t = addVersion(m.deps, m.admin, id, V({ role: "Kontent lideri" }));
    expect(t.current!.version).toBe(1);
    expect(t.current!.role).toBe("Kontent menejer");
    expect(t.draft!.version).toBe(2);
    const after = approveVersion(m.deps, m.admin, id, 2);
    expect(after.currentVersion).toBe(2);
    expect(after.current!.role).toBe("Kontent lideri");
    expect(after.draft).toBeNull();
    expect(() => approveVersion(m.deps, m.admin, id, 1)).toThrow();
  });

  it("only the admin writes templates and limits; heads read their own limits", async () => {
    const m = await market();
    expect(() => createTemplate(m.deps, m.head(), { name: "X", category: "marketing", allowedDepartments: [], version: V() })).toThrow();
    expect(() => setLimit(m.deps, m.head(), "marketing", { maxAgents: 1 })).toThrow();
    expect(getLimits(m.deps, m.head()).map((l) => l.departmentId)).toEqual(["marketing"]);
    expect(getLimits(m.deps, m.admin).length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------- hiring

const agentsIn = (db: Awaited<ReturnType<typeof market>>["db"], dep: string) =>
  db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE department_id = ? AND lifecycle <> 'ARCHIVED'", dep)!.n;
const notes = (db: Awaited<ReturnType<typeof market>>["db"], userId: string, kind: string) =>
  db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = ?", userId, kind)!.n;

describe("hiring", () => {
  it("AUTO: a head's fully passing request hires at once", async () => {
    const m = await market();
    const [c] = m.depConnectors("marketing");
    const id = m.approved({ tools: [{ connectorId: c, actions: ["read"] }] });
    const expected = checkHire(m.deps, { templateId: id, departmentId: "marketing", requester: "head" }).grants;
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kontent ko'paydi" });
    expect(r).toMatchObject({ status: "APPROVED", decidedVia: "policy", override: false });
    const a = m.db.get<{ template_id: string; template_version: number; workstation: number | null; role: string }>(
      "SELECT template_id, template_version, workstation, role FROM agents WHERE id = ?", r.agentId,
    )!;
    expect(a).toMatchObject({ template_id: id, template_version: 1, role: "Kontent menejer" });
    expect(a.workstation).not.toBeNull();
    const grants = m.db.all<{ connector_id: string; allowed_actions: string }>("SELECT connector_id, allowed_actions FROM agent_connector_permissions WHERE agent_id = ?", r.agentId)
      .map((g) => ({ connectorId: g.connector_id, actions: JSON.parse(g.allowed_actions) }));
    expect(grants).toEqual(expected);
    expect(m.db.get<{ content: string }>("SELECT content FROM instructions WHERE scope = 'AGENT' AND scope_id = ?", r.agentId)!.content).toBe("Qisqa yoz");
  });

  it("soft failure → PENDING; admin approval re-runs checks and needs override", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { maxAgents: agentsIn(m.db, "marketing") });
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" });
    expect(r.status).toBe("PENDING");
    expect(notes(m.db, m.admin.id, "hire.pending")).toBe(1);
    expect(() => approveRequest(m.deps, m.admin, r.id, false)).toThrow(/override|limit/i);
    const before = agentsIn(m.db, "marketing");
    const ok = approveRequest(m.deps, m.admin, r.id, true);
    expect(ok).toMatchObject({ status: "APPROVED", decidedVia: "user", override: true });
    expect(agentsIn(m.db, "marketing")).toBe(before + 1);
    expect(notes(m.db, m.headId, "hire.decided")).toBe(1);
  });

  it("hard failure at decision time rejects", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { autoTemplates: [] });
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" });
    expect(r.status).toBe("PENDING");
    retireTemplate(m.deps, m.admin, id);
    const before = agentsIn(m.db, "marketing");
    const out = approveRequest(m.deps, m.admin, r.id, true);
    expect(out.status).toBe("REJECTED");
    expect(out.decisionReason).toContain("eskirgan");
    expect(agentsIn(m.db, "marketing")).toBe(before);
  });

  it("new approved version while pending → rejected as stale", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { autoTemplates: [] });
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" });
    addVersion(m.deps, m.admin, id, V({ role: "Yangi rol" }));
    approveVersion(m.deps, m.admin, id, 2);
    const out = approveRequest(m.deps, m.admin, r.id, true);
    expect(out.status).toBe("REJECTED");
    expect(out.decisionReason).toContain("yangilangan");
    expect(notes(m.db, m.headId, "hire.decided")).toBe(1);
  });

  it("concurrent approvals create one agent", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { autoTemplates: [] });
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" });
    const before = agentsIn(m.db, "marketing");
    approveRequest(m.deps, m.admin, r.id, true);
    expect(() => approveRequest(m.deps, m.admin, r.id, true)).toThrow(/already|hal qilingan/i);
    expect(agentsIn(m.db, "marketing")).toBe(before + 1);
  });

  it("head of two departments requests for both, not a third", async () => {
    const m = await market();
    m.db.run("UPDATE departments SET head_user_id = ? WHERE id = 'sales'", m.headId);
    const id = m.approved({}, []);
    expect(requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" }).status).not.toBe("REJECTED");
    expect(requestHire(m.deps, m.head(), { templateId: id, departmentId: "sales", justification: "Kerak" }).status).not.toBe("REJECTED");
    expect(() => requestHire(m.deps, m.head(), { templateId: id, departmentId: "procurement", justification: "Kerak" })).toThrow();
    // an ordinary employee cannot hire anywhere
    const emp = loadUser(m.db, (await addUser(m.db, "oddiy", "employee")).id)!;
    expect(() => requestHire(m.deps, emp, { templateId: id, departmentId: "marketing", justification: "Kerak" })).toThrow();
  });

  it("rejectRequest needs a reason and notifies the requester", async () => {
    const m = await market();
    const id = m.approved();
    setLimit(m.deps, m.admin, "marketing", { autoTemplates: [] });
    const r = requestHire(m.deps, m.head(), { templateId: id, departmentId: "marketing", justification: "Kerak" });
    expect(() => rejectRequest(m.deps, m.admin, r.id, "  ")).toThrow();
    const out = rejectRequest(m.deps, m.admin, r.id, "Hozir byudjet yo'q");
    expect(out).toMatchObject({ status: "REJECTED", decisionReason: "Hozir byudjet yo'q", decidedVia: "user" });
    expect(notes(m.db, m.headId, "hire.decided")).toBe(1);
    expect(listRequests(m.deps, m.head()).map((x) => x.id)).toContain(r.id);
  });
});

// ---------------------------------------------------------------- archive all

describe("archive all", () => {
  it("archive-all: preview counts, cancels open tasks, keeps history, idempotent", async () => {
    const m = await market();
    const agent = m.db.get<{ id: string }>("SELECT id FROM agents WHERE business_unit_id = 'hq' AND lifecycle = 'ACTIVE' ORDER BY id LIMIT 1")!.id;
    const task = createTask(m.deps, { title: "Ochiq ish", agentId: agent }, { type: "user", id: m.admin.id });
    const agents = m.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE business_unit_id = 'hq' AND lifecycle <> 'ARCHIVED' AND is_primary_director = 0")!.n;
    const open = m.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM tasks t JOIN agents a ON a.id = t.agent_id
       WHERE a.business_unit_id = 'hq' AND a.lifecycle <> 'ARCHIVED' AND a.is_primary_director = 0 AND t.status IN (${OPEN_TASK_STATUSES.map((x) => `'${x}'`).join(",")})`,
    )!.n;
    expect(open).toBeGreaterThanOrEqual(1);
    expect(archivePreview(m.deps, m.admin)).toEqual({ agents, openTasks: open });
    expect(() => archivePreview(m.deps, m.head())).toThrow();
    expect(() => archiveAll(m.deps, m.head())).toThrow();

    expect(archiveAll(m.deps, m.admin)).toEqual({ archived: agents, cancelledTasks: open });
    expect(m.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", task.id)!.status).toBe("CANCELLED");
    expect(m.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE business_unit_id = 'hq' AND lifecycle <> 'ARCHIVED' AND is_primary_director = 0")!.n).toBe(0);
    expect(m.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents")!.n).toBeGreaterThanOrEqual(agents); // history kept
    expect(m.db.get("SELECT 1 FROM audit_logs WHERE action = 'marketplace.archive_all'")).toBeTruthy();
    expect(archiveAll(m.deps, m.admin)).toEqual({ archived: 0, cancelledTasks: 0 });
  });
});
