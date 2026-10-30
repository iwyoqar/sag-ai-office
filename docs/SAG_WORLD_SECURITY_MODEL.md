# SAG AI WORLD — Security model

Status: **proposal, revised with the owner's decisions of 2026-10-30, awaiting review.** Extends the current model
(`apps/server/src/domain/access.ts`, `lib/auth.ts`, `connectors/hub.ts`). Section 8 lists findings in the
**current** code; the W0 phase fixes the blockers among them.

## 1. Threats

| # | Threat | Example |
|---|---|---|
| T1 | Cross-unit data leakage | Store A's agent retrieves Dealer B's price agreement through knowledge search |
| T2 | Group over-reach into an independent dealer | HQ reads a dealer's sales without a data-sharing agreement |
| T3 | Privilege escalation by an agent | Director agent creates a human account or grants itself permissions |
| T4 | Runaway autonomy | Agents hire agents that create tasks that create tasks; budget burnt overnight |
| T5 | Prompt injection through data | A document tells the agent to send stock data to an outside address |
| T6 | Confused deputy | A group-level agent with wide read scope is used by a store user to fetch another store's data |
| T7 | Insider over-reach | A department head in one unit reads another unit's financials |
| T8 | Credential exposure | Tokens or `.env` secrets leak via logs, git history or another unit |
| T9 | Duplicate side effects | A re-run agent sends the same e-mail twice |

## 2. Principals

| Principal | Stored as | Authenticates by | Can ever |
|---|---|---|---|
| Person | `users` | password session (exists) | what memberships, grants and agreements allow |
| AI agent | `agents` | runs only inside the worker; no login, session or API token | tools within its unit scope and its template's tool list |
| System | `SYSTEM` actor (exists) | — | scheduler, sweeps, steps of an operation a person started |

**Human-only operations** — refused inside the domain function (`assertHuman(actor)`), not only by not offering a
tool: create/invite/activate/deactivate/archive people; change roles, memberships, grants; create/move/suspend
units; change unit policy, hiring policy or budget; approve template versions; decide hire requests under
APPROVAL/RESTRICTED; sign or revoke data-sharing agreements; accept cross-unit requests that require a human;
decide agent write approvals; confirm KPI values; connect/disconnect connectors.

## 3. Permission model

### 3.1 Evaluation

```
allowed(person, permission, unit) =
     platform_admin(person)                                   -- break-glass, every use audited with a reason
  OR membership/grant on `unit` itself with `permission`
  OR membership/grant with include_descendants on an ancestor node of `unit`,
       AND business-type rule (§3.3) allows that ancestor role to reach `unit` for this data class
  OR an active data_sharing_agreement(unit → a node the person holds a role on) covers the data class and level
```

- **Tree position alone never grants access**; subtree reach needs `include_descendants`, and for SUBSIDIARY and
  INDEPENDENT_DEALER units it is further limited by §3.3.
- **Agents**: `allowed(agent, p, unit)` only for its own unit and only for permissions in its template capability
  set; never subtree, never agreements. Agents reach other units only by drafting UnitRequests.
- Existing department scoping (`employees:manage_dept`, `tasks:assign_dept`, `tasks:read_team`, `deptsFor()`)
  keeps its meaning inside a unit.

### 3.2 Roles (defaults, stored in the DB)

| Role | Held at | Key permissions |
|---|---|---|
| `platform_admin` | global | everything; audited |
| `group_executive` | GROUP, `include_descendants` | `units:read`, `rollups:read`, `requests:send` (assignment), `agreements:approve`; detail reach per §3.3 |
| `group_finance` | GROUP, `include_descendants` | `rollups:read`, `finance:read`, `budget:manage` for SAG_BRANCH units, `fx:manage` |
| `regional_manager` | REGION, `include_descendants` | `units:read`, `rollups:read`, `requests:send`, `units:create` in the region |
| `unit_director` | UNIT | `employees:manage_unit`, `employees:invite`, `tasks:*`, `agents:manage`, `agents:hire`, `agents:hire_approve`, `hiring_policy:manage`, `brain:manage`, `connectors:manage`, `budget:read`, `kpi:confirm`, `requests:send`, `requests:accept`, `agreements:sign`, `audit:read_unit` |
| `department_head`, `employee`, `viewer` | UNIT | as today, inside the unit |

### 3.3 Business-type rules (decision 2/3)

| Ancestor role reaches … | SAG_BRANCH | SUBSIDIARY | INDEPENDENT_DEALER |
|---|---|---|---|
| unit profile (name, type, region, status) | ✓ | ✓ | ✓ |
| request records it is party to | ✓ | ✓ | ✓ |
| aggregates (KPIs, AI usage, task counts, people counts) | ✓ | ✓ | only with an AGGREGATE agreement |
| detail (tasks, documents, people records, finance) | ✓ with `include_descendants` role | only with a DETAIL agreement for that data class | only with a DETAIL agreement for that data class |
| connectors, credentials | never (metadata only to own unit) | never | never |
| agent conversations, runs, tool I/O | audited read for `platform_admin` only | same | same |

### 3.4 Data-class rules inside and across units

| Data | Owner unit | Others |
|---|---|---|
| Employee records | existing person rules (self, manager, dept head, `employees:read_all` **within the unit**) | directory card only if a role reaches the unit |
| Tasks, comments, attachments, deliverables | existing task rules, **AI tasks included** (W0.2) | via §3.3 |
| Agent conversations (`chat_messages`) | the person who chatted; unit director audited read | none |
| Realtime events | filtered by the same rules as the underlying record | none |
| Knowledge | unit + share-down from ancestors (`SHARE_DOWN`), group documents published to dealers (`DEALERS`) | via DETAIL agreement |
| Connector installations and results | metadata to `connectors:manage`; tool results follow the task | none |
| Notifications | addressee only (exists) | none |
| Calendar (routines, scheduled tasks) | same as tasks | none |
| Reports / stats | `budget:read`/`finance:read`/directors; others see only their own work | aggregates via §3.3 |
| Audit log | `audit:read_unit` | none |

## 4. Enforcement layers (SQLite, no RLS)

```mermaid
flowchart TD
  R[HTTP route / SSE / agent tool call] --> A[1. Resolve principal + UnitScope once]
  A --> B[2. Route guard: allowed(principal, permission, unit) before any query]
  B --> C[3. Domain function requires scope; SQL always filters by business_unit_id IN scope]
  C --> D[4. DB constraints: composite FKs, CHECKs, triggers — cross-unit references cannot be written]
  C --> E[5. Tests: leakage matrix, scope-required, human-only, tool catalog — CI gate]
  C --> F[Audit + events tagged with business_unit_id]
```

SQLite has no row-level security, so layer 5 is mandatory and blocks merges: a leakage-matrix failure is a
release blocker. Additional compensations: no raw SQL in route handlers (lint check), one place that builds the
scope predicate, read-audit for detail access across units, and periodic export of cross-unit access logs.

## 5. Agent-specific controls

1. Scope fixed at claim time from the task's unit; the model never chooses a unit id. Tool arguments naming a
   unit, department, agent, task or document are validated against the scope.
2. Retrieval filtered in SQL (unit + share-down), not in the prompt.
3. Tools = template tool list ∩ grants on installations of the agent's unit. Write tools keep the approval flow;
   approvers are humans of the same unit.
4. Hiring per policy (AUTO / APPROVAL default / RESTRICTED) with every check of architecture §7.2 re-run at decision
   time; the hire tool is not offered under RESTRICTED and never to non-director agents.
5. Budgets and loop limits enforced server-side before each action.
6. Prompt-injection posture as today (data in tags, rules in system prompt, writes need a person) plus outbound
   recipient/domain allow-lists per installation.
7. Side effects are idempotent (W0.3): approval-gated writes are claimed once; an execution interrupted mid-call
   is marked `unknown` and needs a human decision instead of an automatic retry.

## 6. Proxy, sessions and transport

- **Client IP**: forwarded headers are trusted only from configured proxies (`TRUSTED_PROXIES`: CIDR list or hop
  count). With Vercel → Render, the only address the app can trust is the one Render's load balancer reports
  (one hop); everything left of it is client-controlled when the API is called directly. Login throttling
  therefore keys primarily on the **account** (DB-stored, exponential backoff, lock-out notice) and secondarily on
  the trusted client IP.
- Sessions: hashed tokens (exists), absolute TTL (exists) + idle timeout, `__Host-` cookie name in production,
  sessions and SSE streams end on deactivation/password change.
- CSRF: state-changing requests must carry an `Origin` (or `Referer`) equal to the app origin; `SameSite=Lax`
  stays as a second layer.
- CORS: none needed (same-origin through the Vercel proxy); the API refuses cross-origin browser requests.

## 7. Verification (CI gates)

- **Leakage matrix**: GROUP, two REGIONs, a SAG_BRANCH, a SUBSIDIARY and an INDEPENDENT_DEALER, one row of every
  unit-owned table each; for every endpoint, SSE stream and agent tool, as each principal type, only permitted
  rows return. Includes agreement on/off/expired cases.
- **Scope-required**, **human-only**, **tool catalog** (no tool maps to a human-only operation), **composite FK**,
  **hiring policy** (AUTO/APPROVAL/RESTRICTED × each failing check), **budget/loop** tests.
- **User-level isolation (W0.2)**: another user's conversations, events, tasks, employee details and restricted
  documents are unreachable.

## 8. Current-state findings (audit 2026-10-30, updated)

Severity: **B** blocker · **H** high · **M** medium · **L** low.

| Sev | Finding | Where | Planned fix |
|---|---|---|---|
| **B** | Secrets in git history. Status 2026-10-30 14:30: GitHub `main` was rewritten (21 commits scanned: no secret files or token patterns), **but** GitHub still serves the old commit `d3605b2` by its SHA (verified through the API), and this computer's local `main` still contains it. The exposed credentials must be treated as compromised until rotated. | git | W0.1: rotate; GitHub Support request to purge cached/dangling objects; re-clone or reset every working copy |
| **B** | Agent run lease (15 min) never renewed; runner writes not fenced by lease owner → long runs execute twice | `agents/runner.ts:36,444`, `domain/tasks.ts:366` | W0.3 |
| **B** | After deploy/crash, IN_PROGRESS tasks wait out the 15-min lease; one task per agent stalls the agent's queue | `index.ts`, `runner.stop()` | W0.4 |
| **B** | Login throttling bypassable with forged `X-Forwarded-For` under `TRUST_PROXY=true`; in-memory limiter | `config.ts:19`, `routes/auth.ts:18`, `lib/auth.ts:93` | W0.5 |
| **B** | No off-site backup, no tested restore | `DEPLOY.md` | W0.6 |
| H | `GET /api/agents/:id/chat` returns every user's conversation with that agent | `routes/runtime.ts:28` | W0.2 |
| H | SSE sends every AI event (task titles, stages, agent ids) to every logged-in user | `routes/events.ts` | W0.2 |
| H | AI tasks, their deliverables and results are visible to anyone with `tasks:read` (`canSeeTask` returns true for non-human tasks) | `domain/access.ts:107` | W0.2 (needs owner confirmation of the new rule) |
| M | Knowledge list/search and memory list company-wide for any `agents:read` holder | `routes/brain.ts:34,65,102` | W0.2 |
| M | Approval list exposes tool payloads to anyone with `tasks:read` | `routes/brain.ts:131` | W0.2 |
| M | Stats (usage, cost, per-agent activity) readable by anyone with `tasks:read` | `routes/org.ts:24` | W0.2 |
| M | Connector activity log (tool inputs/outputs of every agent, e.g. e-mail bodies) readable by anyone with `tasks:read` | `routes/connectors.ts:28`, `connectors/hub.ts:257` | W0.2 |
| M | No CSRF token / Origin check | `routes/auth.ts:30` | W0.7 |
| M | scrypt N=2^14 (below current OWASP guidance) | `lib/passwords.ts` | W0.7: raise with `maxmem`, rehash on login |
| M | Generated admin password logged when `ADMIN_PASSWORD` empty | `index.ts:31` | W0.7 |
| M | `render.yaml` lacks `PUBLIC_URL`, `SECRETS_KEY`, `GOOGLE_*` | `render.yaml` | W0.7 |
| L | Approved tool execution interrupted by a crash stays `running` forever | `connectors/hub.ts:233` | W0.3 (`unknown` + human decision) |
| L | Shutdown not bounded; no fatal-error handlers | `index.ts:97` | W0.4 |
| L | Routine run and its task not in one transaction | `schedule/service.ts` | W0.4 |
| L | SSE stays open after logout/deactivation | `routes/events.ts` | W0.2 |
| L | Health check does not check DB/queue/bot/backup age | `app.ts:117` | W0.7 |

Already good: hashed session tokens, httpOnly cookies, session revocation on password change, constant-time
login path, status-guarded atomic task transitions, approval claimed atomically before a write tool runs,
idempotent scheduler/notifications/Telegram updates, transactional migrations with FK check, log/audit redaction,
upload limits and zip-bomb guards, forced attachment downloads, constant-time Telegram webhook secret, no SQL
injection found.
