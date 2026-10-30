// Per-instance connector credentials, encrypted at rest with AES-256-GCM (key: SECRETS_KEY). The additional
// authenticated data binds each ciphertext to its own row, instance and method, so a row copied onto another
// instance does not decrypt. Plaintext leaves this class only through resolve(), which only server-side tool code
// calls; everything else sees metadata (method, status, fingerprint, dates).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";
import { uid } from "../lib/ids.js";
import type { AuthMethod } from "./registry.js";

export type CredentialMethod = Exclude<AuthMethod, "NONE">;
export type CredentialStatus = "ACTIVE" | "ROTATED" | "REVOKED" | "EXPIRED";

export interface CredentialMeta {
  id: string; instanceId: string; method: CredentialMethod; status: CredentialStatus; fingerprint: string;
  keyVersion: number; expiresAt: string | null; lastUsedAt: string | null; createdBy: string; createdAt: string;
  revokedAt: string | null; rotatedFrom: string | null;
}

interface Row {
  id: string; instance_id: string; method: CredentialMethod; ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; key_version: number;
  fingerprint: string; status: CredentialStatus; expires_at: string | null; last_used_at: string | null; rotated_from: string | null;
  created_by: string; created_at: string; revoked_at: string | null;
}

const aad = (id: string, instanceId: string, method: string) => Buffer.from(`${id}|${instanceId}|${method}`, "utf8");
const toMeta = (r: Row): CredentialMeta => ({
  id: r.id, instanceId: r.instance_id, method: r.method, status: r.status, fingerprint: r.fingerprint, keyVersion: r.key_version,
  expiresAt: r.expires_at, lastUsedAt: r.last_used_at, createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at, rotatedFrom: r.rotated_from,
});

export class CredentialVault {
  constructor(private db: Db, private key: Buffer | null, private keyVersion = 1) {}

  /** Without SECRETS_KEY nothing can be stored (and nothing is stored in plain text instead). */
  get enabled() {
    return !!this.key;
  }

  /**
   * Stores a new secret for (instance, method). An ACTIVE one of the same method becomes ROTATED in the same
   * transaction, so there is always at most one usable credential.
   */
  store(instanceId: string, method: CredentialMethod, secret: string, o: { by: string; expiresAt?: string | null }): CredentialMeta {
    if (!this.key) throw new Error("SECRETS_KEY is not configured: credentials cannot be stored");
    if (!secret.trim()) throw new Error("empty secret");
    const id = uid("crd");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(aad(id, instanceId, method));
    const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 8);
    this.db.tx(() => {
      const prev = this.db.get<{ id: string }>("SELECT id FROM connector_credentials WHERE instance_id = ? AND method = ? AND status = 'ACTIVE'", instanceId, method);
      if (prev) this.db.run("UPDATE connector_credentials SET status = 'ROTATED' WHERE id = ?", prev.id);
      this.db.run(
        `INSERT INTO connector_credentials (id, instance_id, method, ciphertext, iv, tag, key_version, fingerprint, status, expires_at, rotated_from, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', ?,?,?,?)`,
        id, instanceId, method, ct, iv, c.getAuthTag(), this.keyVersion, fingerprint, o.expiresAt ?? null, prev?.id ?? null, o.by, now(),
      );
    });
    return this.meta(instanceId).find((m) => m.id === id)!;
  }

  revoke(credentialId: string, by: string): CredentialMeta {
    const r = this.db.get<Row>("SELECT * FROM connector_credentials WHERE id = ?", credentialId);
    if (!r) throw new Error("credential not found");
    this.db.run("UPDATE connector_credentials SET status = 'REVOKED', revoked_at = ?, revoked_by = ? WHERE id = ? AND status IN ('ACTIVE','EXPIRED')", now(), by, credentialId);
    return this.meta(r.instance_id).find((m) => m.id === credentialId)!;
  }

  /** Metadata of an instance's credentials (never the secret). Expired ones are marked on the way. */
  meta(instanceId: string): CredentialMeta[] {
    this.expire(instanceId);
    return this.db.all<Row>("SELECT * FROM connector_credentials WHERE instance_id = ? ORDER BY created_at DESC", instanceId).map(toMeta);
  }

  /** The usable secret, for server-side connector calls only. null = none, expired, revoked, or undecryptable. */
  resolve(instanceId: string, method: CredentialMethod): string | null {
    if (!this.key) return null;
    this.expire(instanceId);
    const r = this.db.get<Row>("SELECT * FROM connector_credentials WHERE instance_id = ? AND method = ? AND status = 'ACTIVE'", instanceId, method);
    if (!r) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(r.iv));
      d.setAAD(aad(r.id, r.instance_id, r.method));
      d.setAuthTag(Buffer.from(r.tag));
      const out = Buffer.concat([d.update(Buffer.from(r.ciphertext)), d.final()]).toString("utf8");
      this.db.run("UPDATE connector_credentials SET last_used_at = ? WHERE id = ?", now(), r.id);
      return out;
    } catch {
      return null; // other key (rotated SECRETS_KEY), tampered or moved row: unusable, never "half" usable
    }
  }

  private expire(instanceId: string) {
    this.db.run("UPDATE connector_credentials SET status = 'EXPIRED' WHERE instance_id = ? AND status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?", instanceId, now());
  }
}
