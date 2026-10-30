// Connector registry: what each external service *is* (definition), kept separate from where it is *connected*
// (connector_installations = instances, owned by a unit, region or the group) and from its *credentials*
// (connector_credentials, encrypted). Definitions are code, versioned with it; instances and credentials are data.
//
// `status` is about the code, never about a connection:
//   AVAILABLE  — implemented here: tools and/or a health check exist and run against the real provider;
//   PLANNED    — provider known, nothing implemented yet (no tools, no credential storage, no "connect" button);
//   DISCOVERY  — the product itself must be identified first (see docs/integrations/SAP_DISCOVERY.md).
import { z, type ZodTypeAny } from "zod";
import { GOOGLE_SCOPES } from "./google.js";
import { TOOLS } from "./tools.js";

export type ConnectorCategory = "ai_provider" | "messaging" | "productivity" | "crm" | "erp" | "search" | "internal" | "other";
export type AuthMethod = "NONE" | "API_KEY" | "OAUTH2" | "WEBHOOK_SECRET" | "SERVICE_ACCOUNT";
export type DefinitionStatus = "AVAILABLE" | "PLANNED" | "DISCOVERY";

export interface ConnectorAction { tool: string; kind: "read" | "write"; scopes: string[] }

export interface ConnectorDefinition {
  id: string;
  name: string;
  provider: string;
  category: ConnectorCategory;
  version: string;
  status: DefinitionStatus;
  /** methods the provider offers */
  authMethods: AuthMethod[];
  /** methods this code can actually use (credentials can only be stored for these) */
  implementedAuth: AuthMethod[];
  /** provider scopes a fully working instance needs */
  scopes: string[];
  /** typed tools agents may call (derived from connectors/tools.ts; nothing else is ever executed) */
  actions: ConnectorAction[];
  /** shape of an instance's non-secret configuration */
  configSchema: ZodTypeAny;
  /** a real check against the provider exists (connectors/hub.ts verify) */
  healthCheck: boolean;
  notes?: string;
}

const G = (s: string) => `https://www.googleapis.com/auth/${s}`;
/** scopes each Google tool needs (checked against the scopes the connected account actually granted) */
const TOOL_SCOPES: Record<string, string[]> = {
  gmail_search: [G("gmail.readonly")], gmail_send: [G("gmail.send")],
  drive_search: [G("drive.readonly")], drive_create_document: [G("drive.file")],
  sheets_read: [G("spreadsheets")], sheets_append: [G("spreadsheets")],
  calendar_list_events: [G("calendar.events")], calendar_create_event: [G("calendar.events")],
};

const actionsOf = (connector: string): ConnectorAction[] =>
  TOOLS.filter((t) => t.connector === connector).map((t) => ({ tool: t.name, kind: t.kind, scopes: TOOL_SCOPES[t.name] ?? [] }));

const NO_CONFIG = z.object({}).strict();

const available = (d: Omit<ConnectorDefinition, "status" | "actions" | "version" | "configSchema"> & { configSchema?: ZodTypeAny }): ConnectorDefinition => ({
  version: "1", configSchema: NO_CONFIG, ...d, status: "AVAILABLE", actions: actionsOf(d.id),
});
const planned = (d: Pick<ConnectorDefinition, "id" | "name" | "provider" | "category" | "authMethods"> & { notes?: string; status?: DefinitionStatus }): ConnectorDefinition => ({
  version: "0", status: d.status ?? "PLANNED", implementedAuth: [], scopes: [], actions: [], configSchema: NO_CONFIG, healthCheck: false, ...d,
});

const googleScopes = GOOGLE_SCOPES.filter((s) => s.startsWith("https://"));

export const REGISTRY: readonly ConnectorDefinition[] = [
  available({ id: "internal-api", name: "SAG AI Office", provider: "SAG", category: "internal", authMethods: ["NONE"], implementedAuth: ["NONE"], scopes: [], healthCheck: false }),
  available({ id: "web-search", name: "Web qidiruv", provider: "Google (Gemini grounding)", category: "search", authMethods: ["NONE"], implementedAuth: ["NONE"], scopes: [], healthCheck: false,
    notes: "uses the platform AI provider; no credential of its own" }),
  available({ id: "telegram", name: "Telegram", provider: "Telegram", category: "messaging", authMethods: ["API_KEY", "WEBHOOK_SECRET"], implementedAuth: ["API_KEY", "WEBHOOK_SECRET"],
    scopes: [], healthCheck: true, notes: "one bot per server (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET in the environment)" }),
  ...(["gmail", "drive", "sheets", "calendar"] as const).map((id) => available({
    id, name: { gmail: "Gmail", drive: "Google Drive", sheets: "Google Sheets", calendar: "Google Calendar" }[id], provider: "Google Workspace", category: "productivity",
    authMethods: ["OAUTH2", "SERVICE_ACCOUNT"], implementedAuth: ["OAUTH2"], scopes: googleScopes.filter((s) => actionsOf(id).some((a) => (TOOL_SCOPES[a.tool] ?? []).includes(s))),
    healthCheck: true, notes: "OAuth 2.0 consent (one company account); service accounts / domain-wide delegation not implemented",
  })),
  available({ id: "slack", name: "Slack", provider: "Slack", category: "messaging", authMethods: ["API_KEY", "OAUTH2"], implementedAuth: ["API_KEY"],
    scopes: ["channels:read", "chat:write"], healthCheck: true, notes: "bot token (xoxb-…); OAuth install flow not implemented" }),
  available({ id: "notion", name: "Notion", provider: "Notion", category: "productivity", authMethods: ["API_KEY", "OAUTH2"], implementedAuth: ["API_KEY"],
    scopes: [], healthCheck: true, notes: "internal integration token; public OAuth not implemented" }),
  available({ id: "gemini", name: "Google Gemini", provider: "Google", category: "ai_provider", authMethods: ["API_KEY"], implementedAuth: ["API_KEY"],
    scopes: [], healthCheck: true, notes: "platform AI provider (GEMINI_API_KEY); runs agents, embeddings and web search" }),
  planned({ id: "anthropic", name: "Anthropic Claude", provider: "Anthropic", category: "ai_provider", authMethods: ["API_KEY"],
    notes: "the LLM provider interface (llm/types.ts) is ready; no Claude client is implemented yet" }),
  planned({ id: "bitrix24", name: "Bitrix24", provider: "Bitrix24", category: "crm", authMethods: ["WEBHOOK_SECRET", "OAUTH2"],
    notes: "incoming-webhook URL or OAuth 2.0 app; portal, plan and required CRM entities to be confirmed" }),
  planned({ id: "sap", name: "SAP", provider: "SAP", category: "erp", authMethods: [], status: "DISCOVERY",
    notes: "product, version, APIs, authentication and network path unknown — see docs/integrations/SAP_DISCOVERY.md" }),
  ...(["canva", "crm", "erp", "accounting", "ads", "analytics", "recruiting", "github", "monitoring"] as const).map((id) =>
    planned({ id, name: id === "crm" ? "CRM" : id === "erp" ? "ERP" : id[0].toUpperCase() + id.slice(1), provider: "—", category: "other", authMethods: [],
      notes: "placeholder from the original catalog: the concrete product has not been chosen" })),
];

export const definitionOf = (id: string) => REGISTRY.find((d) => d.id === id);

/** Consistency rules, checked by tests: every executable tool belongs to an AVAILABLE definition, and so on. */
export function registryProblems(defs: readonly ConnectorDefinition[] = REGISTRY): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) out.push(`duplicate id ${d.id}`);
    ids.add(d.id);
    if (d.implementedAuth.some((m) => !d.authMethods.includes(m))) out.push(`${d.id}: implementedAuth not in authMethods`);
    if (d.status !== "AVAILABLE" && (d.actions.length || d.implementedAuth.length || d.healthCheck)) out.push(`${d.id}: not AVAILABLE but has actions/auth/health`);
    for (const a of d.actions) if (a.scopes.some((s) => !d.scopes.includes(s))) out.push(`${d.id}: ${a.tool} needs a scope the definition does not declare`);
  }
  for (const t of TOOLS) {
    const d = defs.find((x) => x.id === t.connector);
    if (!d || d.status !== "AVAILABLE") out.push(`tool ${t.name} has no AVAILABLE definition`);
  }
  return out;
}

/** Credential methods that can be stored per instance (the rest live in the server environment for now). */
export const STORABLE_AUTH: Record<string, AuthMethod[]> = { slack: ["API_KEY"], notion: ["API_KEY"] };
