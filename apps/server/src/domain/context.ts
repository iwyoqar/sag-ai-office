import type { Db } from "../db/db.js";
import type { EventBus } from "../lib/events.js";

export interface Ctx {
  db: Db;
  bus: EventBus;
}
