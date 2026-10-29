import { describe, expect, it } from "vitest";
import { adminClient, makeApp } from "./helpers.js";

describe("agents: create / update / connectors", () => {
  it("creates an agent with instructions and allowed connectors, and records audit", async () => {
    const { app, db } = await makeApp();
    const api = await adminClient(app);
    const r = await api.post("/api/agents", {
      name: "Sherali", role: "SEO Specialist", departmentId: "marketing",
      skills: ["seo"], instructions: "Faqat o'zbek tilida yoz.", connectorIds: ["analytics"],
    });
    expect(r.status).toBe(201);
    const id = r.body.agent.id;
    expect(r.body.agent).toMatchObject({ status: "IDLE", lifecycle: "ACTIVE", departmentId: "marketing" });
    const p = (await api.get(`/api/agents/${id}`)).body;
    expect(p.connectors.find((c: { id: string }) => c.id === "analytics").granted).toBe(true);
    expect(p.connectors.find((c: { id: string }) => c.id === "analytics").status).toBe("disconnected");
    expect(p.instructions.map((i: { scope: string }) => i.scope)).toEqual(["GLOBAL", "AGENT"]);
    expect(db.get("SELECT 1 FROM audit_logs WHERE action = 'agent.create' AND target_id = ?", id)).toBeTruthy();
  });

  it("refuses connectors the department is not allowed to use", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const r = await api.post("/api/agents", { name: "X", role: "Y", departmentId: "marketing", connectorIds: ["github"] });
    expect(r.status).toBe(400);
    expect((await api.put("/api/agents/marketing-madina/connectors", { connectorIds: ["accounting"] })).status).toBe(400);
  });

  it("validates input", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/agents", { name: "", role: "Y", departmentId: "it" })).status).toBe(400);
    expect((await api.post("/api/agents", { name: "A", role: "Y", departmentId: "nope" })).status).toBe(404);
    expect((await api.patch("/api/agents/it-aziz", { lifecycle: "ARCHIVED" })).status).toBe(400); // not patchable
  });
});

describe("agents: stable workstations", () => {
  it("seeds desks in roster order, unique per department", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const mk = (await api.get("/api/agents?departmentId=marketing")).body.agents as { id: string; workstation: number }[];
    expect(mk.find((a) => a.id === "marketing-madina")!.workstation).toBe(0);
    expect(new Set(mk.map((a) => a.workstation)).size).toBe(mk.length);
  });

  it("frees a desk on archive and reuses it on hire; transfer gets a free desk", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    await api.post("/api/agents/home-diyor/archive");
    const archived = (await api.get("/api/agents/home-diyor")).body.agent;
    expect(archived.workstation).toBeNull();
    const hired = (await api.post("/api/agents", { name: "Nigora", role: "Designer", departmentId: "home" })).body.agent;
    expect(hired.workstation).toBe(0);
    const moved = (await api.post("/api/agents/it-jasur/transfer", { departmentId: "home" })).body.agent;
    expect(moved.workstation).toBe(2); // 0 = Nigora, 1 = Sabina
  });
});

describe("agents: lifecycle", () => {
  it("pause blocks new assignments, resume allows them", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/agents/it-aziz/pause")).body.agent.lifecycle).toBe("PAUSED");
    expect((await api.post("/api/tasks", { title: "t", agentId: "it-aziz" })).status).toBe(400);
    expect((await api.post("/api/agents/it-aziz/resume")).body.agent.lifecycle).toBe("ACTIVE");
    expect((await api.post("/api/tasks", { title: "t", agentId: "it-aziz" })).status).toBe(201);
  });

  it("archive with open tasks requires a strategy; history is kept", async () => {
    const { app, db } = await makeApp();
    const api = await adminClient(app);
    const t = (await api.post("/api/tasks", { title: "open work", agentId: "sales-rustam" })).body.task;
    const refused = await api.post("/api/agents/sales-rustam/archive");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("agent_has_open_tasks");

    const ok = await api.post("/api/agents/sales-rustam/archive", { strategy: "reassign", toAgentId: "sales-timur" });
    expect(ok.status).toBe(200);
    expect(ok.body.agent.lifecycle).toBe("ARCHIVED");
    expect((await api.get(`/api/tasks/${t.id}`)).body.task.agentId).toBe("sales-timur");
    // still in DB, hidden from default list, visible with includeArchived
    expect(db.get("SELECT 1 FROM agents WHERE id = 'sales-rustam'")).toBeTruthy();
    const list = (await api.get("/api/agents?departmentId=sales")).body.agents.map((a: { id: string }) => a.id);
    expect(list).not.toContain("sales-rustam");
    const all = (await api.get("/api/agents?departmentId=sales&includeArchived=true")).body.agents.map((a: { id: string }) => a.id);
    expect(all).toContain("sales-rustam");
    // archived agents cannot get work
    expect((await api.post("/api/tasks", { title: "x", agentId: "sales-rustam" })).status).toBe(400);
  });

  it("archive with cancel strategy cancels open tasks", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const t = (await api.post("/api/tasks", { title: "w", agentId: "hr-gavhar" })).body.task;
    await api.post("/api/agents/hr-gavhar/archive", { strategy: "cancel" });
    expect((await api.get(`/api/tasks/${t.id}`)).body.task.status).toBe("CANCELLED");
  });

  it("stop affects only that agent's in-flight work", async () => {
    const { app, deps } = await makeApp();
    const api = await adminClient(app);
    const mine = (await api.post("/api/tasks", { title: "mine", agentId: "it-aziz", priority: "URGENT" })).body.task;
    const other = (await api.post("/api/tasks", { title: "other", agentId: "it-malika", priority: "URGENT" })).body.task;
    const { claimNextTask } = await import("../src/domain/tasks.js");
    claimNextTask(deps, "w1", 60_000);
    claimNextTask(deps, "w1", 60_000);
    const r = await api.post("/api/agents/it-aziz/stop");
    expect(r.body.stoppedTasks).toEqual([mine.id]);
    expect((await api.get(`/api/tasks/${mine.id}`)).body.task.status).toBe("BLOCKED");
    expect((await api.get(`/api/tasks/${other.id}`)).body.task.status).toBe("IN_PROGRESS");
  });

  it("transfer moves the agent and drops connector grants the new department lacks", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    await api.put("/api/agents/marketing-bobur/connectors", { connectorIds: ["canva", "ads"] });
    const r = await api.post("/api/agents/marketing-bobur/transfer", { departmentId: "design" });
    expect(r.body.agent.departmentId).toBe("design");
    const p = (await api.get("/api/agents/marketing-bobur")).body;
    expect(p.connectors.filter((c: { granted: boolean }) => c.granted).map((c: { id: string }) => c.id)).toEqual(["canva"]);
  });
});
