import type { OfficeEvent, OfficeEventType } from "@sag/shared";
import type { Db } from "../db/db.js";
import { json, now } from "../db/db.js";

type Listener = (e: OfficeEvent) => void;

interface EventRow {
  id: number; type: OfficeEventType; task_id: string | null; agent_id: string | null;
  department_id: string | null; data: string; created_at: string;
}

function toEvent(r: EventRow): OfficeEvent {
  return {
    id: r.id, type: r.type, at: r.created_at, taskId: r.task_id, agentId: r.agent_id,
    departmentId: r.department_id, data: json(r.data, {}),
  };
}

/**
 * Every event is written to task_events first (activity log, survives restarts),
 * then pushed to live SSE subscribers. Reconnecting clients replay from Last-Event-ID.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  constructor(private db: Db) {}

  emit(
    type: OfficeEventType,
    ref: { taskId?: string | null; agentId?: string | null; departmentId?: string | null },
    data: Record<string, unknown> = {},
    actor: string | null = null,
  ): OfficeEvent {
    const created = now();
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO task_events (type, task_id, agent_id, department_id, actor, data, created_at) VALUES (?,?,?,?,?,?,?)",
      type, ref.taskId ?? null, ref.agentId ?? null, ref.departmentId ?? null, actor, JSON.stringify(data), created,
    );
    const ev: OfficeEvent = {
      id: lastInsertRowid, type, at: created, taskId: ref.taskId ?? null, agentId: ref.agentId ?? null,
      departmentId: ref.departmentId ?? null, data,
    };
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a broken subscriber must not break the emitter */
      }
    }
    return ev;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  since(lastId: number, limit = 500): OfficeEvent[] {
    return this.db
      .all<EventRow>("SELECT * FROM task_events WHERE id > ? ORDER BY id LIMIT ?", lastId, limit)
      .map(toEvent);
  }

  forTask(taskId: string): OfficeEvent[] {
    return this.db.all<EventRow>("SELECT * FROM task_events WHERE task_id = ? ORDER BY id", taskId).map(toEvent);
  }

  get subscriberCount() {
    return this.listeners.size;
  }
}
