import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedProxiesFrom } from "./lib/throttle.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Load the repo-root .env if present (Node ≥ 21). Real secrets live only there / in the host env.
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 4000),
  host: process.env.HOST ?? "127.0.0.1",
  databasePath: resolve(root, process.env.DATABASE_PATH ?? "data/sag.db"),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 7),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  /** proxies allowed to set X-Forwarded-For: false, a hop count, or IPs/CIDRs (TRUSTED_PROXIES) — never "all" */
  trustProxy: trustedProxiesFrom(process.env),
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  logLevel: process.env.LOG_LEVEL ?? "info",
  llm: {
    /** gemini | mock (mock = test double, clearly labelled) */
    provider: (process.env.LLM_PROVIDER ?? "gemini").toLowerCase(),
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    /** "" disables semantic search (full-text search keeps working) */
    embeddingModel: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    /** spacing between requests; free tier allows roughly 10 requests per minute */
    minIntervalMs: int(process.env.LLM_MIN_INTERVAL_MS, 6500),
    /** USD per 1M tokens for the cost estimate; 0 on the free tier */
    priceInputPerM: Number(process.env.LLM_PRICE_INPUT_PER_M ?? 0),
    priceOutputPerM: Number(process.env.LLM_PRICE_OUTPUT_PER_M ?? 0),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || undefined,
    groupId: process.env.TELEGRAM_GROUP_ID || undefined,
    adminUserIds: (process.env.TELEGRAM_ADMIN_USER_IDS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
    enabled: process.env.TELEGRAM_ENABLED !== "false",
    /** polling (default; works anywhere) | webhook (needs a public HTTPS URL, e.g. on Render) */
    mode: (process.env.TELEGRAM_MODE === "webhook" ? "webhook" : "polling") as "polling" | "webhook",
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || undefined,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  },
  /** agent actions through connectors (credentials only here / in the host env, never in the database) */
  connectors: {
    publicUrl: process.env.PUBLIC_URL || "http://localhost:5173",
    secretsKey: process.env.SECRETS_KEY || undefined,
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN || undefined,
    },
    slackToken: process.env.SLACK_BOT_TOKEN || undefined,
    notionToken: process.env.NOTION_TOKEN || undefined,
  },
  worker: {
    enabled: process.env.WORKER_ENABLED !== "false",
    concurrency: int(process.env.WORKER_CONCURRENCY, 2),
    pollMs: int(process.env.WORKER_POLL_MS, 1500),
    taskTimeoutMs: int(process.env.TASK_TIMEOUT_MS, 120_000),
  },
};

export type Config = typeof config;
