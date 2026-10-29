// In-app notifications. The task tables stay the source of truth; this is a persistent, idempotent delivery log:
// every notification has a dedupe key, so retries, sweeps and concurrent writers never create duplicates.
import type { NotificationDto } from "@sag/shared";
import { now } from "../db/db.js";
import { uid } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { computeWorkload, levelRank } from "./workload.js";

export interface NotifyInput {
  userId: string;
  kind: string;
  taskId?: string | null;
  title: string;
  body?: string;
  dedupeKey: string;
}

/** Returns true when a new notification was stored. Inactive users are skipped. */
export function notify(ctx: Ctx, n: NotifyInput): boolean {
  const active = ctx.db.get("SELECT 1 FROM users WHERE id = ? AND status = 'active'", n.userId);
  if (!active) return false;
  const r = ctx.db.run(
    "INSERT OR IGNORE INTO notifications (id, user_id, kind, task_id, title, body, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?)",
    uid("ntf"), n.userId, n.kind, n.taskId ?? null, n.title.slice(0, 200), (n.body ?? "").slice(0, 1000), n.dedupeKey, now(),
  );
  if (r.changes === 1) ctx.bus.emit("notification.created", {}, { audience: [n.userId], kind: n.kind });
  return r.changes === 1;
}

export function listNotifications(ctx: Ctx, userId: string, unreadOnly = false, limit = 50): { items: NotificationDto[]; unread: number } {
  const items = ctx.db.all<NotificationDto>(
    `SELECT id, kind, task_id taskId, title, body, read_at readAt, created_at createdAt FROM notifications
     WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`,
    userId, limit,
  );
  const unread = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL", userId)!.n;
  return { items, unread };
}

/** Marks the caller's own notifications read (ids of other users are ignored by the WHERE clause). */
export function markRead(ctx: Ctx, userId: string, ids: string[] | "all") {
  if (ids === "all") ctx.db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now(), userId);
  else for (const id of ids) ctx.db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL", now(), id, userId);
}

/**
 * Re-evaluates a person's workload after their tasks changed. Rising to ORANGE/RED notifies them and their manager
 * once per level per day. Never restricts anyone.
 */
export function checkWorkload(ctx: Ctx, userId: string | null | undefined) {
  if (!userId) return;
  const u = ctx.db.get<{ workload_level: string | null; manager_id: string | null; display_name: string }>(
    "SELECT workload_level, manager_id, display_name FROM users WHERE id = ?", userId,
  );
  if (!u) return;
  const w = computeWorkload(ctx, userId);
  if (w.level !== u.workload_level) ctx.db.run("UPDATE users SET workload_level = ? WHERE id = ?", w.level, userId);
  const rising = levelRank(w.level) > levelRank(u.workload_level as never);
  if (!rising || (w.level !== "ORANGE" && w.level !== "RED")) return;
  const day = new Date().toISOString().slice(0, 10);
  notify(ctx, { userId, kind: "workload", title: w.level === "RED" ? "Yuklama: OVERLOADED" : "Yuklama yuqori", body: w.summary, dedupeKey: `workload:${userId}:${w.level}:${day}` });
  if (u.manager_id)
    notify(ctx, {
      userId: u.manager_id, kind: "workload", title: `${u.display_name}: ${w.level === "RED" ? "OVERLOADED" : "yuklama yuqori"}`,
      body: w.summary, dedupeKey: `workload-mgr:${userId}:${w.level}:${day}`,
    });
}

/**
 * Deadline sweep (run by the scheduler): "due within 24 h" and "overdue" notices for open human tasks, once per
 * task and deadline (a changed deadline is a new key).
 */
export function deadlineSweep(ctx: Ctx, at = Date.now()) {
  const soon = new Date(at + 24 * 3_600_000).toISOString();
  const rows = ctx.db.all<{ id: string; title: string; deadline: string; assignee_user_id: string; assigned_by: string | null }>(
    `SELECT id, title, deadline, assignee_user_id, assigned_by FROM tasks
     WHERE kind = 'human' AND assignee_user_id IS NOT NULL AND deadline IS NOT NULL AND deadline <= ?
       AND status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','CHANGES_REQUESTED','BLOCKED')`,
    soon,
  );
  const nowIso = new Date(at).toISOString();
  for (const t of rows) {
    if (t.deadline < nowIso) {
      notify(ctx, { userId: t.assignee_user_id, kind: "overdue", taskId: t.id, title: `Muddati o'tdi: ${t.title}`, dedupeKey: `overdue:${t.id}:${t.deadline}` });
      if (t.assigned_by && t.assigned_by !== t.assignee_user_id)
        notify(ctx, { userId: t.assigned_by, kind: "overdue", taskId: t.id, title: `Muddati o'tdi: ${t.title}`, dedupeKey: `overdue-mgr:${t.id}:${t.deadline}` });
      checkWorkload(ctx, t.assignee_user_id);
    } else notify(ctx, { userId: t.assignee_user_id, kind: "deadline", taskId: t.id, title: `Muddat yaqin: ${t.title}`, dedupeKey: `deadline:${t.id}:${t.deadline}` });
  }
}
