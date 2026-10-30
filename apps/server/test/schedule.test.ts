import { describe, expect, it } from "vitest";
import { adminClient, makeApp } from "./helpers.js";
import { describeRule, nextOccurrence, occurrences, parseRule } from "../src/schedule/rrule.js";
import { calendar, createRoutine, runOccurrence, schedulerTick, setRoutineStatus, syncRunStatus } from "../src/schedule/service.js";
import { createTask, getTask, transitionTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";

const T = "Asia/Tashkent"; // UTC+5
const iso = (d: Date) => d.toISOString();

describe("recurrence rules (Asia/Tashkent)", () => {
  it("daily / weekly / monthly occurrences in local time", () => {
    // 2026-10-29 (Thursday) 10:00 Tashkent = 05:00Z
    const now = new Date("2026-10-29T05:00:00Z");
    expect(iso(nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", now, T))).toBe("2026-10-30T04:00:00.000Z");
    expect(iso(nextOccurrence("FREQ=DAILY;BYHOUR=11;BYMINUTE=30", now, T))).toBe("2026-10-29T06:30:00.000Z");
    expect(iso(nextOccurrence("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9", now, T))).toBe("2026-11-02T04:00:00.000Z");
    expect(iso(nextOccurrence("FREQ=WEEKLY;BYDAY=FR;BYHOUR=17", now, T))).toBe("2026-10-30T12:00:00.000Z");
    expect(iso(nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10", now, T))).toBe("2026-11-01T05:00:00.000Z");
    // 31st falls on the last day of shorter months; -1 = last day
    expect(iso(nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9", new Date("2026-11-01T00:00:00Z"), T))).toBe("2026-11-30T04:00:00.000Z");
    expect(iso(nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9", new Date("2027-02-01T00:00:00Z"), T))).toBe("2027-02-28T04:00:00.000Z");
  });

  it("interval and projections", () => {
    const anchor = new Date("2026-10-26T00:00:00Z"); // Monday
    const occ = occurrences("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9", anchor, new Date("2026-12-01T00:00:00Z"), T, anchor);
    expect(occ.map((d) => iso(d).slice(0, 10))).toEqual(["2026-10-26", "2026-11-09", "2026-11-23"]);
    expect(occurrences("FREQ=DAILY;BYHOUR=9", anchor, new Date("2026-10-31T00:00:00Z"), T)).toHaveLength(5);
  });

  it("validates and describes rules", () => {
    expect(() => parseRule("FREQ=YEARLY")).toThrow();
    expect(() => parseRule("FREQ=WEEKLY;BYHOUR=9")).toThrow(/BYDAY/);
    expect(() => parseRule("FREQ=DAILY;BYHOUR=25")).toThrow();
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=5")).toBe("Har dushanba, juma 09:05");
  });
});

describe("scheduler", () => {
  it("fires each occurrence exactly once, catches up once after downtime, advances next run", async () => {
    const { deps } = await makeApp();
    const created = new Date("2026-10-29T03:00:00Z");
    const r = createRoutine(deps, { name: "Kunlik marketing hisoboti", departmentId: "marketing", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" }, SYSTEM, created);
    expect(r.nextRunAt).toBe("2026-10-29T04:00:00.000Z");

    const at = new Date("2026-10-29T04:00:30Z");
    expect(schedulerTick(deps, at).routines).toBe(1);
    expect(schedulerTick(deps, at).routines).toBe(0); // second tick, same time
    expect(runOccurrence(deps, r.id, new Date("2026-10-29T04:00:00Z"))).toBeNull(); // concurrent duplicate

    // server was down for 3 days: one catch-up run, then the schedule continues from now
    const later = new Date("2026-11-01T06:00:00Z");
    expect(schedulerTick(deps, later).routines).toBe(1);
    const row = deps.db.get<{ next_run_at: string }>("SELECT next_run_at FROM routines WHERE id = ?", r.id)!;
    expect(row.next_run_at).toBe("2026-11-02T04:00:00.000Z");
    expect(deps.db.get<{ n: number }>("SELECT COUNT(*) n FROM routine_runs WHERE routine_id = ?", r.id)!.n).toBe(2);
  });

  it("creates a normal task, tracks its outcome, and pause skips occurrences", async () => {
    const { deps } = await makeApp();
    const r = createRoutine(deps, { name: "Haftalik raqobatchilar tahlili", agentId: "marketing-dildora", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9", requiresApproval: true }, SYSTEM, new Date("2026-10-29T00:00:00Z"));
    const run = runOccurrence(deps, r.id, new Date("2026-11-02T04:00:00Z"))!;
    const t = getTask(deps, run.taskId!);
    expect(t).toMatchObject({ title: "Haftalik raqobatchilar tahlili", agentId: "marketing-dildora", requiresApproval: true, status: "QUEUED" });
    transitionTask(deps, t.id, "IN_PROGRESS", SYSTEM);
    transitionTask(deps, t.id, "FAILED", SYSTEM, { error: "x" });
    syncRunStatus(deps, t.id, "FAILED");
    expect(deps.db.get<{ status: string }>("SELECT status FROM routine_runs WHERE id = ?", run.id)!.status).toBe("failed");

    setRoutineStatus(deps, r.id, "PAUSED", SYSTEM);
    expect(schedulerTick(deps, new Date("2027-01-01T00:00:00Z")).routines).toBe(0);
  });

  it("releases scheduled one-off tasks at their time", async () => {
    const { deps } = await makeApp();
    const when = new Date(Date.now() + 3600_000).toISOString();
    const t = createTask(deps, { title: "Ertaga taklif yuborish", agentId: "sales-rustam", scheduledFor: when }, SYSTEM);
    expect(t).toMatchObject({ status: "BACKLOG", stage: "Rejalashtirilgan", scheduledFor: when });
    expect(schedulerTick(deps).tasks).toBe(0);
    expect(schedulerTick(deps, new Date(Date.now() + 3601_000)).tasks).toBe(1);
    expect(getTask(deps, t.id).status).toBe("QUEUED");
  });

  it("calendar shows tasks, past runs and planned occurrences, with filters", async () => {
    const { deps } = await makeApp();
    const now = new Date();
    createRoutine(deps, { name: "Kunlik", departmentId: "marketing", rrule: "FREQ=DAILY;BYHOUR=9" }, SYSTEM, now);
    createTask(deps, { title: "Bir martalik", agentId: "finance-nilufar", scheduledFor: new Date(now.getTime() + 2 * 86_400_000).toISOString() }, SYSTEM);
    const items = calendar(deps, now, new Date(now.getTime() + 7 * 86_400_000));
    expect(items.filter((i) => i.kind === "routine").length).toBeGreaterThanOrEqual(6);
    expect(items.some((i) => i.kind === "task" && i.title === "Bir martalik")).toBe(true);
    expect(calendar(deps, now, new Date(now.getTime() + 7 * 86_400_000), { departmentId: "finance" }).every((i) => i.departmentId === "finance")).toBe(true);
  });

  it("API: create, run now (no double run), pause/resume, delete; validation", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/routines", { name: "x", rrule: "FREQ=HOURLY" })).status).toBe(400);
    const r = (await api.post("/api/routines", { name: "Oylik moliya xulosasi", departmentId: "finance", rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10" })).body.routine;
    expect(r).toMatchObject({ schedule: "Har oy 1-sanada 10:00", timezone: "Asia/Tashkent", status: "ACTIVE" });
    const first = (await api.post(`/api/routines/${r.id}/run`)).body.run;
    expect(first.taskId).toBeTruthy();
    expect((await api.post(`/api/routines/${r.id}/run`)).status).toBe(409); // previous run still open
    expect((await api.post(`/api/tasks/${first.taskId}/cancel`)).status).toBe(200);
    expect((await api.post(`/api/routines/${r.id}/run`)).status).toBe(200); // closed: may run again
    expect((await api.post(`/api/routines/${r.id}/pause`)).body.routine.status).toBe("PAUSED");
    expect((await api.post(`/api/routines/${r.id}/resume`)).body.routine.status).toBe("ACTIVE");
    const from = new Date().toISOString(), to = new Date(Date.now() + 40 * 86_400_000).toISOString();
    expect((await api.get(`/api/calendar?from=${from}&to=${to}`)).body.items.length).toBeGreaterThan(0);
    expect((await api.get(`/api/calendar?from=${from}&to=${new Date(Date.now() + 90 * 86_400_000).toISOString()}`)).status).toBe(400);
    expect((await api.delete(`/api/routines/${r.id}`)).status).toBe(200);
  });
});
