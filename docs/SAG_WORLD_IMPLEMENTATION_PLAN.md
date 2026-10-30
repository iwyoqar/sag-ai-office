# SAG AI WORLD — Implementation plan

Status: **proposal, awaiting review** (2026-10-30). No structural change starts before the architecture is
approved. Each phase ends with its acceptance criteria met, the full test suite green, a report in
`docs/reports/`, and the phase map in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) updated.

Design: [architecture](SAG_WORLD_ARCHITECTURE.md) · [data model](SAG_WORLD_DATA_MODEL.md) ·
[security model](SAG_WORLD_SECURITY_MODEL.md).

## Phase A — stabilisation (done in this round)

### A.1 Flaky server tests — found, root-caused, fixed

Reproduction: 15 sequential runs of the server suite all passed. Running four suites in parallel (CPU
contention, as during the original `npm test` run) gave failures in **7 of 12** runs.

| Test | Symptom | Root cause | Fix |
|---|---|---|---|
| `people.test.ts` (tests 1–2, 3, 4, 15), `auth.test.ts` "applies role permissions" | `Test timed out in 5000ms` | Tests hash and verify real passwords with the production scrypt work factor (N=2^14) for every created user and login. A test that normally takes ~1 s spent most of it in deliberately slow hashing; under parallel load it passed 5 s. | `setHashCostForTests()` in `lib/passwords.ts`, called from `test/setup.ts` (wired in the new `apps/server/vitest.config.ts`): tests use N=2^10. Production parameters are unchanged; verification always reads the parameters stored in the hash. A new test checks a hash with the production parameters still verifies. No timeout was raised. |
| `schedule.test.ts` "run now (no double run)" | second "Run now" returned 200 instead of 409 | A real bug, not only a test problem: duplicate protection keyed on the wall-clock **second**. Two clicks that straddle a second boundary both created a task. | New `runNow()` in `schedule/service.ts`: inside one write transaction, refuse while an earlier run's task is still open (not DONE/FAILED/CANCELLED). The test now also checks that "Run now" works again once that task is closed. |

Verification after the fix: **24 of 24** parallel-stress runs green (four concurrent suites × 6 rounds),
118/118 tests each; typecheck clean.

Remaining timing assumption (not seen failing in any stress run, noted): `runtime.test.ts` "runs a queued task
to DONE" waits a fixed 30 ms for the agent's COMPLETED → IDLE settle timer. Convert to fake timers when that
file is next touched.

### A.2 Recovery, background jobs, persistence, security, deployment

Reviewed. Findings with file references are in [security model §7](SAG_WORLD_SECURITY_MODEL.md#7-current-state-findings-2026-10-30-audit).
Summary of what blocks production:

1. **Secrets in git history** (Gemini key, Telegram token, admin password, dev DB). Rotate; purge history.
2. **Double execution of long agent runs** (lease never renewed, no `lease_owner` guard).
3. **Queue stall after every deploy** (IN_PROGRESS tasks wait out the 15-minute lease).
4. **Login brute-force protection bypassable** behind `TRUST_PROXY=true`.
5. **No off-site backup / restore drill** for the SQLite file.

## Phase overview

```mermaid
flowchart LR
  W0[W0 Production hardening] --> W1[W1 Business-unit core]
  W1 --> W2[W2 Scoped data & isolation]
  W2 --> W3[W3 Provisioning & AI Director]
  W3 --> W4[W4 Agent marketplace & hiring]
  W2 --> W5[W5 Cross-unit requests]
  W4 --> W6[W6 Budgets, KPIs, rollups]
  W5 --> W6
  W2 --> P[P PostgreSQL & multi-instance]
  W6 --> X[X External units onboarding]
  P --> X
  X --> V[V World view (3D/map)]
```

W0 is independent of SAG World and should go first. P can run in parallel with W3–W6 once W2 has settled the
schema, but must finish before X.

## W0 — Production hardening of the current system

Scope: fix §7 blockers and highs; no new features.

- Rotate secrets; history purge (owner decision; coordinated force-push).
- Lease renewal during runs; `lease_owner` guard on all runner writes; re-queue own tasks on stop; boot-time
  orphan recovery and agent status reset; bounded, idempotent shutdown; fatal-error handlers.
- Trusted proxy hop count; DB-backed login throttling per username + IP.
- Chat history per user; knowledge/memory/approval list scoping; SSE scope filter for AI events; Origin check
  on state-changing requests.
- Pre-migration automatic backup (`VACUUM INTO data/backups/…`) in the migration runner; scheduled off-site
  backup; documented restore drill.
- Readiness endpoint (DB, queue lag, bot), structured error tracking.

Acceptance:
- A run that outlives its original lease is never executed twice (test with a short lease).
- After `SIGTERM` mid-run, the task is QUEUED again within one poll interval of the next boot (test).
- Login throttling holds with spoofed `X-Forwarded-For` (test).
- A user cannot read another user's agent chat; an `employee` cannot list other departments' documents (tests).
- Backup restores into a working instance (drill recorded in `DEPLOY.md`).

## W1 — Business-unit core

Scope: tables `business_unit_types`, `business_units`, `unit_policies`, `unit_budgets`, `unit_memberships`;
migration of the existing organisation into unit `hq` ([data model §7](SAG_WORLD_DATA_MODEL.md#7-migration-from-the-current-schema));
`business_unit_id` on all unit-owned tables with composite FKs; read-only unit tree API (`/api/units`).

Reuse: migration runner (FK-off rebuild pattern from 007), `access.ts`, existing seeds.

Acceptance:
- Migration on a copy of the current dev DB: equal row counts, all rows in `hq`, empty `foreign_key_check`.
- The whole existing suite passes without edits to its expectations (HQ behaviour unchanged).
- Composite FK test: a task/agent referencing another unit's department is rejected by the DB.
- Exactly one root unit; depth and parent-type rules enforced.

## W2 — Scoped data access and isolation

Scope: `UnitScope` resolution; every domain read/write on unit-owned tables takes a scope; memberships and
generalised grants in the permission evaluator; unit-scoped routes `/api/units/:unitId/...` with aliases for
existing routes; scoped SSE; knowledge/instructions/memory inheritance (`inherit_down`); agent runs scoped by
task unit; per-unit connector installations (migrated from `connector_secrets`).

Acceptance:
- Leakage matrix test (security model §6) green for every endpoint and every agent tool.
- Scope-required test green.
- An agent in Store A cannot retrieve Dealer B's document even when the query text matches it exactly.
- HQ behaviour unchanged for existing users (existing tests).

## W3 — Unit provisioning and the AI Director

Scope: `provisionBusinessUnit` (one transaction, idempotency key); department templates per type; human
director assignment or invitation (`user_invitations`, accept flow); automatic primary Director agent per unit;
unit-level orchestrator (replaces the global `ORCHESTRATOR_DEPARTMENT`); human-only guard (`assertHuman`);
web UI: units list/tree, create unit wizard, unit overview.

Acceptance:
- Creating a unit produces exactly: unit, policy, budget, departments, one director agent, director membership or
  invitation, audit entry — or nothing at all on failure (fault-injection test at each step).
- Repeating the call with the same key returns the same unit.
- Every human-only operation rejects agent and system actors (test).
- The unit's director agent plans only inside its unit.

## W4 — Agent marketplace and hiring

Scope: `agent_templates`, `agent_template_versions`, `agent_hire_requests`; catalog of ten templates (director,
sales, marketing, finance, HR, inventory, procurement, support, logistics, data analyst) with honest
instructions and tool lists; `request_hire` agent tool; approval card (web + Telegram) for the human director;
policy auto-approve path; agents created from templates through the existing `createAgent`.

Acceptance:
- Every hard cap (max agents, budget, allowed models/templates, pending requests, cool-down) rejects with a
  recorded reason (tests).
- A hired agent cannot hire; no one can hire a second director (tests).
- A hire never grants a tool outside the template's list or a connector not installed in the unit.

## W5 — Cross-unit requests

Scope: `unit_requests`, `unit_request_events`, `unit_request_routes`, `unit_links`; kinds `assignment`,
`stock_request`, `production_availability`, `transfer_request`, `information_request` with zod schemas; requester
task waits on the request (dependency semantics); fulfilling task created on accept inside the receiving unit;
progress/result summary propagation; human acceptance where the route requires it; agent tool to *draft*
requests only.

Acceptance:
- HQ → dealer assignment: the dealer splits it into internal subtasks; HQ sees status, progress and result
  summary only — never the subtasks, comments or attachments (test).
- Store → warehouse stock request routed only to the linked warehouse; an unlinked one is refused.
- A request can't link tasks from the wrong units (DB-level test).
- Agents cannot accept requests or move them past `DRAFT` where a human is required.

## W6 — Budgets, KPIs and rollups

Scope: budget gate in the runner (pause/notify on exhaustion); `kpi_definitions`, `kpi_values` (agent values
`PROPOSED` until confirmed); aggregate-only rollup endpoints for ancestors (KPIs, AI spend, request SLAs,
workload counts); HQ dashboard.

Acceptance:
- A unit at its budget stops starting AI work and its human director is notified; other units are unaffected.
- Rollup endpoints return aggregates only (schema test) and only for units in the caller's subtree.
- Unconfirmed agent KPI values never appear in rollups.

## P — PostgreSQL and multi-instance

Scope: async `Db` port (all domain functions `async`; mechanical refactor, done module by module behind the
existing tests); PostgreSQL adapter and dialect-specific migrations; RLS policies on every unit-owned table;
job claiming with `FOR UPDATE SKIP LOCKED`; cross-instance events via `LISTEN/NOTIFY`; attachments and avatars
to object storage; DB-backed limiter and OAuth state; API and worker as separate services.

Migration and rollback strategy:
1. Freeze writes (maintenance mode), take a SQLite backup.
2. Export → import with a verification script: per-table row counts, per-table checksums of canonicalised rows,
   FK and RLS checks, a smoke suite against the new DB.
3. Switch traffic; keep the SQLite file and the old deployment untouched for the rollback window (7 days).
4. Rollback inside the window = point the service back to SQLite; writes made on PostgreSQL in between are
   exported by the same script in reverse (tested in rehearsal). After the window, the SQLite path is retired.
5. Rehearse the full sequence on a copy of production at least once before the real cut-over.

Acceptance:
- Full test suite green on both adapters in CI.
- Leakage matrix green with RLS on, and also green with the application filter deliberately removed (RLS alone
  holds).
- Two API instances + one worker: no double execution, events reach clients on either instance.

## X — External units onboarding

Scope: invitations to people outside SAG; `is_external` defaults (aggregate-only HQ visibility unless
agreed); per-unit Telegram groups; per-unit connector installs; onboarding checklist; data-processing note.

Acceptance: pilot with one dealer and one store; leakage matrix extended with their real roles; security review
before go-live.

## V — World view

Scope: map/3D presentation of the unit tree using `geo`, status, KPIs and live activity; reuses the campus scene
for HQ. Strictly a view over existing APIs.

## Decisions needed from the owner before W1

See [architecture §11](SAG_WORLD_ARCHITECTURE.md#11-open-questions-for-review): dealer legal status and default
HQ visibility; regions; source of truth for stock/production; budget currency/period; auto-approve for hires.
