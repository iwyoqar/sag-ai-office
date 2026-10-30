// Encrypted storage for connector credentials obtained at runtime (OAuth refresh tokens).
// AES-256-GCM; the 32-byte key comes from SECRETS_KEY (base64) in the server environment only.
// Without a key nothing is stored — the UI says so and env-provided credentials keep working.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";

export function parseKey(b64: string | undefined): Buffer | null {
  if (!b64) return null;
  const k = Buffer.from(b64, "base64");
  return k.length === 32 ? k : null;
}

export class SecretStore {
  constructor(private db: Db, private key: Buffer | null) {}

  get enabled() {
    return !!this.key;
  }

  put(provider: string, value: string, meta: { account?: string | null; scopes?: string[]; userId?: string | null }) {
    if (!this.key) throw new Error("SECRETS_KEY sozlanmagan — maxfiy kalitni saqlab bo'lmaydi");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    this.db.run(
      `INSERT INTO connector_secrets (provider, ciphertext, iv, tag, account, scopes, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
         account = excluded.account, scopes = excluded.scopes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      provider, ct, iv, c.getAuthTag(), meta.account ?? null, JSON.stringify(meta.scopes ?? []), meta.userId ?? null, now(),
    );
  }

  get(provider: string): string | null {
    if (!this.key) return null;
    const r = this.db.get<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }>(
      "SELECT ciphertext, iv, tag FROM connector_secrets WHERE provider = ?", provider,
    );
    if (!r) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(r.iv));
      d.setAuthTag(Buffer.from(r.tag));
      return Buffer.concat([d.update(Buffer.from(r.ciphertext)), d.final()]).toString("utf8");
    } catch {
      return null; // wrong key (rotated) or tampered row: treat as not connected
    }
  }

  info(provider: string) {
    return this.db.get<{ account: string | null; scopes: string; updated_at: string }>(
      "SELECT account, scopes, updated_at FROM connector_secrets WHERE provider = ?", provider,
    );
  }

  remove(provider: string) {
    this.db.run("DELETE FROM connector_secrets WHERE provider = ?", provider);
  }
}
