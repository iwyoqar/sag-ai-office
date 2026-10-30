// CSRF protection for cookie-authenticated, state-changing requests.
//
// The session cookie is SameSite=Lax; on top of that every POST/PUT/PATCH/DELETE must come from the app's own
// origin. Browsers attach `Origin` to such requests (and `Sec-Fetch-Site`), so a page on another site cannot forge
// one. Requests with neither header come from non-browser clients (curl, scripts, Telegram's webhook): they carry
// no ambient browser cookie, so they are not a CSRF vector and keep working.
export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Server-to-server endpoints authenticated by their own secret (never by the browser session). */
export const ORIGIN_EXEMPT = ["/api/telegram/webhook"];

/** Normalises configured origins ("https://app.example.com/", "http://localhost:5173") to scheme://host[:port]. */
export function parseOrigins(values: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of values.flatMap((x) => (x ?? "").split(",")).map((s) => s.trim()).filter(Boolean)) {
    try {
      out.add(new URL(v).origin);
    } catch {
      throw new Error(`invalid origin in configuration: ${v}`);
    }
  }
  return out;
}

export interface OriginCheck { ok: boolean; reason?: string }

/** Decides whether a state-changing request may proceed. Pure, so it is easy to test exhaustively. */
export function checkOrigin(h: { method: string; url: string; origin?: string; referer?: string; secFetchSite?: string }, allowed: Set<string>): OriginCheck {
  if (!UNSAFE_METHODS.has(h.method.toUpperCase())) return { ok: true };
  const path = h.url.split("?")[0];
  if (ORIGIN_EXEMPT.some((p) => path === p)) return { ok: true };
  if (h.origin && h.origin !== "null") return allowed.has(h.origin) ? { ok: true } : { ok: false, reason: "origin not allowed" };
  if (h.origin === "null") return { ok: false, reason: "opaque origin" }; // sandboxed iframes, data: URLs, file://
  if (h.referer) {
    let ref: string;
    try {
      ref = new URL(h.referer).origin;
    } catch {
      return { ok: false, reason: "malformed referer" };
    }
    return allowed.has(ref) ? { ok: true } : { ok: false, reason: "referer not allowed" };
  }
  // no Origin/Referer: a browser would still say where it came from
  if (h.secFetchSite === "cross-site" || h.secFetchSite === "same-site") return { ok: false, reason: `sec-fetch-site ${h.secFetchSite}` };
  return { ok: true };
}
