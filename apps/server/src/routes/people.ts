// People & human work API. Every handler authorises in the domain layer (domain/access.ts); hiding buttons in the
// UI is only a convenience.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROLES, TASK_PRIORITIES } from "@sag/shared";
import { type Deps, parse, requireUser } from "../app.js";
import { has } from "../domain/access.js";
import { setSetting } from "../domain/brain.js";
import {
  createEmployee, directory, getAvatar, grantPermission, orgChart, presence, profile, revokePermission, setAvatar,
  setDepartmentHead, setEmployeeRoles, setEmployeeStatus, updateEmployee,
} from "../domain/employees.js";
import { listNotifications, markRead } from "../domain/notifications.js";
import {
  acceptWork, addAttachment, addComment, assignWork, blockWork, cancelWork, createWork, declineWork, getAttachment, listWork,
  reportWork, reviewWork, startWork, submitWork, updateWork, workDetail,
} from "../domain/work.js";
import { DEFAULT_POLICY, workloadPolicy } from "../domain/workload.js";
import { badRequest, forbidden } from "../lib/errors.js";

const Id = z.object({ id: z.string().min(1).max(80) });
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Sana noto'g'ri");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

const EmployeeBody = z.object({
  username: z.string().trim().min(3).max(32),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
  email: z.string().trim().max(120).nullish(),
  jobTitle: z.string().trim().max(80).optional(),
  departmentId: z.string().nullish(),
  floorId: z.string().nullish(),
  managerId: z.string().nullish(),
  roles: z.array(z.enum(ROLES)).max(5).optional(),
  startDate: isoDate.nullish(),
  capacityHoursWeek: z.number().min(0).max(80).optional(),
  workStart: hhmm.optional(),
  workEnd: hhmm.optional(),
  timezone: z.string().max(60).optional(),
});

const EmployeePatch = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().max(120).nullish(),
  jobTitle: z.string().trim().max(80).optional(),
  departmentId: z.string().nullish(),
  floorId: z.string().nullish(),
  managerId: z.string().nullish(),
  startDate: isoDate.nullish(),
  capacityHoursWeek: z.number().min(0).max(80).optional(),
  workStart: hhmm.optional(),
  workEnd: hhmm.optional(),
  timezone: z.string().max(60).optional(),
  telegramUserId: z.number().int().positive().nullish(),
}).strict();

const WorkBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  assigneeId: z.string().nullish(),
  departmentId: z.string().nullish(),
  parentId: z.string().nullish(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  deadline: isoDate.nullish(),
  estimateHours: z.number().min(0).max(1000).nullish(),
  isOptional: z.boolean().optional(),
  weight: z.number().positive().max(100).optional(),
  requiresReview: z.boolean().optional(),
  reviewerId: z.string().nullish(),
  dependsOn: z.array(z.string()).max(50).optional(),
});

const WorkPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  deadline: isoDate.nullish(),
  estimateHours: z.number().min(0).max(1000).nullish(),
  isOptional: z.boolean().optional(),
  weight: z.number().positive().max(100).optional(),
  requiresReview: z.boolean().optional(),
  reviewerId: z.string().nullish(),
}).strict();

const Policy = z.object({
  yellow: z.number().min(1).max(500), orange: z.number().min(1).max(500), red: z.number().min(1).max(1000),
  horizonDays: z.number().int().min(1).max(30),
  defaultHours: z.object({ LOW: z.number().min(0).max(80), MEDIUM: z.number().min(0).max(80), HIGH: z.number().min(0).max(80), URGENT: z.number().min(0).max(80) }),
  noDeadlineFactor: z.number().min(0).max(1), blockedFactor: z.number().min(0).max(1),
  dueSoonHours: z.number().int().min(1).max(168), dueSoonOrange: z.number().int().min(1).max(50), overdueRed: z.number().int().min(1).max(50),
}).strict().refine((p) => p.yellow < p.orange && p.orange < p.red, "Chegaralar o'sib borishi kerak: sariq < to'q sariq < qizil");

export const peopleRoutes = (d: Deps) => async (app: FastifyInstance) => {
  // ---------------------------------------------------------------- employees
  app.get("/api/employees", async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({
      q: z.string().max(80).optional(), departmentId: z.string().optional(),
      status: z.enum(["active", "inactive", "archived", "all"]).optional(), role: z.enum(ROLES).optional(),
      sort: z.enum(["name", "department", "workload", "recent"]).optional(),
    }), req.query);
    return { employees: directory(d, u, q) };
  });

  app.get("/api/employees/presence", async (req) => {
    requireUser(req);
    return { presence: presence(d) };
  });

  app.get("/api/org-chart", async (req) => orgChart(d, requireUser(req)));

  app.get("/api/employees/:id", async (req) => profile(d, requireUser(req), parse(Id, req.params).id));

  app.post("/api/employees", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(EmployeeBody, req.body);
    reply.status(201);
    return { employee: await createEmployee(d, u, body) };
  });

  app.patch("/api/employees/:id", async (req) => {
    const u = requireUser(req);
    return { employee: updateEmployee(d, u, parse(Id, req.params).id, parse(EmployeePatch, req.body)) };
  });

  app.post("/api/employees/:id/status", async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ status: z.enum(["active", "inactive", "archived"]) }), req.body);
    return { employee: setEmployeeStatus(d, u, parse(Id, req.params).id, body.status) };
  });

  app.put("/api/employees/:id/roles", async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ roles: z.array(z.string()).min(1).max(5) }), req.body);
    return { employee: setEmployeeRoles(d, u, parse(Id, req.params).id, body.roles) };
  });

  app.post("/api/employees/:id/grants", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ permission: z.string().max(60), departmentId: z.string().nullish(), canDelegate: z.boolean().optional() }), req.body);
    reply.status(201);
    return { id: grantPermission(d, u, parse(Id, req.params).id, body) };
  });

  app.delete("/api/employees/:id/grants/:grantId", async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().max(80), grantId: z.string().max(80) }), req.params);
    revokePermission(d, u, p.id, p.grantId);
    return { ok: true };
  });

  app.put("/api/employees/:id/avatar", { bodyLimit: 1_500_000 }, async (req) => {
    const u = requireUser(req);
    const file = await req.file({ limits: { fileSize: 1024 * 1024 } });
    if (!file) throw badRequest("Rasm tanlanmagan");
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest("Rasm 1 MB dan katta");
    setAvatar(d, u, parse(Id, req.params).id, data);
    return { ok: true };
  });

  app.get("/api/employees/:id/avatar", async (req, reply) => {
    requireUser(req);
    const a = getAvatar(d, parse(Id, req.params).id);
    if (!a) return reply.status(404).send();
    reply.header("content-type", a.mime).header("cache-control", "private, max-age=300").header("x-content-type-options", "nosniff");
    return reply.send(Buffer.from(a.data));
  });

  app.put("/api/departments/:id/head", async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ userId: z.string().nullable() }), req.body);
    setDepartmentHead(d, u, parse(Id, req.params).id, body.userId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- workload policy
  app.get("/api/settings/workload", async (req) => {
    requireUser(req);
    return { policy: workloadPolicy(d), defaults: DEFAULT_POLICY };
  });
  app.put("/api/settings/workload", async (req) => {
    const u = requireUser(req);
    if (!has(u, "workload:configure")) throw forbidden();
    const body = parse(Policy, req.body);
    setSetting(d, "workload", body, { type: "user", id: u.id });
    return { policy: workloadPolicy(d) };
  });

  // ---------------------------------------------------------------- work (human tasks)
  app.get("/api/work", async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({
      view: z.enum(["my", "team", "department", "company", "review", "overdue", "blocked"]).default("my"),
      departmentId: z.string().optional(), includeDone: z.enum(["true", "false"]).optional(), q: z.string().max(80).optional(),
      assigneeId: z.string().optional(),
    }), req.query);
    return { tasks: listWork(d, u, q.view, { departmentId: q.departmentId, includeDone: q.includeDone === "true", q: q.q, assigneeId: q.assigneeId }) };
  });

  app.post("/api/work", async (req, reply) => {
    const u = requireUser(req);
    reply.status(201);
    return { task: createWork(d, u, parse(WorkBody, req.body)) };
  });

  app.get("/api/work/:id", async (req) => workDetail(d, requireUser(req), parse(Id, req.params).id));

  app.patch("/api/work/:id", async (req) => ({ task: updateWork(d, requireUser(req), parse(Id, req.params).id, parse(WorkPatch, req.body)) }));

  const reason = z.object({ reason: z.string().max(2000).default("") });
  app.post("/api/work/:id/assign", async (req) =>
    ({ task: assignWork(d, requireUser(req), parse(Id, req.params).id, parse(z.object({ assigneeId: z.string().min(1) }), req.body).assigneeId) }));
  app.post("/api/work/:id/accept", async (req) => ({ task: acceptWork(d, requireUser(req), parse(Id, req.params).id) }));
  app.post("/api/work/:id/decline", async (req) =>
    ({ task: declineWork(d, requireUser(req), parse(Id, req.params).id, parse(z.object({ reason: z.string().trim().min(1, "Sabab kerak").max(2000) }), req.body).reason) }));
  app.post("/api/work/:id/start", async (req) => ({ task: startWork(d, requireUser(req), parse(Id, req.params).id) }));
  app.post("/api/work/:id/progress", async (req) => {
    const b = parse(z.object({ progress: z.number().int().min(0).max(100).optional(), actualHours: z.number().min(0).max(10000).optional(), note: z.string().max(5000).optional() }), req.body);
    return { task: reportWork(d, requireUser(req), parse(Id, req.params).id, b) };
  });
  app.post("/api/work/:id/submit", async (req) =>
    ({ task: submitWork(d, requireUser(req), parse(Id, req.params).id, parse(z.object({ result: z.string().max(50_000).default("") }), req.body ?? {}).result) }));
  app.post("/api/work/:id/approve", async (req) =>
    ({ task: reviewWork(d, requireUser(req), parse(Id, req.params).id, "APPROVED", parse(z.object({ comment: z.string().max(5000).default("") }), req.body ?? {}).comment) }));
  app.post("/api/work/:id/request-changes", async (req) =>
    ({ task: reviewWork(d, requireUser(req), parse(Id, req.params).id, "CHANGES_REQUESTED", parse(z.object({ comment: z.string().trim().min(1, "Izoh kerak").max(5000) }), req.body).comment) }));
  app.post("/api/work/:id/block", async (req) => ({ task: blockWork(d, requireUser(req), parse(Id, req.params).id, parse(reason, req.body ?? {}).reason) }));
  app.post("/api/work/:id/unblock", async (req) => ({ task: blockWork(d, requireUser(req), parse(Id, req.params).id, parse(reason, req.body ?? {}).reason, true) }));
  app.post("/api/work/:id/cancel", async (req) => ({ task: cancelWork(d, requireUser(req), parse(Id, req.params).id, parse(reason, req.body ?? {}).reason || undefined) }));
  app.post("/api/work/:id/comments", async (req, reply) => {
    addComment(d, requireUser(req), parse(Id, req.params).id, parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body).body);
    reply.status(201);
    return { ok: true };
  });

  app.post("/api/work/:id/attachments", async (req, reply) => {
    const u = requireUser(req);
    const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) throw badRequest("Fayl tanlanmagan");
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest("Fayl 10 MB dan katta");
    reply.status(201);
    return { attachment: addAttachment(d, u, parse(Id, req.params).id, { filename: file.filename, mime: file.mimetype, data }) };
  });

  app.get("/api/work/:id/attachments/:attId", async (req, reply) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().max(80), attId: z.string().max(80) }), req.params);
    const a = getAttachment(d, u, p.id, p.attId);
    // always a download, never rendered inline from our origin
    reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${encodeURIComponent(a.filename)}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header("x-content-type-options", "nosniff");
    return reply.send(Buffer.from(a.data));
  });

  // ---------------------------------------------------------------- notifications
  app.get("/api/notifications", async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ unread: z.enum(["true", "false"]).optional() }), req.query);
    return listNotifications(d, u.id, q.unread === "true");
  });
  app.post("/api/notifications/read", async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.union([z.array(z.string().max(80)).max(200), z.literal("all")]) }), req.body);
    markRead(d, u.id, b.ids);
    return { ok: true };
  });
};
