# W0 completion + W1 Business Unit Foundation — implementation report (2026-10-30)

Working tree on top of `0c919d1` (W0) / `27cfb2e` (store import). **Not committed, not pushed, not deployed.**
Deployment and hosting were out of scope for this sprint.

## 1. Initial audit (before coding)

| Area | Found in the code | Status after this sprint |
|---|---|---|
| CSRF / Origin | no Origin check; only `SameSite=Lax` | ✅ fixed |
| Credential logging | generated admin password written to the server log (`index.ts`) and printed by `db/cli.ts`; Telegram token and Gemini key already kept out of URLs/logs | ✅ fixed + log-line scrubbing |
| Routine ↔ task atomicity | `runOccurrence` wrote run, task and `last_run_at` in separate statements; inside `runNow` a half-failed `createTask` could be committed; the scheduler's claim was separate from the run | ✅ fixed (savepoints + one transaction) |
| 4-suite stress timeouts | 4/12 green with the current suite; 8 timeouts + 1 timing assertion | ✅ root cause found and fixed — 24/24 |
| Agent reliability | heartbeat, fencing, recovery, idempotency already in place (W0) | ✅ re-verified; one test made timing-independent; new coexistence test |
| Unit functions | `org_nodes.functions` JSON without validation | ✅ typed + validated (API and DB) |
| Unit budgets | none | ✅ implemented |
| Unit knowledge base | `knowledge_documents` had no unit; runner gave non-HQ agents no documents | ✅ implemented, RAG bounded in SQL |
| Unit connectors | hard-coded "non-HQ agents get no tools" | ✅ installations per unit; credentials remain server-side |
| AI Directors | one per unit, APPROVAL (from the import) | ✅ verified by tests |
| Agreements | parties, classes, level, validity, approve/revoke, audit; no read/write level, no status | ✅ access READ / READ_WRITE + explicit status |

## 2. W0 issues fixed

- **CSRF / Origin** (`lib/origin.ts`, hook in `app.ts`): POST/PUT/PATCH/DELETE must carry an `Origin` (or `Referer`) from
  `PUBLIC_URL` / `ALLOWED_ORIGINS`; `Origin: null` and `Sec-Fetch-Site: cross-site|same-site` without Origin are
  refused; requests without browser headers (API clients, Telegram) pass — they carry no ambient cookie. The Telegram
  webhook is exempt (own secret). `render.yaml` gained `PUBLIC_URL` so production logins keep working.
- **No credentials in logs** (`lib/redact.ts`): every finished log line is scrubbed of all configured secret values
  (raw, JSON-escaped, URL-encoded) via pino's `streamWrite` hook; header redaction extended (Telegram webhook secret,
  `set-cookie`). The generated first-boot admin password goes to `data/initial-admin-password.txt` (owner-only file
  mode) instead of the log/stdout. A source scan test fails if a log statement interpolates a password/token/key.
- **Routine atomicity** (`db.tx` + `schedule/service.ts`): nested `db.tx` calls are now SAVEPOINTs, so a caught inner
  failure leaves none of its writes. `runOccurrence` is one transaction (run, task or recorded failure, `last_run_at`,
  audit); the scheduler claims an occurrence and runs it in the same transaction — a crash can neither skip nor
  double an occurrence.
- **Stress timeouts — root cause**: test infrastructure, not the application. Every failure was the 5 s per-test
  timeout, spread randomly across files; sequential and 2-way runs were always green. The machine has 12 cores but
  7.3 GB RAM; Vitest started one fork per core per suite (≈44 processes for 4 suites, each loading the full server,
  plus worker threads re-compiling TypeScript), so CPU and memory were oversubscribed ("collect" time 172 s). Fix:
  forks capped (`apps/server/vitest.config.ts`, min(6, cores/2), override `VITEST_MAX_FORKS`). Single run 17 → 18 s.
  One genuine timing dependency was also found and fixed in a new test (a 20 ms heartbeat could make a live worker
  look dead under load; with fencing this is safe, but the test now uses a realistic heartbeat). No timeout raised.
- **Agent reliability re-check**: lease heartbeat + fencing, crash recovery, idempotent approvals, graceful shutdown
  re-run under stress; new test — a second worker starting next to a live one leaves its lease alone, duplicate claims
  get nothing, the graceful stop hands the task back.

## 3. W1 features completed

- **Unit functions**: `RETAIL, WAREHOUSE, FACTORY, OFFICE, LOGISTICS, DEALER, HEADQUARTERS`; one or more per unit,
  distinct; validated by zod and by SQLite triggers; HEADQUARTERS only (and always) on `hq`; independent of
  business type/ownership. HQ = `HEADQUARTERS, OFFICE`; the 22 stores keep `RETAIL`. Set by HQ platform admins
  (`PUT /api/units/:id/functions`), audited.
- **Unit budgets** (`domain/budgets.ts`, `lib/money.ts`): per unit × month × category, UZS integer minor units
  (`typeof = 'integer'` enforced), amounts as decimal strings in the API, BigInt arithmetic, half-even rounding once
  at conversion; spending entries keep original amount + currency + exact rate (×10^8), date and source. Workflow
  DRAFT → SUBMITTED → APPROVED/REJECTED → CLOSED with guarded transitions. Rights: unit director drafts/submits/records,
  manager records/views, staff nothing; SAG_BRANCH budgets approved by an HQ director who did not submit them;
  franchise/subsidiary budgets self-governed (audited `selfApproved`), visible outside only through an agreement with
  the `budget` class (AGGREGATE = totals, DETAIL = budgets + entries), never writable from outside. Every change audited.
- **Unit knowledge bases** (`knowledge/scope.ts`, `domain/unitKnowledge.ts`): documents carry `business_unit_id`,
  `visibility` (UNIT / BRANCHES), `source_label`, `created_by`. Every list and search (BM25 and embeddings) takes a
  unit and filters in SQL: franchise → own only; SAG branch → own + HQ documents HQ shared with branches; HQ → HQ.
  Runner grounding, the agent search tool and agent chat use the agent's unit; HQ memory never reaches other units.
  Unit routes `GET/POST/DELETE /api/units/:id/knowledge`, `/search`; HQ `PATCH /api/knowledge/:id/visibility`.
- **Unit connectors** (`connectors/installations.ts`): `connector_installations` per unit (status, health, last
  error, credential scope — never credentials); HQ owns all catalog connectors; units can receive only connectors that
  need no per-unit credential (today: `web-search`), installed by HQ platform admins; the unit director grants them to
  the unit's agents; a DB trigger refuses grants for connectors not installed in the agent's unit; disabling withdraws
  grants; tools for unit agents = own-unit knowledge search + granted installed connectors. Visible to the unit's
  leads, HQ group level for branches, platform admins; never another unit, no agreement opens it. Audited.
- **AI Directors**: verified per unit (exactly one, own unit and department, ACTIVE, hiring policy APPROVAL); DB refuses
  moving it to another unit's department or giving it another unit's task; invisible to HQ agent routes; its RAG and
  tools are unit-bounded (tests with the mock provider).
- **Agreements**: `access` READ / READ_WRITE (write only for `tasks` at DETAIL — the grantee may assign work into the
  unit; never budgets, employees, knowledge); explicit `status` PENDING / SCHEDULED / ACTIVE / EXPIRED / REVOKED;
  validity order checked; denied by default; region membership alone opens nothing (tested for budgets and employees).

## 4. Still pending (not implemented)

- Real Gemini run: the key in the local `.env` is rejected by Google ("API key not valid"); real-provider testing of
  AI Directors remains pending until a valid key is configured.
- Per-unit credentials for Google, Slack, Notion, Telegram (only credential-free connectors can be installed in units).
- Automatic AI-usage entries in budgets (AI cost is still stored as REAL USD in `usage_records`); FX rate table / CBU
  import (rates are entered per entry with date and source).
- UI for budgets, unit knowledge, unit connectors and agreements (APIs only).
- W2+ (unit-scoped routes for everything, UnitRequests, marketplace hiring, KPIs) — not started, by instruction.

## 5. Database migration

`015_w1_foundation.sql` (foreign keys off during the migration for `ADD COLUMN … REFERENCES`; FK check enforced):
function triggers and data fix, `currencies`, `unit_budgets`, `unit_budget_entries` (+ unit trigger),
`knowledge_documents.business_unit_id / visibility / source_label` (+ scope triggers), `connector_installations`
(HQ rows backfilled) + grant trigger, `data_sharing_agreements.access`. Applied on fresh databases in every test run.

## 6. Files changed

Server: `src/app.ts`, `src/config.ts`, `src/index.ts`, `src/db/{db,seed,cli}.ts`, `src/db/migrations/015_w1_foundation.sql`,
`src/lib/{origin,redact,money}.ts` (new), `src/schedule/service.ts`,
`src/domain/{units,budgets (new),unitKnowledge (new)}.ts`, `src/knowledge/{scope (new),service,semantic}.ts`,
`src/connectors/{installations (new),hub,tools}.ts`, `src/agents/runner.ts`, `src/routes/{units,brain,runtime}.ts`,
`vitest.config.ts`. Shared: `packages/shared/src/dto.ts`. Tests: new `origin`, `redact`, `w1`; extended `schedule`,
`reliability`, `db`, `brain`, `units`. Config: `.env.example`, `render.yaml` (`PUBLIC_URL`).

## 7. Tests

| Check | Result |
|---|---|
| Server tests | **202 / 202** (19 files) |
| Web tests | **39 / 39** |
| Typecheck server + web | pass |
| Production build | pass |
| Authorization / isolation / KB / budget / connector / agreement / AI Director tests | included above (`isolation`, `units`, `w1`, `origin`, `redact`, `reliability`, `schedule`) |
| Mutation checks | knowledge scope removed → 3 W1 tests fail |
| Real Gemini | not passed: local key rejected (see §4) |

## 8. Stress results (12 cores, 7.3 GB RAM)

| Run | Before | After |
|---|---|---|
| 4 suites in parallel × 3 | 4 / 12 green (8 timeouts, 1 timing assertion) | — |
| 4 suites in parallel × 6 | — | **24 / 24 green** |

## 9. Security findings

- Fixed: missing CSRF/Origin protection; admin password in logs; non-atomic routine runs (possible half-committed task
  rows); HQ memory would have reached unit agents' chat context (unreachable by route today, closed anyway).
- Behaviour changes: unit AI Directors now have one tool (their own unit's knowledge search); cross-site
  state-changing requests get 403 `bad_origin` (production needs `PUBLIC_URL` — added to `render.yaml`).
- Open from earlier: credential rotation (owner), off-site backup storage (owner), scrypt work-factor upgrade.

## 10. Recommended next phase

Review this sprint. Then W2: unit-scoped routes for the remaining HQ areas, per-unit credentials for one connector
family, UI for budgets/knowledge/connectors/agreements, AI-usage → budget entries with integer cost. Re-run the real
Gemini check once a valid key is configured.
