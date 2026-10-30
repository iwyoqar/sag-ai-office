// npm run import:stores -- <workbook.xlsx> [--apply]
// Without --apply nothing is written (dry run, needs an already migrated database). With --apply the database is
// first copied (VACUUM INTO data/backups/), then migrated and imported in one transaction. It is never reset.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { Db } from "../db/db.js";
import { EventBus } from "../lib/events.js";
import { importStores } from "./stores.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!file) {
  console.error("Usage: npm run import:stores -- <workbook.xlsx> [--apply]");
  process.exit(2);
}

const db = new Db(config.databasePath);
try {
  const migrated = !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_nodes'");
  if (apply) {
    if (config.databasePath !== ":memory:") {
      const dir = join(dirname(config.databasePath), "backups");
      mkdirSync(dir, { recursive: true });
      const backup = join(dir, `before-store-import-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      db.raw.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      console.log(`backup: ${backup}`);
    }
    const applied = db.migrate();
    if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
  } else if (!migrated) {
    console.error("The database has no organisation tree yet (migration 010). Run with --apply (backs up first) or npm run migrate.");
    process.exit(1);
  }
  const s = importStores({ db, bus: new EventBus(db) }, readFileSync(file), file, apply);
  console.log(apply ? "IMPORT APPLIED" : "DRY RUN (nothing written; add --apply to import)");
  console.log(`source: ${s.sourceFile}  sha256: ${s.sha256}${s.batchId ? `  batch: ${s.batchId}` : ""}`);
  console.log(`workbook: ${s.totals.stores} stores (${s.totals.hd} HD = SAG-owned, ${s.totals.f} F = franchise) in ${s.totals.regions} regions`);
  for (const r of s.byRegion) console.log(`  ${r.region.padEnd(18)} ${String(r.stores).padStart(2)} stores  HD ${r.hd}  F ${r.f}`);
  console.log(`regions created: ${s.regionsCreated.length ? s.regionsCreated.join(", ") : "none"}`);
  console.log(`units created: ${s.unitsCreated}  unchanged: ${s.unitsUnchanged}`);
  console.log(`human directors provisioned (PENDING_ACTIVATION): ${s.directorsCreated}  AI Directors provisioned: ${s.aiDirectorsCreated}`);
} finally {
  db.close();
}
