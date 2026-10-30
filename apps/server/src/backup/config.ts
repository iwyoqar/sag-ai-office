// Backup configuration from the environment. Nothing is uploaded until the owner configures storage and a key;
// with a partial configuration the server refuses to start the job and says which variable is missing.
import { parseKey } from "../connectors/secrets.js";
import { type BackupKey, DEFAULT_RETENTION, type Retention } from "./backup.js";
import { LocalDirStore, type ObjectStore, S3Store } from "./store.js";

export interface BackupSettings {
  store: ObjectStore;
  key: BackupKey;
  keys: BackupKey[];
  prefix: string;
  everyMs: number;
  retention: Retention;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

/** null + reason when backups are off; throws on a configuration that is half done (fail loudly, not silently). */
export function backupSettingsFrom(env: Record<string, string | undefined>): { settings: BackupSettings | null; reason?: string } {
  const target = (env.BACKUP_TARGET ?? "").trim().toLowerCase();
  if (!target) return { settings: null, reason: "BACKUP_TARGET is not set (s3 | dir)" };
  const key = parseKey(env.BACKUP_KEY);
  if (!key) throw new Error("BACKUP_KEY must be 32 random bytes in base64 (e.g. `openssl rand -base64 32`)");
  const id = env.BACKUP_KEY_ID?.trim() || "k1";
  const keys: BackupKey[] = [{ id, key }];
  // previous keys stay usable for restoring older backups after a rotation: BACKUP_OLD_KEYS="k0:<base64>,…"
  for (const part of (env.BACKUP_OLD_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [oid, b64] = part.split(":");
    const k = parseKey(b64);
    if (!oid || !k) throw new Error("BACKUP_OLD_KEYS entries must look like <id>:<base64 32 bytes>");
    keys.push({ id: oid, key: k });
  }
  let store: ObjectStore;
  if (target === "s3") {
    const need = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"];
    const missing = need.filter((n) => !env[n]?.trim());
    if (missing.length) throw new Error(`backup target s3: missing ${missing.join(", ")}`);
    if (!/^https:\/\//.test(env.BACKUP_S3_ENDPOINT!)) throw new Error("BACKUP_S3_ENDPOINT must be an https:// URL");
    store = new S3Store({
      endpoint: env.BACKUP_S3_ENDPOINT!.trim(), region: env.BACKUP_S3_REGION!.trim(), bucket: env.BACKUP_S3_BUCKET!.trim(),
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!.trim(), secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!.trim(),
    });
  } else if (target === "dir") {
    if (!env.BACKUP_DIR?.trim()) throw new Error("backup target dir: missing BACKUP_DIR (use a different disk or a mounted volume — not off-site)");
    store = new LocalDirStore(env.BACKUP_DIR.trim());
  } else throw new Error(`BACKUP_TARGET must be "s3" or "dir", got "${target}"`);
  const prefix = (env.BACKUP_PREFIX ?? "sag-ai-office/").replace(/^\/+/, "");
  return {
    settings: {
      store, key: keys[0], keys, prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
      everyMs: Math.max(5, int(env.BACKUP_INTERVAL_MINUTES, 60)) * 60_000,
      retention: {
        hourly: int(env.BACKUP_RETAIN_HOURLY, DEFAULT_RETENTION.hourly),
        daily: int(env.BACKUP_RETAIN_DAILY, DEFAULT_RETENTION.daily),
        monthly: int(env.BACKUP_RETAIN_MONTHLY, DEFAULT_RETENTION.monthly),
      },
    },
  };
}
