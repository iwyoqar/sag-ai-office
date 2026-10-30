import { config } from "./config.js";
import { Db } from "./db/db.js";
import { seed } from "./db/seed.js";
import { buildApp } from "./app.js";
import { recoverExpiredLeases } from "./domain/tasks.js";
import { createLlm } from "./llm/index.js";
import { AgentRunner } from "./agents/runner.js";
import { TelegramBot } from "./telegram/bot.js";
import { Scheduler } from "./schedule/service.js";
import { BackupJob, snapshotTo } from "./backup/backup.js";
import { backupSettingsFrom } from "./backup/config.js";
import { loggerOptions, secretValues } from "./lib/redact.js";
import { writeInitialAdminPassword } from "./db/seed.js";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const db = new Db(config.databasePath);
// Before changing the schema of a database that holds data, keep a consistent local copy (the rollback path for a
// failed or wrong migration is: stop, restore this file). The newest five are kept.
const { pending, existing } = db.pendingMigrations();
let preMigration: string | null = null;
if (pending.length && existing && config.databasePath !== ":memory:") {
  const dir = join(dirname(config.databasePath), "backups");
  mkdirSync(dir, { recursive: true });
  preMigration = join(dir, `pre-migrate-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.db`);
  if (!existsSync(preMigration)) snapshotTo(db, preMigration);
  for (const old of readdirSync(dir).filter((f) => f.startsWith("pre-migrate-")).sort().slice(0, -5)) rmSync(join(dir, old), { force: true });
}
const applied = db.migrate();
const seeded = await seed(db, { adminPassword: config.adminPassword });

const llmLog = (msg: string, meta?: Record<string, unknown>) => app.log.warn(meta ?? {}, msg);
const llm = createLlm(config, (m, meta) => llmLog(m, meta));

const { app, deps } = await buildApp({
  db,
  llm,
  connectors: config.connectors,
  sessionTtlHours: config.sessionTtlHours,
  cookieSecure: config.cookieSecure,
  trustProxy: config.trustProxy,
  allowedOrigins: config.allowedOrigins,
  logger: loggerOptions(config.logLevel, secretValues(config)),
});

if (applied.length) app.log.info({ applied, backup: preMigration }, "migrations applied");
// a write transaction holding the single SQLite write lock this long delays every other writer
db.onSlowTx = (ms) => app.log.warn({ ms }, "slow write transaction");
if (seeded.admin) {
  // Never in the log (hosts keep logs): a generated password goes to a local file only the operator reads.
  if (seeded.admin.generated) {
    const file = writeInitialAdminPassword(config.databasePath, seeded.admin.password);
    app.log.warn({ file }, "Initial admin created with a generated password — read it from this file, sign in, change it, delete the file");
  } else app.log.warn("Initial admin created with ADMIN_PASSWORD from the environment");
}

// Work left IN_PROGRESS by a crash goes back to the queue once its lease expires (the runner also recovers tasks
// of dead workers at once on start). Approved external actions cut off mid-call are marked "unknown" for a person.
const recovered = recoverExpiredLeases(deps);
if (recovered.length) app.log.warn({ recovered }, "re-queued tasks with expired leases");
const interrupted = deps.connectors.markInterrupted();
if (interrupted) app.log.warn({ interrupted }, "approved agent actions were interrupted — outcome unknown, check them in The Brain");
const leaseTimer = setInterval(() => recoverExpiredLeases(deps), 30_000);

// ---- agent runtime
let healthTimer: NodeJS.Timeout | null = null;
if (llm.client) {
  const client = llm.client;
  const check = async () => {
    const h = await client.health();
    deps.llmHealth = { ...h, checkedAt: new Date().toISOString() };
    if (!h.ok) app.log.error({ model: h.model, detail: h.detail }, "LLM health check failed");
    else app.log.info({ provider: client.provider, model: h.model, mode: client.mode }, "LLM ready");
  };
  await check();
  healthTimer = setInterval(() => void check(), 10 * 60_000);
  if (config.worker.enabled) {
    const runner = new AgentRunner(deps, client, llm.pricing, {
      concurrency: config.worker.concurrency,
      pollMs: config.worker.pollMs,
      taskTimeoutMs: config.worker.taskTimeoutMs,
      tools: deps.connectors,
      log: (msg, meta) => app.log.warn(meta ?? {}, msg),
    });
    deps.runner = runner;
    runner.start();
    app.log.info({ worker: runner.workerId, concurrency: config.worker.concurrency }, "agent runner started");
  }
} else {
  app.log.warn({ reason: llm.reason }, "LLM not configured — tasks stay queued until an API key is set");
}

// ---- off-site backups (encrypted; verified by restoring every upload). Off until BACKUP_* is configured.
let backupJob: BackupJob | null = null;
try {
  const { settings, reason } = backupSettingsFrom(process.env);
  if (settings) {
    backupJob = new BackupJob({ db, ...settings, log: (msg, meta) => app.log.info(meta ?? {}, msg) }, settings.everyMs);
    backupJob.start();
    app.log.info({ store: settings.store.describe, everyMinutes: settings.everyMs / 60_000 }, "backups scheduled");
  } else app.log.warn({ reason }, "off-site backups are NOT configured — see docs/DEPLOY.md");
} catch (e) {
  app.log.error({ err: (e as Error).message }, "backup configuration invalid — backups are NOT running");
}

// ---- routines & scheduled tasks (server-side; survives browser closing and restarts)
const scheduler = new Scheduler(deps, 20_000, (msg, meta) => app.log.info(meta ?? {}, msg));
scheduler.start();

// ---- Telegram (long polling or webhook; one consumer per bot token)
if (config.telegram.token && config.telegram.groupId && config.telegram.enabled) {
  const bot = new TelegramBot(deps, {
    token: config.telegram.token,
    groupId: config.telegram.groupId,
    adminUserIds: config.telegram.adminUserIds,
    mode: config.telegram.mode,
    webhookUrl: config.telegram.webhookUrl,
    webhookSecret: config.telegram.webhookSecret,
    log: (msg, meta) => app.log.warn(meta ?? {}, msg),
  });
  deps.telegram = bot;
  await bot.start();
  if (bot.status.lastError) app.log.error({ error: bot.status.lastError }, "Telegram check failed (bot keeps polling)");
  else app.log.info({ bot: bot.status.bot?.username, group: bot.status.group?.title, mode: bot.status.mode }, "Telegram bot connected");
} else {
  app.log.warn("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_ID)");
}

// ---- connectors: mirror the real credential state into The Brain
deps.connectors.sync();

// Graceful, bounded and idempotent: stop taking work, give leased tasks back to the queue, close HTTP (ends SSE
// streams), close the database. A second signal or a hang past the limit exits hard.
const SHUTDOWN_LIMIT_MS = 20_000;
let stopping = false;
const shutdown = async (why: string, code = 0) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ why }, "shutting down");
  setTimeout(() => {
    app.log.error("shutdown took too long — exiting");
    process.exit(code || 1);
  }, SHUTDOWN_LIMIT_MS).unref();
  try {
    clearInterval(leaseTimer);
    if (healthTimer) clearInterval(healthTimer);
    scheduler.stop();
    await backupJob?.stop();
    await deps.runner?.stop();
    await deps.telegram?.stop();
    await app.close();
  } catch (e) {
    app.log.error({ err: e }, "error during shutdown");
  } finally {
    db.close();
    process.exit(code);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// A fatal error leaves state unknown: log it, release leases, exit non-zero and let the platform restart us.
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  app.log.fatal({ err }, "unhandled rejection");
  void shutdown("unhandledRejection", 1);
});

await app.listen({ port: config.port, host: config.host });
