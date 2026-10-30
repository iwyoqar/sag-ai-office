# W2.1 Integration Hub Core — report (2026-10-30)

Base: `a16d46c` (W0/W1, server 202/202, web 39/39 — re-verified before starting). Working tree only: **not
committed, not pushed, not deployed**. W2.2 not started.

## 1. Existing architecture found

| Piece | Where | Reused / changed |
|---|---|---|
| Tool registry (18 typed tools, read/write, zod args) | `connectors/tools.ts` | reused as is; no generic HTTP tool exists or was added |
| Connector hub (availability, grants, invoke, approvals, decide, verify) | `connectors/hub.ts` | extended: one authorization path, reliability, instance credentials, health runs |
| Credentials | `.env` (Slack/Notion/Telegram/Gemini) + `connector_secrets` (Google refresh token, AES-GCM) | kept; new per-instance vault added beside it |
| Instances | `connector_installations` (UNIT only, W1) | rebuilt with scope UNIT / REGION / GROUP + health fields |
| Unit access, agreements | `domain/units.ts` | reused (instances follow the same unit boundaries; agreements never open connectors) |
| Audit | `lib/audit.ts` (unit-tagged) | reused |
| Background jobs | runner, scheduler, backup job | no connector sync job exists; `connector_runs` tracks health checks (kind SYNC reserved) |
| UI | The Brain → Connectorlar (department matrix, Google connect, activity) | kept; new "Integration Hub" tab |

## 2. Connector Registry (`connectors/registry.ts`)

Typed definitions separate from instances: id, name, provider, category, version, status (AVAILABLE / PLANNED /
DISCOVERY), provider auth methods vs. implemented auth methods, required scopes, actions (derived from the tool
registry, each with its scopes), config schema, health-check flag, notes. `registryProblems()` enforces: every
executable tool belongs to an AVAILABLE definition; non-AVAILABLE definitions have no actions, auth or health
check; action scopes ⊆ definition scopes.

Prepared providers: **Gemini** (AVAILABLE — platform AI provider, health via the LLM client), **Telegram**
(AVAILABLE — server bot), **Google Workspace** (AVAILABLE — OAuth; service accounts declared but not implemented),
**Anthropic Claude** (PLANNED — no client yet), **Bitrix24** (PLANNED), **SAP** (DISCOVERY —
[requirements](../integrations/SAP_DISCOVERY.md)). Definitions never imply a connection.

## 3. Credential security (`connectors/vault.ts`)

- AES-256-GCM with `SECRETS_KEY`; AAD = credential id + instance id + method (a row moved to another instance does
  not decrypt); key version stored.
- Methods: API_KEY, OAUTH2, WEBHOOK_SECRET, SERVICE_ACCOUNT in the schema; **storable today only where the code uses
  them** (Slack and Notion API tokens). Others are refused, not stored.
- Rotation (new ACTIVE, old ROTATED, one ACTIVE per method enforced by a partial unique index), revocation,
  expiry (EXPIRED on read), `last_used_at`; fingerprint (8 hex of SHA-256) for people to tell keys apart.
- Secrets never in any DTO, list, audit entry or log line (audit stores method + fingerprint; log scrubbing from W0
  still applies). Without `SECRETS_KEY` nothing is stored.
- Who manages: HQ instance → HQ `brain:manage`; a unit's instance → that unit's director only (franchise keys are
  the franchise's); region/group instance → HQ platform admins.

## 4. Tool execution authorization (`ConnectorHub.authorizeTool`)

One gate used both for the tools offered to the model and for every call, in this order, with a reason code:
`agent_inactive` → `unit_mismatch` (task of another unit) → `unknown_tool` → `not_assigned` (no instance for the
agent's unit, own or assigned) → `tool_not_permitted` (no grant / department link) → `missing_scope` (Google:
scopes the account actually granted) → `write_not_permitted` → `not_connected` (no usable credential). Then the
approval policy: reads run automatically, writes become approval requests. Denials are recorded in
`tool_executions` (`not permitted: <reason>`, class `permission`). Approved writes are **re-authorised at approval
time** (a connector disabled meanwhile → 409, nothing sent) and run with the serving instance's own credential.

## 5. Reliability (`connectors/reliability.ts`)

Per-call deadline (fetch with timeout, default 20 s); error classes auth / permission / not_found / rate_limited /
timeout / network / provider / validation / config; **reads** retried on transient classes (3 attempts, exponential
backoff with jitter); **writes never retried** — failure → `failed`, unknowable outcome (timeout/network) →
`unknown`; per-instance rate limit (60 calls/min, in-process — documented single-process limitation); health:
success → HEALTHY, connection-class failures → DEGRADED, 3 in a row → DOWN; health checks recorded in
`connector_runs`; `tool_executions` records instance, attempts and error class. Write idempotency (W0) unchanged.

## 6. Business-unit isolation

Instances owned by UNIT / REGION / GROUP (scope level must match the node; DB trigger). Region/group instances reach
a unit **only by explicit assignment**, only to SAG-owned units below the scope (and HQ for group instances) — the
database refuses franchise and out-of-scope assignments; region membership never assigns. Agent grants require an
enabled own or assigned instance (trigger). Franchise instances and keys are invisible to other units and to HQ
group level; platform admins see metadata only and cannot manage franchise keys.

## 7. UI (The Brain → Integration Hub)

Connected instances (scope, health, status, last error class, credential method/fingerprint/expiry, assignments),
connector catalog with code status, audit history. Functional actions only, shown only when the server allows
them: enter / rotate / revoke a key (password field, never shown again), health check (only where one exists),
create a region/group instance and assign/unassign SAG branches (platform admins). No connect button for planned
providers. **Not verified in a browser**: signing in needs the owner's password.

## 8. Database migration

`016_integration_hub.sql`: catalog rows (gemini, anthropic, bitrix24, sap); `connector_installations` rebuilt with
scope + health columns (data copied); `connector_instance_assignments` + scope trigger; grant trigger updated;
`connector_credentials`; `connector_runs`; `tool_executions.instance_id / attempts / error_class`. Applied on a fresh
DB in every test. On the dev database it was already applied (2026-10-30 13:46 UTC) by a dev server started in
another session; automatic backup `data/backups/pre-migrate-20261030T134627Z.db`. The dev schema matches a fresh
migration exactly (148 objects, 0 differences).

## 9. Files

New: `connectors/{registry,vault,reliability,integrationHub}.ts`, migration 016, `test/integrations.test.ts`,
`apps/web/src/ui/IntegrationHub.tsx`, `docs/integrations/SAP_DISCOVERY.md`, this report. Changed:
`connectors/{hub,installations}.ts`, `routes/connectors.ts`, `app.ts`, `db/{seed,seedData}.ts`, `test/db.test.ts`,
`apps/web/src/ui/BrainPanel.tsx`, `apps/web/src/styles.css`, docs.

## 10. Tests

| Check | Result |
|---|---|
| Server | **214 / 214** (20 files; +12 in `integrations.test.ts`) |
| Web | **39 / 39** |
| Typecheck server + web, production build | pass |
| Stress (4 parallel runs × 3) | 0 / 12 fully green — every failure "Test timed out" (plus one temp-file IO error), taken while another session's dev servers ran, CPU ~50 % idle, 0.7 GB RAM free; not a code failure, to be re-run on an idle machine |
| Mutation checks | removing approval-time re-authorisation → 1 test fails; removing the unit-mismatch check → 1 test fails |

Covered: registry consistency, catalog honesty, encryption/AAD/rotation/revocation/expiry, secret redaction in
API/audit, franchise isolation, shared-instance assignment rules (DB + API), every denial reason in order, Google
scope check, approval-gated write with the unit's own key, idempotent proposal, read retry vs. no write retry,
`unknown` on timeout, health DOWN/recovery with recorded runs, rate limit.

## 11. Remaining limitations

- Real providers not called in tests (fake HTTP). Gemini key in the local `.env` is invalid; Slack/Notion/Google
  live checks need real credentials.
- Credential storage only for Slack/Notion API tokens; Google stays on its existing OAuth store (HQ, one account);
  OAuth 2.0 client-credentials, service accounts, webhook secrets per instance are modelled but have no flow.
- Rate limiter and Google token cache are in-process (single-server deployment).
- No connector sync jobs yet (`connector_runs` kind SYNC reserved); Bitrix24/Anthropic/SAP not implemented.
- Unit directors manage keys through the API; the Integration Hub UI is in HQ's The Brain only.
- Google with an operator-provided `GOOGLE_REFRESH_TOKEN`: granted scopes unknown, taken as the requested scopes.
