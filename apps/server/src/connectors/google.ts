// Google Workspace (Gmail, Drive, Sheets, Calendar) via OAuth 2.0 — one company account.
// The refresh token comes from the in-app consent flow (stored encrypted) or GOOGLE_REFRESH_TOKEN in the env.
// Access tokens live only in memory and are refreshed shortly before they expire.
import { randomBytes } from "node:crypto";
import type { SecretStore } from "./secrets.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events",
  "openid", "email",
];

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  /** optional env-provided refresh token (used when no token was connected in the app) */
  refreshToken?: string;
  redirectUri: string;
}

export class ConnectorError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export class GoogleAuth {
  private access: { token: string; until: number } | null = null;
  private states = new Map<string, { userId: string; until: number }>();

  constructor(private cfg: GoogleConfig, private secrets: SecretStore, private http: typeof fetch) {}

  get configured() {
    return !!(this.cfg.clientId && this.cfg.clientSecret);
  }

  private refreshToken(): string | null {
    return this.secrets.get("google") ?? this.cfg.refreshToken ?? null;
  }

  get connected() {
    return this.configured && !!this.refreshToken();
  }

  get account(): string | null {
    return this.secrets.info("google")?.account ?? (this.cfg.refreshToken ? "(.env)" : null);
  }

  /** Consent URL; `state` binds the callback to the admin who started it (10 min). */
  authUrl(userId: string): string {
    if (!this.configured) throw new ConnectorError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET sozlanmagan");
    const state = randomBytes(18).toString("base64url");
    this.states.set(state, { userId, until: Date.now() + 10 * 60_000 });
    const q = new URLSearchParams({
      client_id: this.cfg.clientId!, redirect_uri: this.cfg.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  /** Exchanges the consent code; stores the refresh token encrypted. Returns the connected account. */
  async complete(code: string, state: string): Promise<{ userId: string; account: string | null; scopes: string[] }> {
    const s = this.states.get(state);
    this.states.delete(state);
    if (!s || s.until < Date.now()) throw new ConnectorError("Ulanish so'rovi eskirgan yoki noto'g'ri (state)");
    const res = await this.http("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret!, redirect_uri: this.cfg.redirectUri, grant_type: "authorization_code",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string; id_token?: string; error_description?: string };
    if (!res.ok || !data.refresh_token) throw new ConnectorError(`Google tokenini olib bo'lmadi: ${data.error_description ?? res.status}`, res.status);
    let account: string | null = null;
    try {
      account = JSON.parse(Buffer.from((data.id_token ?? "").split(".")[1] ?? "", "base64url").toString()).email ?? null;
    } catch {
      account = null;
    }
    const scopes = (data.scope ?? "").split(" ").filter(Boolean);
    this.secrets.put("google", data.refresh_token, { account, scopes, userId: s.userId });
    this.access = data.access_token ? { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 } : null;
    return { userId: s.userId, account, scopes };
  }

  disconnect() {
    this.secrets.remove("google");
    this.access = null;
  }

  async token(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const refresh = this.refreshToken();
    if (!this.configured || !refresh) throw new ConnectorError("Google ulanmagan");
    const res = await this.http("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret!, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new ConnectorError(`Google tokeni yangilanmadi: ${data.error_description ?? data.error ?? res.status}`, res.status);
    this.access = { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
    return this.access.token;
  }

  /** Authorised JSON call to a Google API; errors carry Google's message (never the token). */
  async call<T>(url: string, init: { method?: string; body?: unknown; raw?: string; contentType?: string } = {}): Promise<T> {
    const token = await this.token();
    const res = await this.http(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.raw || init.body !== undefined ? { "content-type": init.contentType ?? "application/json" } : {}) },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      if (res.status === 401) this.access = null;
      throw new ConnectorError(`Google: ${data.error?.message ?? `HTTP ${res.status}`}`, res.status);
    }
    return data;
  }
}
