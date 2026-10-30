# W0 — Production hardening report

Date: 2026-10-30. Scope: SAG AI WORLD W0 (security & isolation, reliable execution, trusted proxies, SQLite
reliability, off-site backups, verification). SQLite kept (owner decision). BusinessUnit work (W1) not started.

**State: implemented and tested in the working tree — nothing committed, pushed or deployed.**
**Production readiness is not claimed**: credentials are not rotated yet, and no real off-site upload + restore has
been performed.

## 0. Integration with the store-network import (`27cfb2e`)

While W0 was in progress, the unit/store import (W1–W3 subset, `010_org_tree.sql`) landed on GitHub. W0 was rebased
onto it at the owner's request (`git pull --rebase origin main`). Resolution:

- W0 migrations renumbered to **011–014** so they run after `010_org_tree.sql`; the full chain 001–014 applied cleanly
  to a copy of the dev database (foreign-key check empty, integrity ok, all 22 tasks in `hq`).
- Task access: W0's single AI/human rule combined with the import's HQ scoping — `visibleTaskSql` = HQ unit **and**
  the viewer's rule; `canSeeTask` / `canManageTask` additionally refuse any task outside `hq` (defence in depth behind
  `app.ts`'s by-id hook; covered by a new test and a mutation check).
- Stats: HQ scoping and per-viewer visibility both applied. SSE: the import's unit filter kept in front of W0's rules.
- Login: the import's activation-status check kept, with W0's work-factor-matched dummy hash.
- Account activation (`/api/auth/activate`) moved from the removed in-memory limiter to the database throttle (failed
  attempts per trusted client address only, so nobody can lock activation for everyone).

## 1. Completed workstreams

Each audit finding was re-checked against the current code before changing it; all were still present.

### W0.1 Security and data isolation (backend-enforced)

| Area | Defect found in current code | Change |
|---|---|---|
| Tasks (AI) | `canSeeTask` returned `true` for every non-human task; `/api/tasks` listed all AI tasks to any `tasks:read` holder | one rule for AI and human tasks (`domain/access.ts`): creator, assignee/reviewer/assigner, department heads (incl. department-scoped grants), whoever is responsible for an ancestor (parent creators see subtask progress), unit-wide readers. List uses the same predicate in SQL (`visibleTaskSql`, now without the human-only anchor) |
| `tasks:read_all` | meant "everything" | documented and implemented as "within the unit" (`readsAllTasks`); today there is one unit (`hq` in W1) |
| Task detail | run records, tool list and approval payloads shown to every viewer; subtasks of other departments listed | runs/tools need `ai_runs:read`; approval payloads need `tool_io:read` or `tasks:manage`; subtasks filtered; `restricted` flags tell the UI |
| Assignee parent context | assignee saw nothing of a parent they could not see | `parent` carries title, description, priority, deadline, status, owner (`contextOnly`) — not comments, files or siblings |
| Agent chat | `GET /api/agents/:id/chat` returned every user's conversation | own conversation only; `?userId=` needs `agent_chat:read_others` and is audited |
| AI events (SSE) | every AI event to every user | delivered only if the user can see the event's task; connector events without a task only to `brain:manage`; the stream re-checks the session every 20 s and closes on logout/deactivation |
| Connector activity log | every agent's tool inputs/outputs (e.g. e-mail bodies) to `tasks:read` | entries limited to visible tasks (all for `brain:manage`); inputs/outputs only with `tool_io:read`; secret-looking fields always redacted |
| Approvals list | all payloads to `tasks:read` | approvers (`tasks:manage`) see all; others only requests on visible tasks, payload hidden without `tool_io:read` |
| Statistics | company-wide counts and cost to `tasks:read` | counts computed over the caller's visible tasks; tokens/cost need `budget:read` (`usageHidden` flag; UI shows "–") |
| Agent profile | recent tasks, errors and usage of any agent | task lists follow task visibility; usage needs `budget:read` |
| Knowledge / memory | list, search and memory company-wide | company-wide items + own/headed departments unless `brain:manage`; a non-manager cannot search another department; review queue only for managers |
| Employee data | — (existing person rules) | unchanged; covered by existing people tests and the new parent-context test |

New permissions `agent_chat:read_others`, `ai_runs:read`, `tool_io:read`, `budget:read` (migration 011; seeded for new
databases): admin holds all; director holds `ai_runs:read`, `tool_io:read`, `budget:read`; nobody else by default.

Agent tools were reviewed: knowledge search is scoped to the agent's department; `list_company_people` returns the
directory card (name, title, department), which every member of the organisation may see — to be re-scoped per unit in W1.

### W0.2 Agent execution reliability

| Defect | Change |
|---|---|
| 15-minute lease never renewed; a longer run was re-queued and executed twice | lease 90 s (configurable), renewed every 30 s by an atomic, fenced `UPDATE` (`renewLease`); a failed renewal aborts the run |
| Runner writes not fenced (`assertStillMine` checked only status + agent) | every claim increments `tasks.lease_epoch`; stage, attempt counter, deliverable, result, failure and subtask creation are written only under `lease_owner + lease_epoch` (checked **inside** the write transaction) |
| `fail()` could mark a task FAILED after another worker took it over | only the lease holder can fail a task |
| No execution record of which claim produced a run | `agent_runs.worker_id`, `lease_epoch`, `end_reason` (`succeeded`, `retryable_error`, `final_error`, `aborted`, `lost_lease`, `shutdown`, `orphaned`) |
| Duplicate side effects from re-runs | identical pending write actions share one approval (`tool_executions.idempotency_key` + partial unique index); approved actions still run once (atomic claim, existing); an approved action interrupted mid-call is marked `unknown` at startup and never retried automatically |
| Crash loops | recovery fails a task that has used `max_attempts` instead of re-queueing it forever |

Exactly-once execution of external side effects is **not** claimed: leases bound overlap, fencing makes overlap
harmless for our own state, idempotency keys and explicit states (`pending_approval → running → succeeded/failed/unknown`)
handle external actions.

### W0.3 Trusted proxy security

| Defect | Change |
|---|---|
| `TRUST_PROXY=true` → Fastify trusted **any** `X-Forwarded-For`; calling the Render URL directly let a client pick its IP | `TRUSTED_PROXIES` = hop count or IP/CIDR list; default none; `true` is refused at startup; legacy `TRUST_PROXY=true` maps to 1 hop; `render.yaml` uses `TRUSTED_PROXIES=1` |
| In-memory limiter keyed on `ip:username`, reset on restart | DB-backed `login_throttle` (migration 013): per account 5 failures → exponential lock 30 s … 15 min (independent of IP); per trusted client IP 30 failures / 15 min; `Retry-After`; audit `auth.login_throttled`; pruning |
| Unknown usernames verified against a hard-coded production-cost dummy hash | dummy hash derived from the current work factor (same production timing; tests no longer pay production cost) |

### W0.4 SQLite reliability

- Reviewed: WAL, `busy_timeout` 5 s, `BEGIN IMMEDIATE` for every write transaction (no read→write upgrade deadlocks, so
  SQLite's busy handler is the retry policy — no extra retry layer added), synchronous API (no awaits inside
  transactions), short transactions (no LLM/network calls inside any `db.tx`).
- `db.tx` now refuses an `async` body (it would have committed before its awaits) and rolls back; ROLLBACK only when a
  transaction is still open; slow write transactions (> 250 ms) are logged.
- `Db.close()` checkpoints the WAL (`TRUNCATE`) and is idempotent; configurable `busyTimeoutMs`.
- Graceful, bounded (20 s), idempotent shutdown; fatal-error handlers; connection closed last.
- Backup consistency: `VACUUM INTO` (transactionally consistent copy while serving).
- Synchronous DB dependency inventory (for the record, no change needed with SQLite): 26 modules, ~360 call sites.
- Deployment constraint documented (DEPLOY.md §5): one server process per database file; a second worker only on the same
  host and disk.

### W0.5 Off-site backup and restore

Implemented (`apps/server/src/backup/`), no new dependencies:

- snapshot (`VACUUM INTO`) → `integrity_check` → gzip → AES-256-GCM with `BACKUP_KEY` (separate from `SECRETS_KEY`; key id
  in the authenticated header; old keys configurable for restores after rotation)
- upload object + manifest (sha256, bytes, schema version, row counts) to **owner-configured** storage: S3-compatible
  (AWS SigV4 signer written with `node:crypto`, verified against AWS's two published signature examples) or a directory
- verification by restore after every upload (download → checksum → decrypt → gunzip → open → integrity → row counts);
  a run is `verified` only then
- retention (default 48 hourly / 30 daily / 12 monthly) with pruning of objects and manifests
- `backup_runs` table (migration 014) + audit events `backup.created/verified/failed/pruned/restored`; credentials never
  logged; S3 errors report status and S3 error code only
- CLI `npm run backup -- now | list | verify <key> | restore <key> <new-file>` (restore refuses to overwrite)
- automatic local pre-migration snapshot (`data/backups/pre-migrate-*.db`, newest 5 kept)
- `/api/ready` reports the age of the last verified backup
- runbook, variables, RPO ≤ 1 h / RTO ≤ 30 min targets in DEPLOY.md §6

**Not operational yet**: no storage is configured. Verified end to end with a local directory target on a copy of the
dev database (migrations 011–014 applied to the copy, backup → verify → restore → overwrite refused → wrong key
refused; the copy and backups were deleted afterwards). No real S3 upload was performed.

## 2. Unresolved blockers

1. **Credentials exposed in `d3605b2` not rotated** (Gemini key, Telegram token, admin password, dev-DB password
   hashes) — owner action, [CREDENTIAL_ROTATION.md](CREDENTIAL_ROTATION.md). GitHub still serves the old commit by SHA.
2. **Off-site backup not operational** until storage + `BACKUP_KEY` are configured and a real upload + restore drill passes.
3. Not in this W0 scope, still open: CSRF/Origin check on state-changing requests; scrypt work factor upgrade (N=2^14 →
   2^17 with `maxmem`, rehash on login); generated admin password printed to logs when `ADMIN_PASSWORD` is empty;
   routine run + task in one transaction.

## 3. Files changed

Server: `src/agents/runner.ts`, `src/app.ts`, `src/config.ts`, `src/connectors/hub.ts`, `src/db/db.ts`,
`src/domain/access.ts`, `src/domain/stats.ts`, `src/domain/tasks.ts`, `src/domain/work.ts`, `src/index.ts`,
`src/lib/auth.ts`, `src/lib/passwords.ts`, `src/routes/{agents,auth,brain,connectors,events,org,runtime,tasks}.ts`,
`package.json` (script `backup`). New: `src/lib/throttle.ts`, `src/backup/{backup,store,config,cli}.ts`.
Shared: `packages/shared/src/index.ts` (permissions, `DeptStats.usageHidden`), `packages/shared/src/dto.ts` (profile usage).
Web: `src/api/stats.ts`, `src/ui/{AgentProfile,BrainPanel,CompanyPanel,FloorPanel,TaskDetail}.tsx` (show "–" / hide the
runs tab when the server withholds data).
Tests: new `test/{isolation,reliability,proxy,backup}.test.ts`, fixtures `claim-worker`, `lock-worker`; updated
`test/{auth,connectors,db,runtime}.test.ts` (the runtime settle wait now waits for the condition instead of 30 ms).
Config/docs: `.env.example`, `render.yaml`, `docs/DEPLOY.md`, `docs/IMPLEMENTATION_PLAN.md`,
`docs/SAG_WORLD_IMPLEMENTATION_PLAN.md`, `docs/SAG_WORLD_SECURITY_MODEL.md`, this report.

## 4. Database migrations

| Migration | Content | Notes |
|---|---|---|
| `011_sensitive_permissions.sql` | 4 permissions + grants to admin/director | idempotent inserts |
| `012_execution_reliability.sql` | `tasks.lease_epoch`, `agent_runs.worker_id/lease_epoch/end_reason`, `worker_heartbeats`, rebuild of `tool_executions` (+`unknown`, +`idempotency_key`, partial unique index) | runs with foreign keys off for the rebuild; FK check enforced by the runner |
| `013_login_throttle.sql` | `login_throttle` | |
| `014_backups.sql` | `backup_runs` | |

All four applied cleanly to a copy of the dev database as it was before 010_org_tree arrived; after the rebase they run after `010_org_tree.sql` (re-verified on the rebased code, see §5). Rollback: the server now takes
`data/backups/pre-migrate-<time>.db` before applying pending migrations; restore that file (DEPLOY.md §6).

## 5. Tests and results

| Check | Result |
|---|---|
| Server typecheck (`tsc --noEmit`) | pass |
| Web typecheck | pass |
| Server tests | **174 / 174** passed after the rebase (16 files: W0 + the import's `units.test.ts`; 160 before the rebase, 118 before W0) |
| Web tests | **39 / 39** passed |
| Production build (`npm run build`) | pass |
| Sequential repeat, server suite | **10 / 10** runs green |
| Parallel stress, 2 suites at once × 6 | **12 / 12** runs green (before the rebase); after the rebase 2 × 3: **6 / 6** |
| Parallel stress, 4 suites at once × 6 (12 CPUs, ≈44 processes) | **14 / 24** runs green; all 19 failing tests hit the 5 s per-test timeout under CPU oversubscription, no assertion failure. Before the dummy-hash fix (and with a build running alongside): 5 / 24 runs green, 48 timeouts. The suite is heavier than in Phase A (worker-thread tests compile TypeScript per worker) |
| Mutation checks | the isolation tests fail against the old chat/SSE/connector routes (3 failures); the fencing test fails when the lease check is reverted to status + agent only |

New test coverage: isolation (10 tests: every access level allowed and denied, chats, SSE over a real socket,
connector log redaction, approvals, stats, profiles, knowledge, memory, parent context); reliability (7: heartbeat
through 5 lease lengths with fake timers, late result of a lost lease rejected while the new holder runs, heartbeat
detects a stolen lease, graceful stop without attempt cost, startup recovery of dead vs live workers, crash-loop limit,
3 worker threads claiming 24 tasks on separate connections with no duplicate); proxy (8: parsing, refusal of "trust
all", direct/one-hop/CIDR, rotating addresses vs account lock, IP ceiling, persistence across restart); SQLite (4:
waits for another connection's lock, fails loudly past the timeout, rejects async transaction bodies, slow-tx hook);
backup (11: encryption/tamper, full cycle, tamper detection, key rotation, retention, AWS SigV4 vectors, S3 request
shapes and secret hygiene, configuration, readiness endpoint); connectors (2: write-action idempotency, `unknown` on
interrupted actions).

Not performed: real S3/R2 upload and restore drill; deployment to Render (graceful stop under Render's real SIGTERM,
`TRUSTED_PROXIES=1` behind Render's load balancer, Vercel rewrite for SSE); two server processes on one host; browser
check of the UI changes (needs signing in, and the only local password is a real, exposed credential); Telegram commands
reviewed for the new visibility rules (not audited in W0).

## 6. Security issues discovered during W0

- Unknown-user logins verified against a hard-coded production-cost hash (fixed; same production timing).
- `db.tx` silently accepted an async body, which would commit before its awaits (fixed).
- The repository's `scripts/auto-pull.ps1` (from the other computer) stashes and rebases automatically; it does not meet
  the agreed git rules (reported earlier; owner of that machine should align or retire it).
- Behaviour changes (intentional, documented): employees no longer see AI tasks they are not involved in or responsible
  for; agent chat history is per person; stats/profile cost figures need `budget:read`; approval/tool payloads need
  `tool_io:read`; `TRUST_PROXY` replaced by `TRUSTED_PROXIES`; `recoverExpiredLeases` fails a task after `max_attempts`
  worker losses; `claimNextTask` returns `leaseEpoch`; the in-memory `AttemptLimiter` was removed.

## 7. Required manual actions (owner)

1. Rotate credentials per [CREDENTIAL_ROTATION.md](CREDENTIAL_ROTATION.md); request GitHub to purge the old commit.
2. Choose backup storage (S3-compatible bucket in an account SAG controls), create a bucket-scoped key, generate
   `BACKUP_KEY` and keep it offline; set `BACKUP_*` in Render (never in chat or git). Then run
   `npm run backup -- now` and a timed restore drill; record the result.
3. In Render: replace `TRUST_PROXY` with `TRUSTED_PROXIES=1` (render.yaml already does), add `PUBLIC_URL`, and
   `SECRETS_KEY` before enabling Google connectors.
4. Review the behaviour changes in §6 with the people who use the office (who sees which AI tasks).
5. Decide whether to commit and deploy this work.

## 8. Production deployment checklist

| Item | State |
|---|---|
| Credentials rotated | ⏳ owner |
| `COOKIE_SECURE=true`, `TRUSTED_PROXIES=1`, `HOST=0.0.0.0`, persistent disk at `/var/data` | ✅ render.yaml |
| `ADMIN_PASSWORD` set on first boot (prevents the generated password reaching logs) | ⏳ owner |
| `PUBLIC_URL`, `SECRETS_KEY` (if connectors), `BACKUP_*` | ⏳ owner |
| Backups configured, first run verified, restore drill timed (RPO/RTO confirmed) | ⏳ |
| Health: `/api/health` (liveness), `/api/ready` (DB, worker, queue lag, backup age) wired to monitoring/alerts | 🟡 endpoints exist; alerting not set up |
| Single server process per DB file (Render disk service, no zero-downtime overlap) | ✅ documented |
| Migrations: pre-migration snapshot automatic; rollback runbook | ✅ |
| AI cost controls: per-task limits (exist); per-unit budgets come with W6 | 🟡 |
| CSRF/Origin check; scrypt upgrade | ⏳ open |
| Error reporting beyond logs | ⏳ not chosen (external service only with approval) |

## 9. Recommended next step

Finish the owner actions in §7 (rotation and a verified off-site backup are the two remaining blockers), commit and
deploy W0, watch `/api/ready` for a few days — then start **W1 Business Unit Foundation** (org tree, `business_unit_id`
ownership with composite keys, migration of today's organisation into `hq`), building on the access rules implemented
here (`readsAllTasks` and `visibleTaskSql` are the places the unit scope plugs in).
