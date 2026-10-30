// W4 agent marketplace (HQ first): catalog from the existing agents, hire checks, AUTO / admin decisions, archive-all.
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
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
