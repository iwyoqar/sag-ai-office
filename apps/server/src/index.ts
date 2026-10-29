import { config } from "./config.js";
import { Db } from "./db/db.js";
import { seed } from "./db/seed.js";
import { buildApp } from "./app.js";
import { recoverExpiredLeases } from "./domain/tasks.js";
import { createLlm } from "./llm/index.js";
import { AgentRunner } from "./agents/runner.js";
import { TelegramBot } from "./telegram/bot.js";
import { Scheduler } from "./schedule/service.js";

const db = new Db(config.databasePath);
const applied = db.migrate();
const seeded = await seed(db, { adminPassword: config.adminPassword });

const llmLog = (msg: string, meta?: Record<string, unknown>) => app.log.warn(meta ?? {}, msg);
const llm = createLlm(config, (m, meta) => llmLog(m, meta));

const { app, deps } = await buildApp({
  db,
  llm,
  sessionTtlHours: config.sessionTtlHours,
  cookieSecure: config.cookieSecure,
  trustProxy: config.trustProxy,
  logger: { level: config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization", "req.headers[\"x-goog-api-key\"]"] },
});

if (applied.length) app.log.info({ applied }, "migrations applied");
if (seeded.admin) {
  // Printed once, at first boot only. Change it after logging in.
  app.log.warn(
    seeded.admin.generated
      ? `Initial admin created. Login: admin  Password: ${seeded.admin.password}  (shown only once)`
      : "Initial admin created with ADMIN_PASSWORD from .env",
  );
}

// Work left IN_PROGRESS by a crash goes back to the queue once its lease expires.
const recovered = recoverExpiredLeases(deps);
if (recovered.length) app.log.warn({ recovered }, "re-queued tasks with expired leases");
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
      log: (msg, meta) => app.log.warn(meta ?? {}, msg),
    });
    deps.runner = runner;
    runner.start();
    app.log.info({ worker: runner.workerId, concurrency: config.worker.concurrency }, "agent runner started");
  }
} else {
  app.log.warn({ reason: llm.reason }, "LLM not configured — tasks stay queued until an API key is set");
}

// ---- routines & scheduled tasks (server-side; survives browser closing and restarts)
const scheduler = new Scheduler(deps, 20_000, (msg, meta) => app.log.info(meta ?? {}, msg));
scheduler.start();

// ---- Telegram (long polling; one consumer per bot token)
if (config.telegram.token && config.telegram.groupId && config.telegram.enabled) {
  const bot = new TelegramBot(deps, {
    token: config.telegram.token,
    groupId: config.telegram.groupId,
    adminUserIds: config.telegram.adminUserIds,
    log: (msg, meta) => app.log.warn(meta ?? {}, msg),
  });
  deps.telegram = bot;
  await bot.start();
  if (bot.status.lastError) app.log.error({ error: bot.status.lastError }, "Telegram check failed (bot keeps polling)");
  else app.log.info({ bot: bot.status.bot?.username, group: bot.status.group?.title }, "Telegram bot connected");
} else {
  app.log.warn("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_ID)");
}

const shutdown = async () => {
  clearInterval(leaseTimer);
  if (healthTimer) clearInterval(healthTimer);
  scheduler.stop();
  await deps.runner?.stop();
  await deps.telegram?.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
