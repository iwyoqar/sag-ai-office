// W4 agent marketplace (HQ first): catalog from the existing agents, hire checks, AUTO / admin decisions, archive-all.
import { describe, expect, it } from "vitest";
import type { TemplateTool } from "@sag/shared";
import { addUser, makeApp } from "./helpers.js";
import { loadUser } from "../src/lib/auth.js";
import {
  addVersion, approveVersion, checkHire, createTemplate, getLimits, retireTemplate, setLimit, type VersionInput,
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
