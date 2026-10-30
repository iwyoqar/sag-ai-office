// Backup operations from the command line (same configuration as the server: .env / host environment).
//   npm run backup -- now                       snapshot → encrypt → upload → verify → prune
//   npm run backup -- list                      objects in the configured store
//   npm run backup -- verify <object-key>       download and prove the backup restores
//   npm run backup -- restore <object-key> <target-file>
//                                               write the restored database to a NEW file (never overwrites);
//                                               then stop the service and move it into place (DEPLOY.md runbook)
import { config } from "../config.js";
import { Db } from "../db/db.js";
import { restoreBackup, runBackup, verifyBackup } from "./backup.js";
import { backupSettingsFrom } from "./config.js";

const [cmd, a1, a2] = process.argv.slice(2);
const { settings, reason } = backupSettingsFrom(process.env);
if (!settings) {
  console.error(`Backups are not configured: ${reason}. See docs/DEPLOY.md → Backups.`);
  process.exit(2);
}
const log = (msg: string, meta?: Record<string, unknown>) => console.log(msg, meta ?? "");

if (cmd === "list") {
  for (const o of await settings.store.list(settings.prefix)) console.log(`${o.modified}  ${String(o.size).padStart(10)}  ${o.key}`);
} else if (cmd === "restore") {
  if (!a1 || !a2) throw new Error("usage: restore <object-key> <target-file>");
  const m = await restoreBackup(settings, a1, a2);
  console.log(`Restored ${a1} (created ${m.createdAt}, schema ${m.schema.at(-1)}) to ${a2}; integrity and row counts verified.`);
} else {
  const db = new Db(config.databasePath);
  try {
    if (cmd === "now") {
      const r = await runBackup({ db, ...settings, log });
      console.log(`Backup ${r.key}: ${r.bytes} bytes, verified by restore, ${r.pruned} old backup(s) pruned.`);
    } else if (cmd === "verify") {
      if (!a1) throw new Error("usage: verify <object-key>");
      const m = await verifyBackup({ db, ...settings }, a1);
      console.log(`Verified ${a1}: created ${m.createdAt}, counts ${JSON.stringify(m.counts)}`);
    } else {
      console.error("usage: backup now | list | verify <key> | restore <key> <target>");
      process.exit(2);
    }
  } finally {
    db.close();
  }
}
