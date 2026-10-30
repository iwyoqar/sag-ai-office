// Where encrypted backups go. Two implementations behind one small interface:
//   S3Store       — any S3-compatible object storage the owner chooses (AWS S3, Cloudflare R2, Backblaze B2, MinIO…),
//                   signed with AWS Signature V4 using node:crypto only (no SDK dependency);
//   LocalDirStore — a directory (tests, pre-migration copies, or a mounted volume).
// Credentials come from the environment only and never appear in errors or logs.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export interface StoredObject { key: string; size: number; modified: string }

export interface ObjectStore {
  readonly describe: string;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

const safeKey = (key: string) => {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`invalid object key: ${key}`);
  return key;
};

export class LocalDirStore implements ObjectStore {
  constructor(private root: string) {}
  get describe() {
    return `local directory ${this.root}`;
  }
  async put(key: string, body: Buffer) {
    const p = join(this.root, safeKey(key));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  async get(key: string) {
    return readFileSync(join(this.root, safeKey(key)));
  }
  async list(prefix: string) {
    const out: StoredObject[] = [];
    const walk = (dir: string) => {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else {
          const key = relative(this.root, p).split(sep).join("/");
          if (key.startsWith(prefix)) out.push({ key, size: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    walk(this.root);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async delete(key: string) {
    rmSync(join(this.root, safeKey(key)), { force: true });
  }
}

export interface S3Config {
  /** e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
// RFC 3986 encoding as SigV4 requires ('/' kept in paths)
const enc = (s: string, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, "/") : e;
};

/**
 * AWS Signature Version 4 for S3. Returns the headers to send (including Authorization). Exported for the
 * test against AWS's published example.
 */
export function signS3(o: {
  method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>;
  payloadHash: string; region: string; accessKeyId: string; secretAccessKey: string; amzDate: string;
}): Record<string, string> {
  const date = o.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: o.host, "x-amz-content-sha256": o.payloadHash, "x-amz-date": o.amzDate };
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.keys(o.query ?? {}).sort().map((k) => `${enc(k)}=${enc(o.query![k])}`).join("&");
  const canonical = [o.method, enc(o.path, true), canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), o.payloadHash].join("\n");
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", o.amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** Path-style requests (endpoint/bucket/key): works with AWS S3, R2, B2 and MinIO. */
export class S3Store implements ObjectStore {
  constructor(private c: S3Config, private http: typeof fetch = fetch, private clock = () => new Date()) {}

  get describe() {
    return `s3 ${new URL(this.c.endpoint).host}/${this.c.bucket}`;
  }

  private async req(method: string, key: string, o: { body?: Buffer; query?: Record<string, string>; contentType?: string } = {}) {
    const url = new URL(this.c.endpoint);
    const path = `/${this.c.bucket}${key ? `/${safeKey(key)}` : ""}`;
    const amzDate = this.clock().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const body = o.body ?? Buffer.alloc(0);
    const headers = signS3({
      method, host: url.host, path, query: o.query, payloadHash: sha256hex(body), region: this.c.region,
      accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, amzDate,
      headers: o.contentType ? { "content-type": o.contentType } : {},
    });
    delete headers.host; // set by fetch from the URL
    const qs = o.query ? `?${Object.keys(o.query).sort().map((k) => `${enc(k)}=${enc(o.query![k])}`).join("&")}` : "";
    const res = await this.http(`${url.origin}${enc(path, true)}${qs}`, { method, headers, body: method === "PUT" ? new Uint8Array(body) : undefined });
    if (!res.ok) {
      // the response body may echo request details; report only the status and S3's error code
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "error";
      throw new Error(`object storage ${method} ${key || "(list)"} failed: HTTP ${res.status} ${code}`);
    }
    return res;
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream") {
    await this.req("PUT", key, { body, contentType });
  }

  async get(key: string) {
    return Buffer.from(await (await this.req("GET", key)).arrayBuffer());
  }

  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const xml = await (await this.req("GET", "", { query })).text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const f = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[1])?.[1] ?? "";
        out.push({ key: f("Key"), size: Number(f("Size")), modified: f("LastModified") });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : undefined;
    } while (token);
    return out;
  }

  async delete(key: string) {
    await this.req("DELETE", key);
  }
}
