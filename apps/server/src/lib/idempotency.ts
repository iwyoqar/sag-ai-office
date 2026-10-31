import type { FastifyRequest } from "fastify";
import type { Db } from "../db/db.js";
import { badRequest } from "./errors.js";

/** The client's `Idempotency-Key` header (8–200 characters), if any. */
export function idempotencyKey(req: FastifyRequest): string | undefined {
  const h = req.headers["idempotency-key"];
  const k = Array.isArray(h) ? h[0] : h;
  if (k === undefined || k === "") return undefined;
  if (k.length < 8 || k.length > 200) throw badRequest("Idempotency-Key 8–200 belgi bo'lishi kerak");
  return k;
}

/**
 * Create a task at most once per creator and key: a retried or double-submitted request gets the task created the
 * first time (`replayed`). The unique index ux_tasks_idempotency settles a race between two identical requests.
 */
export function createOnce<T>(db: Db, userId: string, key: string | undefined, create: () => T, existing: (id: string) => T): { value: T; replayed: boolean } {
  const find = () => (key ? db.get<{ id: string }>("SELECT id FROM tasks WHERE created_by = ? AND idempotency_key = ?", userId, key) : undefined);
  const before = find();
  if (before) return { value: existing(before.id), replayed: true };
  try {
    return { value: create(), replayed: false };
  } catch (e) {
    const again = /ux_tasks_idempotency|UNIQUE constraint failed: tasks\.created_by/.test((e as Error).message) ? find() : undefined;
    if (again) return { value: existing(again.id), replayed: true };
    throw e;
  }
}
