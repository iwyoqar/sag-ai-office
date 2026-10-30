// W3.2 HQ AI Director. Every LLM call here is a scripted test double (MockLlm / fake SDK): these tests verify the
// platform's logic — routing, planning, delegation, evaluation, hiring, limits — never real Gemini or Claude output.
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { adminClient, client, loginCookie, addUser, makeApp } from "./helpers.js";
import { AgentRunner } from "../src/agents/runner.js";
import { MockLlm, type MockReply } from "../src/llm/mock.js";
import { AnthropicClient, toClaudeMessages, type AnthropicApi } from "../src/llm/anthropic.js";
import { ProviderRouter } from "../src/llm/router.js";
import { LlmError, type LlmRequest } from "../src/llm/types.js";
import { createTask, getTask, listTasks } from "../src/domain/tasks.js";
import { directorAgent, selectAgent, workforceState } from "../src/domain/workforce.js";
import { requestHireForAgent } from "../src/domain/marketplace.js";
import { SYSTEM } from "../src/lib/audit.js";

const pricing = { inputPerM: 0.3, outputPerM: 2.5 };
const opts = { concurrency: 4, pollMs: 50, taskTimeoutMs: 5000, retryDelayMs: 1, settleMs: 5 };

async function drain(r: AgentRunner, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    const started = r.tick();
    if (!started.length && r.activeCount === 0) return;
    await Promise.all(started);
  }
}

const LONG = "To'liq natija: tahlil, raqamlar va taxminlar (taxmin: bozor o'sishi 8%), manba: ichki hisobot.";

/** Script for the HQ growth-strategy scenario; evaluations are decided by `judge` per subtask title. */
function scenario(judge: (title: string, round: number) => string = () => "ACCEPTED", extra: Partial<Record<string, unknown>> = {}): MockReply {
  return (req: LlmRequest) => {
    if (req.system.includes("Rejalashtiruvchi"))
      return JSON.stringify({
        objective: "SAG Home Design uchun choraklik o'sish strategiyasi",
        context: "Bozor, marketing, sotuv va moliya", expectedOutcome: "Yagona strategiya hujjati",
        requiredSkills: ["market research", "marketing", "sales", "finance"], approvalRequirements: "Budjet direktor tasdig'ida",
        subtasks: [
          { key: "s1", title: "Bozor tadqiqoti", description: "Raqobatchilar", department: "marketing", skills: ["market research"], deliverable: "Bozor hisoboti", dependsOn: [] },
          { key: "s2", title: "Marketing rejasi", description: "Kampaniyalar", department: "marketing", skills: ["marketing strategy"], deliverable: "Kampaniya rejasi", dependsOn: ["s1"] },
          { key: "s3", title: "Sotuv imkoniyatlari", description: "Voronka", department: "sales", skills: ["sales"], deliverable: "Imkoniyatlar ro'yxati", dependsOn: [] },
          { key: "s4", title: "Moliyaviy budjet", description: "Ssenariylar", department: "finance", skills: ["financial analysis"], deliverable: "Budjet jadvali", dependsOn: ["s2", "s3"] },
        ],
        missingSkills: [], ...extra,
      });
    if (req.system.includes("Baholovchi")) {
      const title = /## Kichik vazifa\n(.*)/.exec(req.messages[0].text)?.[1] ?? "";
      const round = Number(/qayta ishlash (\d)/.exec(title)?.[1] ?? 0);
      const verdict = judge(title.replace(/ \(qayta ishlash \d\)/, ""), round);
      return JSON.stringify({ verdict, issues: verdict === "ACCEPTED" ? [] : ["Raqamlar uchun taxminlar yo'q"], feedback: verdict === "ACCEPTED" ? "" : "Taxminlarni qo'shing" });
    }
    if (req.system.includes("Birlashtiruvchi")) return "# Choraklik o'sish strategiyasi\nYakuniy hujjat (MOCK).";
    const title = /Sarlavha: (.*)/.exec(req.messages[0].text)?.[1] ?? "?";
    return `natija: ${title}. ${LONG}`;
  };
}

async function hq(reply: MockReply) {
  const env = await makeApp();
  const llm = new MockLlm(reply);
  const r = new AgentRunner(env.deps, llm, pricing, opts);
  return { ...env, llm, r };
}

// ---------------------------------------------------------------- providers

const sdkError = <T extends new (...a: never[]) => Error>(C: T, status: number) =>
  new (C as unknown as new (s: number, e: unknown, m: string, h: Headers) => Error)(status, { type: "error" }, "x", new Headers({ "retry-after": "3" }));

function fakeSdk(create: (body: Record<string, unknown>) => unknown, retrieve: () => unknown = () => ({ id: "m" })): AnthropicApi {
  return { beta: { messages: { create: async (b) => create(b) } }, models: { retrieve: async () => retrieve() } };
}

describe("providers", () => {
  it("health checks tell not configured, invalid credentials, rate limited, available and unavailable apart", async () => {
    const ok = new AnthropicClient({ apiKey: "k", model: "claude-opus-5-5", api: fakeSdk(() => ({}), () => ({ id: "claude-opus-5-5" })) });
    expect((await ok.health()).status).toBe("available");
    const bad = new AnthropicClient({ apiKey: "k", model: "m", api: fakeSdk(() => ({}), () => { throw sdkError(Anthropic.AuthenticationError, 401); }) });
    expect((await bad.health()).status).toBe("invalid_credentials");
    const limited = new AnthropicClient({ apiKey: "k", model: "m", api: fakeSdk(() => ({}), () => { throw sdkError(Anthropic.RateLimitError, 429); }) });
    expect((await limited.health()).status).toBe("rate_limited");
    const down = new AnthropicClient({ apiKey: "k", model: "m", api: fakeSdk(() => ({}), () => { throw sdkError(Anthropic.InternalServerError, 503); }) });
    expect((await down.health()).status).toBe("unavailable");
    const router = new ProviderRouter({ clients: { anthropic: ok }, defaultProvider: "anthropic", fallback: [], pricing: {} });
    const all = await router.healthAll();
    expect(all.find((h) => h.provider === "gemini")!.status).toBe("not_configured");
    expect(all.find((h) => h.provider === "anthropic")!.status).toBe("available");
  });

  it("Claude: tool calls keep their ids, usage is the provider's, errors map to classes", async () => {
    let sent: Record<string, unknown> = {};
    const c = new AnthropicClient({
      apiKey: "k", model: "claude-opus-5-5",
      api: fakeSdk((b) => {
        sent = b;
        return { content: [{ type: "text", text: "salom" }, { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }], model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } };
      }),
    });
    const res = await c.generate({ system: "s", messages: [{ role: "user", text: "hi" }], correlationId: "c" });
    expect(res).toMatchObject({ text: "salom", inputTokens: 11, outputTokens: 7, provider: "anthropic", toolCalls: [{ id: "tu_1", name: "search", args: { q: "x" } }] });
    expect(sent).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(JSON.stringify(sent)).not.toContain("api"); // no key in the request body
    const msgs = toClaudeMessages([
      { role: "model", text: "", toolCalls: [{ id: "tu_1", name: "search", args: { q: "x" } }] },
      { role: "user", text: "", toolResults: [{ id: "tu_1", name: "search", response: { ok: true } }] },
    ]);
    expect(msgs).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "{\"ok\":true}" }] },
    ]);
    const limited = new AnthropicClient({ apiKey: "k", model: "m", api: fakeSdk(() => { throw sdkError(Anthropic.RateLimitError, 429); }) });
    await expect(limited.generate({ system: "s", messages: [{ role: "user", text: "x" }], correlationId: "c" })).rejects.toMatchObject({ code: "rate_limit", retryable: true, retryAfterMs: 3000 });
    const refused = new AnthropicClient({ apiKey: "k", model: "m", api: fakeSdk(() => ({ content: [], model: "m", stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } })) });
    await expect(refused.generate({ system: "s", messages: [{ role: "user", text: "x" }], correlationId: "c" })).rejects.toMatchObject({ code: "blocked" });
  });

  it("routes per agent, falls back on rate limits only, and prices at the answering provider", async () => {
    const g = new MockLlm(() => new LlmError("429", "rate_limit", true));
    const a = new MockLlm("claude javobi");
    const router = new ProviderRouter({
      clients: { gemini: g, anthropic: a }, defaultProvider: "gemini", fallback: ["anthropic"],
      pricing: { gemini: { inputPerM: 1, outputPerM: 1 }, anthropic: { inputPerM: 1000, outputPerM: 1000 } },
    });
    const res = await router.generate({ system: "s", messages: [{ role: "user", text: "x" }], correlationId: "c" });
    expect(res.text).toBe("claude javobi");
    expect(res.provider).toBe("anthropic");
    expect(res.costUsd).toBeGreaterThan(0);
    // the agent's own provider goes first
    expect(router.order({ route: { provider: "anthropic" } })).toEqual(["anthropic"]); // only listed providers are fallbacks
    expect(router.order({})).toEqual(["gemini", "anthropic"]);
    // a refusal is not retried elsewhere
    const blocked = new ProviderRouter({ clients: { gemini: new MockLlm(() => new LlmError("no", "blocked", false)), anthropic: a }, defaultProvider: "gemini", fallback: ["anthropic"], pricing: {} });
    await expect(blocked.generate({ system: "s", messages: [{ role: "user", text: "x" }], correlationId: "c" })).rejects.toMatchObject({ code: "blocked" });
    // no fallback configured: the error stands
    const single = new ProviderRouter({ clients: { gemini: g }, defaultProvider: "gemini", fallback: [], pricing: {} });
    await expect(single.generate({ system: "s", messages: [{ role: "user", text: "x" }], correlationId: "c" })).rejects.toMatchObject({ code: "rate_limit" });
  });

  it("records the provider on runs and usage for a real task run through the router", async () => {
    const { deps } = await makeApp();
    const router = new ProviderRouter({ clients: { mock: new MockLlm(`javob. ${LONG}`) }, defaultProvider: "mock", fallback: [], pricing: { mock: { inputPerM: 2, outputPerM: 2 } } });
    const r = new AgentRunner(deps, router, pricing, opts);
    const t = createTask(deps, { title: "Bitta ish", agentId: "marketing-javohir" }, SYSTEM);
    await drain(r);
    const run = deps.db.get<{ provider: string; cost_usd: number }>("SELECT provider, cost_usd FROM agent_runs WHERE task_id = ?", t.id)!;
    expect(run.provider).toBe("mock");
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(deps.db.get<{ provider: string }>("SELECT provider FROM usage_records WHERE task_id = ?", t.id)!.provider).toBe("mock");
  });
});

// ---------------------------------------------------------------- the AI Director

describe("AI Director: plan, staff, delegate, evaluate, combine", () => {
  it("final acceptance (MOCK providers): growth strategy runs end to end with real subtasks, dependencies and evaluations", async () => {
    const e = await hq(scenario());
    const parent = createTask(e.deps, { title: "SAG Home Design uchun choraklik o'sish strategiyasi", limits: { maxCostUsd: 5 } }, SYSTEM);
    expect(parent.kind).toBe("orchestrate");
    expect(parent.agentId).toBe(directorAgent(e.deps));
    await drain(e.r);
    const p = getTask(e.deps, parent.id);
    expect(p.status).toBe("DONE");
    const plan = JSON.parse(e.db.get<{ plan: string }>("SELECT plan FROM tasks WHERE id = ?", parent.id)!.plan);
    expect(plan).toMatchObject({ objective: expect.stringContaining("o'sish"), expectedOutcome: "Yagona strategiya hujjati" });
    const kids = listTasks(e.deps, { parentId: parent.id });
    expect(kids).toHaveLength(4);
    expect(kids.every((k) => k.status === "DONE" && k.agentId)).toBe(true);
    // staffed from the right departments, spread over agents
    const dep = (title: string) => kids.find((k) => k.title === title)!.departmentId;
    expect([dep("Bozor tadqiqoti"), dep("Sotuv imkoniyatlari"), dep("Moliyaviy budjet")]).toEqual(["marketing", "sales", "finance"]);
    // dependency order: the budget ran after the marketing plan and the sales piece and saw their results
    const budgetCall = e.llm.calls.find((c) => c.messages[0].text.includes("Sarlavha: Moliyaviy budjet"))!;
    expect(budgetCall.messages[0].text).toContain("natija: Marketing rejasi");
    expect(budgetCall.messages[0].text).toContain("natija: Sotuv imkoniyatlari");
    // one handoff record and one evaluation per subtask
    expect(e.db.get<{ n: number }>("SELECT COUNT(*) n FROM task_handoffs WHERE parent_task_id = ?", parent.id)!.n).toBe(4);
    expect(e.db.all<{ verdict: string }>("SELECT verdict FROM task_evaluations WHERE parent_task_id = ?", parent.id).map((x) => x.verdict)).toEqual(Array(4).fill("ACCEPTED"));
    // the final deliverable, history, usage and cost
    const titles = e.db.all<{ title: string }>("SELECT title FROM deliverables WHERE task_id = ? ORDER BY created_at", parent.id).map((x) => x.title);
    expect(titles).toEqual(["Ish rejasi", "Yakuniy natija"]);
    const fam = e.db.get<{ tok: number; cost: number }>("SELECT SUM(tokens_in + tokens_out) tok, SUM(cost_usd) cost FROM tasks WHERE id = ? OR parent_id = ?", parent.id, parent.id)!;
    expect(fam.tok).toBeGreaterThan(0);
    expect(fam.cost).toBeGreaterThan(0);
    expect(e.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_runs WHERE mode = 'mock'")!.n).toBeGreaterThan(0); // labelled: not real AI
    // the human director (admin) is told it is done
    const admin = e.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    expect(e.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'project.completed'", admin)).toBeTruthy();
    // live state reflects it
    const st = workforceState(e.deps);
    expect(st.projects[0]).toMatchObject({ id: parent.id, status: "DONE" });
    expect(st.projects[0].subtasks.map((s) => s.verdict)).toEqual(Array(4).fill("ACCEPTED"));
  });

  it("returns an insufficient result for revision, keeps the earlier version, and accepts the redo", async () => {
    const e = await hq(scenario((title, round) => (title === "Moliyaviy budjet" && round === 0 ? "NEEDS_REVISION" : "ACCEPTED")));
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r);
    expect(getTask(e.deps, parent.id).status).toBe("DONE");
    const kids = listTasks(e.deps, { parentId: parent.id });
    const original = kids.find((k) => k.title === "Moliyaviy budjet")!;
    const redo = kids.find((k) => k.revisionOf === original.id)!;
    expect(redo.title).toBe("Moliyaviy budjet (qayta ishlash 1)");
    expect(redo.agentId).toBe(original.agentId);
    expect(redo.description).toContain("Taxminlarni qo'shing");
    // both versions of the deliverable are kept
    expect(e.db.get("SELECT 1 FROM deliverables WHERE task_id = ?", original.id)).toBeTruthy();
    expect(e.db.get("SELECT 1 FROM deliverables WHERE task_id = ?", redo.id)).toBeTruthy();
    const ev = e.db.all<{ task_id: string; verdict: string; revision_task_id: string | null }>("SELECT task_id, verdict, revision_task_id FROM task_evaluations WHERE parent_task_id = ?", parent.id);
    expect(ev.find((x) => x.task_id === original.id)).toMatchObject({ verdict: "NEEDS_REVISION", revision_task_id: redo.id });
    expect(ev.find((x) => x.task_id === redo.id)!.verdict).toBe("ACCEPTED");
    // the redo got the earlier version as context
    expect(e.llm.calls.find((c) => c.messages[0].text.includes("Sarlavha: Moliyaviy budjet (qayta ishlash 1)"))!.messages[0].text).toContain("natija: Moliyaviy budjet.");
  });

  it("stops revising at the limit and sends the result to a person instead of looping", async () => {
    const e = await hq(scenario((title) => (title === "Sotuv imkoniyatlari" ? "NEEDS_REVISION" : "ACCEPTED")));
    e.db.run("UPDATE ai_director_settings SET max_revisions = 1 WHERE business_unit_id = 'hq'");
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r, 60);
    const p = getTask(e.deps, parent.id);
    expect(p.status).toBe("WAITING_APPROVAL");
    const sales = listTasks(e.deps, { parentId: parent.id }).filter((k) => k.title.startsWith("Sotuv imkoniyatlari"));
    expect(sales).toHaveLength(2); // the original and exactly one revision
    const redo = sales.find((k) => k.revisionOf)!;
    expect(e.db.get<{ verdict: string }>("SELECT verdict FROM task_evaluations WHERE task_id = ?", redo.id)!.verdict).toBe("NEEDS_HUMAN_REVIEW");
    expect(e.db.get("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'PENDING'", parent.id)).toBeTruthy();
  });

  it("a rejected result blocks the project and tells the human director", async () => {
    const e = await hq(scenario((title) => (title === "Bozor tadqiqoti" ? "REJECTED" : "ACCEPTED")));
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r);
    expect(getTask(e.deps, parent.id)).toMatchObject({ status: "BLOCKED" });
    expect(getTask(e.deps, parent.id).error).toContain("Natija rad etildi");
    expect(e.db.get("SELECT 1 FROM notifications WHERE kind = 'project.blocked'")).toBeTruthy();
  });

  it("an empty deliverable fails the deterministic check without asking the model", async () => {
    let n = 0;
    const base = scenario();
    const e = await hq((req) => {
      if (!req.system.includes("Rejalashtiruvchi") && !req.system.includes("Baholovchi") && !req.system.includes("Birlashtiruvchi") && /Sarlavha: Bozor tadqiqoti$/m.test(req.messages[0].text) && n++ === 0) return "qisqa";
      return (base as (r: LlmRequest) => string)(req);
    });
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r);
    const first = listTasks(e.deps, { parentId: parent.id }).find((k) => k.title === "Bozor tadqiqoti")!;
    expect(e.db.get<{ verdict: string; evaluator: string }>("SELECT verdict, evaluator FROM task_evaluations WHERE task_id = ?", first.id)).toMatchObject({ verdict: "NEEDS_REVISION", evaluator: "checks" });
  });

  it("subtasks never orchestrate again (no delegation loops) and the plan size is capped", async () => {
    const e = await hq(scenario());
    e.db.run("UPDATE ai_director_settings SET max_subtasks = 2 WHERE business_unit_id = 'hq'");
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r);
    expect(getTask(e.deps, parent.id).status).toBe("FAILED"); // the 4-piece plan exceeds the cap of 2 (twice)
    expect(getTask(e.deps, parent.id).error).toContain("Juda ko'p kichik vazifa");
    const e2 = await hq(scenario());
    const p2 = createTask(e2.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e2.r);
    expect(listTasks(e2.deps, { parentId: p2.id }).every((k) => k.kind === "single")).toBe(true);
  });

  it("the whole project spends from one budget: a subtask stops when the job's cost ceiling is reached", async () => {
    const e = await hq(scenario());
    const parent = createTask(e.deps, { title: "O'sish strategiyasi", limits: { maxCostUsd: 0.000001 } }, SYSTEM);
    await drain(e.r);
    const p = getTask(e.deps, parent.id);
    expect(["FAILED", "BLOCKED"]).toContain(p.status);
    expect(`${p.error}`).toMatch(/limiti tugadi/);
  });
});

// ---------------------------------------------------------------- staffing, hiring, isolation

describe("staffing and request_hire", () => {
  it("selects by skill within the unit, never a store agent, never a paused one", async () => {
    const { deps, db } = await makeApp();
    const c = selectAgent(deps, { unitId: "hq", departmentId: "finance", skills: ["financial analysis"], title: "Budjet" })!;
    expect(db.get<{ department_id: string; business_unit_id: string }>("SELECT department_id, business_unit_id FROM agents WHERE id = ?", c.agentId)).toMatchObject({ department_id: "finance", business_unit_id: "hq" });
    db.run("UPDATE agents SET lifecycle = 'PAUSED' WHERE department_id = 'finance'");
    const after = selectAgent(deps, { unitId: "hq", departmentId: "finance", skills: ["xyzzy"], title: "zzz" });
    expect(after).toBeNull();
  });

  it("a missing skill becomes a PENDING hire request under APPROVAL; RESTRICTED refuses; no duplicates; only the director asks", async () => {
    const { deps, db } = await makeApp();
    const dir = directorAgent(deps)!;
    const tpl = db.get<{ id: string; category: string }>("SELECT id, category FROM agent_templates WHERE category = 'finance' LIMIT 1")!;
    const role = db.get<{ role: string }>("SELECT role FROM agent_template_versions WHERE template_id = ?", tpl.id)!.role;
    db.run("UPDATE agents SET lifecycle = 'ARCHIVED' WHERE template_id = ?", tpl.id); // the department lacks it now
    const ask = (agentId = dir) => requestHireForAgent(deps, agentId, { skill: role, departmentId: "finance", reason: "audit uchun", directorOf: (u) => directorAgent(deps, u), maxPending: 3 });
    const r = ask();
    expect(r.status).toBe("requested");
    const req = "request" in r ? r.request : null;
    expect(req).toMatchObject({ status: "PENDING", templateId: tpl.id });
    expect(db.get<{ requested_by_type: string; policy_at_request: string }>("SELECT requested_by_type, policy_at_request FROM agent_hire_requests WHERE id = ?", req!.id)).toMatchObject({ requested_by_type: "agent", policy_at_request: "APPROVAL" });
    expect(ask().status).toBe("duplicate");
    expect(ask("marketing-javohir").status).toBe("refused");
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    expect(db.get("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'hire.pending'", admin)).toBeTruthy();
    db.run("UPDATE agent_hire_requests SET status = 'CANCELLED'");
    db.run("UPDATE unit_policies SET hiring_policy = 'RESTRICTED' WHERE business_unit_id = 'hq'");
    expect(ask().status).toBe("refused");
    // AUTO hires only within the allowlist and limits
    db.run("UPDATE unit_policies SET hiring_policy = 'AUTO' WHERE business_unit_id = 'hq'");
    expect(ask()).toMatchObject({ status: "requested" }); // not on the AUTO list → still a request
    db.run("UPDATE agent_hire_requests SET status = 'CANCELLED'");
    db.run("INSERT INTO department_hiring_limits (department_id, auto_templates, updated_at) VALUES ('finance', ?, 'x')", JSON.stringify([tpl.id]));
    const hired = ask();
    expect(hired.status).toBe("hired");
    expect(ask().status).toBe("agent_exists"); // never a second one
  });

  it("the plan's missing skills go to the Marketplace through the existing requests (APPROVAL: nothing hired)", async () => {
    const e = await hq(scenario(() => "ACCEPTED", { missingSkills: [{ skill: "Financial Analyst", department: "finance", reason: "audit" }] }));
    const tpl = e.db.get<{ id: string }>("SELECT t.id FROM agent_templates t JOIN agent_template_versions v ON v.template_id = t.id WHERE v.role = 'Financial Analyst'")!;
    e.db.run("UPDATE agents SET lifecycle = 'PAUSED' WHERE template_id = ?", tpl.id);
    const before = e.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE lifecycle = 'ACTIVE'")!.n;
    const parent = createTask(e.deps, { title: "O'sish strategiyasi" }, SYSTEM);
    await drain(e.r);
    expect(e.db.get<{ status: string; requested_by_type: string }>("SELECT status, requested_by_type FROM agent_hire_requests WHERE template_id = ?", tpl.id)).toMatchObject({ status: "PENDING", requested_by_type: "agent" });
    expect(e.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE lifecycle = 'ACTIVE'")!.n).toBe(before);
    expect(e.db.get("SELECT 1 FROM deliverables WHERE task_id = ? AND title = 'Yollash so''rovlari'", parent.id)).toBeTruthy();
  });

  it("workforce API: live counts for the admin, 403 for an employee", async () => {
    const { app, db } = await makeApp();
    const admin = await adminClient(app);
    const r = await admin.get("/api/workforce");
    expect(r.status).toBe(200);
    expect(r.body.state).toMatchObject({ templates: 46, agents: { suspended: 0 }, hireRequestsPending: 0 });
    expect(r.body.state.agents.active).toBe(db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE business_unit_id = 'hq' AND lifecycle = 'ACTIVE'")!.n);
    expect(r.body.state.director.agentId).toBe("director-director-ai");
    const emp = await addUser(db, "wf.emp", "employee");
    const ec = client(app, await loginCookie(app, emp.username, emp.password));
    expect((await ec.get("/api/workforce")).status).toBe(403);
    expect((await admin.put("/api/workforce/director", { maxRevisions: 1, provider: "anthropic" })).body.state.director).toMatchObject({ provider: "anthropic", limits: { maxRevisions: 1 } });
    expect((await ec.put("/api/agents/marketing-javohir/provider", { provider: "anthropic" })).status).toBe(403);
    expect((await admin.put("/api/agents/marketing-javohir/provider", { provider: "anthropic", model: null })).status).toBe(200);
    expect(db.get<{ provider: string }>("SELECT provider FROM agents WHERE id = 'marketing-javohir'")!.provider).toBe("anthropic");
  });
});
