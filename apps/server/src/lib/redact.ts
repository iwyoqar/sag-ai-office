// Last line of defence against credentials in logs. Field-level redaction (cookie/authorization headers, audit
// metadata) already exists; this additionally replaces the *values* of every configured secret in each finished
// log line — whatever path a secret took into a message or error, it is written as [redacted].
import type { Config } from "../config.js";

const MIN_SECRET_LENGTH = 8; // shorter values would also match ordinary text

/** Configured secret values worth scrubbing (non-empty, long enough to be unambiguous). */
export function secretValues(c: Config, env: Record<string, string | undefined> = process.env): string[] {
  const raw = [
    c.adminPassword, c.llm.geminiApiKey, c.telegram.token, c.telegram.webhookSecret, c.connectors.secretsKey,
    c.connectors.google.clientSecret, c.connectors.google.refreshToken, c.connectors.slackToken, c.connectors.notionToken,
    env.BACKUP_KEY, env.BACKUP_S3_SECRET_ACCESS_KEY, env.BACKUP_S3_ACCESS_KEY_ID,
    ...(env.BACKUP_OLD_KEYS ?? "").split(",").map((p) => p.split(":")[1]),
  ];
  return [...new Set(raw.map((v) => v?.trim()).filter((v): v is string => !!v && v.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length); // longest first, so overlapping values are fully covered
}

/** Replaces every occurrence of the given values (raw and as they appear inside JSON strings). */
export function scrubber(values: string[]): (s: string) => string {
  const forms = values.flatMap((v) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]);
  const unique = [...new Set(forms)].filter((f) => f.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  if (!unique.length) return (s) => s;
  return (s) => {
    let out = s;
    for (const f of unique) if (out.includes(f)) out = out.split(f).join("[redacted]");
    return out;
  };
}

/** Fastify/pino logger options: header redaction + secret-value scrubbing of every written line. */
export function loggerOptions(level: string, secrets: string[], extra: Record<string, unknown> = {}) {
  const scrub = scrubber(secrets);
  return {
    level,
    redact: [
      "req.headers.cookie", "req.headers.authorization", "req.headers[\"x-goog-api-key\"]",
      "req.headers[\"x-telegram-bot-api-secret-token\"]", "res.headers[\"set-cookie\"]",
    ],
    hooks: { streamWrite: scrub },
    ...extra,
  };
}
