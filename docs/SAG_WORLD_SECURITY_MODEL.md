# SAG AI WORLD — Security model

Status: **proposal, awaiting review**. Extends the current model (`apps/server/src/domain/access.ts`,
`lib/auth.ts`, `connectors/hub.ts`). Section 7 lists findings in the **current** code from the 2026-10-30
audit; several are blockers for production regardless of SAG World.

## 1. Threats this model is built against

| # | Threat | Example |
|---|---|---|
| T1 | Cross-unit data leakage | Store A's agent retrieves Dealer B's price agreement through knowledge search |
| T2 | Privilege escalation by an agent | Director agent creates a human account or grants itself `employees:manage_all` |
| T3 | Runaway autonomy | Agents hire agents that create tasks that create tasks; budget burnt overnight |
| T4 | Prompt injection through data | A document or e-mail tells the agent to send stock data to an outside address |
| T5 | Confused deputy across units | HQ agent with wide read scope is asked by a store user to fetch another store's data |
| T6 | Insider over-reach | A department head in one dealer reads HQ financials |
| T7 | Credential exposure | Connector tokens or `.env` secrets leak via logs, git history, or another unit |

## 2. Principals and identity

| Principal | Stored as | Authenticates by | Can ever |
|---|---|---|---|
| Person | `users` | password session (existing), later SSO | everything their memberships and grants allow |
| AI agent | `agents` | runs only inside the worker; no login, no session, no API token | act through tools within its unit scope and the template's tool list |
| System | `SYSTEM` actor (exists) | — | scheduler, sweeps, provisioning steps a person started |

**Human-only operations** — enforced in the domain function itself (`assertHuman(actor)`), not only by not
exposing a tool:

- create, invite, activate, deactivate or archive a person; change anyone's roles, memberships or grants
- create, move, suspend or archive a business unit; change unit policy or budget
- approve or reject hire requests (except the pre-approved policy path, which is configured by a human)
- accept a cross-unit request whose route says `requires_human_accept`
- decide approvals of agent write actions; confirm KPI values; connect or disconnect connectors

There is no tool in the agent catalog that maps to any of these, and a test enumerates the tool catalog to keep it
that way (§6).

## 3. Permission model

### 3.1 Evaluation

```
allowed(principal, permission, unit) =
     platform_admin(principal)                                     -- break-glass, audited
  OR ∃ membership m: m.user = principal ∧ permission ∈ role(m.role)
                     ∧ (m.unit = unit ∨ (m.include_descendants ∧ unit ∈ subtree(m.unit)))
  OR ∃ grant g: g.user = principal ∧ g.permission = permission
                ∧ (g.unit = unit ∨ (g.include_descendants ∧ unit ∈ subtree(g.unit)))
                ∧ (g.department IS NULL ∨ resource.department = g.department)
```

- Being a member of an **ancestor** unit gives nothing in a descendant by itself. Subtree reach always comes
  from an explicit `include_descendants` membership or grant.
- Agents: `allowed(agent, p, unit)` is true only for `unit = agent.business_unit_id` and `p` in the agent's
  template capability set; never subtree, never another unit. Agents reach other units only by drafting a
  UnitRequest.
- Department-scoped permissions (existing `employees:manage_dept`, `tasks:assign_dept`, `tasks:read_team`) keep
  their meaning inside a unit; the current `deptsFor()` logic is reused with the unit added to the key.

### 3.2 Roles (defaults; stored in the DB, editable by platform admins)

| Role (membership) | Key permissions in its unit |
|---|---|
| `unit_director` | `units:read`, `units:manage_policy` (within caps set by the parent), `employees:manage_unit`, `tasks:*`, `agents:manage`, `agents:hire_approve`, `brain:manage`, `connectors:manage`, `budget:read`, `kpi:confirm`, `requests:send`, `requests:accept`, `audit:read_unit` |
| `department_head` | as today, scoped to departments they head inside the unit |
| `employee` | `tasks:read`, `tasks:create`, `agents:read`, `requests:read` |
| `viewer` | read-only on tasks and agents of the unit |
| `regional_manager` (usually `include_descendants`) | `units:read`, `rollups:read`, `requests:send` (assignment), `kpi:read` |
| `hq_finance` (HQ, `include_descendants`) | `rollups:read`, `budget:manage` for descendants, `finance:read` |
| `platform_admin` (global) | everything, every use audited with reason |

New permissions: `units:create`, `units:manage`, `units:manage_policy`, `units:read`, `employees:manage_unit`,
`employees:invite`, `agents:hire_request`, `agents:hire_approve`, `connectors:manage`, `budget:read`,
`budget:manage`, `kpi:read`, `kpi:confirm`, `rollups:read`, `requests:read`, `requests:send`, `requests:accept`,
`finance:read`, `audit:read_unit`.

### 3.3 Data-class rules

| Data | Owner sees | Ancestor with `rollups:read` | Ancestor with subtree grant | Other units |
|---|---|---|---|---|
| Unit profile, status, type | ✓ | ✓ | ✓ | name + type only, if a route links them |
| Employee records | per existing person rules | headcount, workload level counts | directory card | ✗ |
| Tasks, comments, attachments | per existing task rules | counts by status, overdue counts | ✓ (read) | ✗ |
| UnitRequest record + its events | ✓ (as sender or receiver) | ✓ if sender/receiver in subtree | ✓ | ✗ |
| Knowledge documents | ✓ | ✗ | ✓ (read) | only ancestor docs marked `UNIT_AND_DESCENDANTS` flow **down** |
| Connector installations | metadata ✓, secrets never displayed | ✗ | metadata | ✗ |
| Financial data (budget, spend, KPIs with money) | ✓ with `finance:read`/`budget:read` | confirmed rollups | ✓ with `finance:read` | ✗ |
| Agent messages, chat, runs, tool I/O | ✓ (chat: own conversations only) | counts, cost | ✓ (audited read) | ✗ |
| Reports / deliverables | ✓ | the ones attached to a UnitRequest result | ✓ | ✗ |
| Audit log | `audit:read_unit` | ✗ | ✓ with `audit:read_unit` on subtree | ✗ |

Rollups are computed by queries that return aggregates only (`GROUP BY business_unit_id` with counts/sums);
they are separate endpoints, so a bug in a rollup cannot return raw rows.

## 4. Enforcement layers

```mermaid
flowchart TD
  R[HTTP route / agent tool call] --> A[1. Resolve principal + UnitScope once]
  A --> B[2. Route guard: allowed(principal, permission, unitId) before any query]
  B --> C[3. Domain function requires scope; SQL always has business_unit_id IN scope]
  C --> D[4. Composite FKs: rows cannot reference another unit's department/agent/task]
  D --> E[5. PostgreSQL RLS: app.unit_ids session setting; policy on every unit-owned table]
  C --> F[Audit + events tagged with business_unit_id]
```

Layers 1–4 come with the BU phase (on SQLite). Layer 5 comes with the PostgreSQL phase and must be in place before
external units get accounts. RLS uses `SET LOCAL app.unit_ids = '…'` per transaction; the application role has no
`BYPASSRLS`; migrations run as a separate owner role.

## 5. Agent-specific controls

1. **Scope is fixed at claim time** from the task's `business_unit_id`; the LLM never chooses a unit id. Tool
   arguments that name a unit, department, agent, task or document are validated against the scope.
2. **Retrieval is filtered in SQL**, not in the prompt: knowledge search = own unit + ancestors' `inherit_down`
   documents. Today `searchKnowledge` already filters by department; the unit filter is added in the same query.
3. **Tools** = template tool list ∩ grants on installations in the agent's unit. Write tools keep the existing
   approval flow; approvals are routed to approvers **in the same unit**.
4. **Budgets and loops**: per-task limits (exist), per-unit period budget, per-unit concurrency, AI task creation
   rate, task depth, hire-request rate, request fan-out. All limits are checked server-side before the action.
5. **Prompt-injection posture** stays as today (data in tags, rules in system prompt, write actions need a person)
   and gains: outbound tools may only target recipients/domains allow-listed for the unit installation.
6. **No agent-to-agent free chat** across units. Inside a unit, agent messages stay task-bound (existing
   `agent_messages` with `task_id`).

## 6. Verification (tests that must exist before a phase is called done)

- **Leakage matrix test**: two sibling units (Store A, Dealer B) and HQ, seeded with one row of every unit-owned
  table each. For every list/get endpoint and every agent tool, as each principal, assert that only permitted rows
  come back. Runs in CI on SQLite and (later) on PostgreSQL with RLS enabled.
- **Scope-required test**: fails if a domain function reading a unit-owned table can be called without a
  `UnitScope`.
- **Human-only test**: every human-only operation called with an agent or system actor throws `forbidden`.
- **Tool catalog test**: no tool maps to a human-only operation; every tool declares read/write and unit binding.
- **Composite-FK test**: inserting a task/agent/grant that references another unit's row fails at the DB.
- **Budget/loop tests**: exceeding each limit stops work and notifies the right human; nothing retries forever.

## 7. Current-state findings (2026-10-30 audit)

Severity: **B** = blocker before production use · **H** high · **M** medium · **L** low.

| Sev | Finding | Where | Fix |
|---|---|---|---|
| **B** | Live Gemini key, Telegram bot token, admin password and the dev DB (password hashes, audit/Telegram logs) are in GitHub history (commit `d3605b2`); removed from the tree in `b4462c7` | git history | rotate all three now; then purge history (`git filter-repo`) and force-push, coordinated with everyone who has a clone |
| H | Agent run lease (15 min) is never renewed, and runner writes don't check `lease_owner`; a run longer than the lease is re-queued and executed twice | `agents/runner.ts:36,444`, `domain/tasks.ts:366` | renew the lease while the run is working; add `lease_owner = ?` to the runner's checks and writes |
| H | Shutdown or deploy leaves tasks IN_PROGRESS until the lease expires, and one task per agent means that agent's queue stalls for up to 15 min | `index.ts`, `runner.stop()` | on stop, re-queue own leased tasks; on boot (single instance), re-queue orphaned IN_PROGRESS and reset agent status |
| H | Login rate limit can be bypassed: `TRUST_PROXY=true` trusts any `X-Forwarded-For`, and the limiter is in memory | `config.ts:19`, `routes/auth.ts:18`, `lib/auth.ts:93` | trust a fixed hop count / known proxy ranges; add a per-username limit with backoff, stored in the DB |
| M | `GET /api/agents/:id/chat` returns every user's conversation with that agent | `routes/runtime.ts:28` | filter on `user_id` (the POST already does) |
| M | Knowledge search/list and memory list are company-wide for any `agents:read` holder (includes `employee`, `viewer`) | `routes/brain.ts:34,65,102` | scope by the user's department/unit unless `brain:manage` |
| M | Approval list exposes tool payloads (e.g. e-mail bodies) to anyone with `tasks:read` | `routes/brain.ts:131` | restrict to approvers / task participants |
| M | Realtime stream sends every AI event to every user | `routes/events.ts` | filter by scope (becomes mandatory with units) |
| M | No CSRF token / Origin check; protection rests on `SameSite=Lax` | `routes/auth.ts:30` | reject state-changing requests whose `Origin` is not the app origin |
| M | Password hashing scrypt N=2^14 (below current OWASP guidance N=2^17) | `lib/passwords.ts` | raise N with `maxmem`, rehash on login (verification already reads params from the hash) |
| M | Generated admin password printed to logs when `ADMIN_PASSWORD` is empty | `index.ts:31` | print once to stdout only on first boot locally; require it in production |
| M | No off-site backups; only Render disk snapshots (not verified) | `DEPLOY.md` | scheduled `VACUUM INTO` → object storage, restore drill |
| M | `render.yaml` lacks `PUBLIC_URL`, `SECRETS_KEY`, `GOOGLE_*` | `render.yaml` | add as unsynced secrets; refuse boot if a connector is enabled without its key |
| L | Shutdown not awaited/bounded; no `unhandledRejection` handler | `index.ts` | await active runs with a timeout; idempotent shutdown; log and exit on fatal errors |
| L | Routine run and its task are written outside one transaction | `schedule/service.ts:153` | wrap in a transaction (savepoint-aware) |
| L | SSE stays open after logout/deactivation; no per-user stream cap | `routes/events.ts` | re-check session periodically; cap streams per user |
| L | Health check does not check DB, queue lag or bot | `app.ts:117` | add readiness endpoint |

Already good (keep): hashed session tokens, httpOnly cookies, sessions revoked on password change, constant-time
login path, status-guarded atomic task transitions, idempotent scheduler/notifications/Telegram updates,
transactional migrations with FK check, redaction in logs and audit, upload limits and zip-bomb guards, forced
attachment downloads, constant-time Telegram webhook secret, no SQL injection found.
