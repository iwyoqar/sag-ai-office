# Work Management progress

**Rules:** [`WORK_MANAGEMENT_ROADMAP.md`](WORK_MANAGEMENT_ROADMAP.md) (owner's master roadmap, copied unchanged).

**Last updated:** 2026-10-31T08:10Z

| | |
|---|---|
| **Current phase** | None in progress. T1 Unified Task Engine is finished and awaiting the owner's review. |
| **Completed phases** | T0, S0, T1 (T1 awaiting review) |
| **Next permitted phase** | **T2 Project & Subtask Management**. It starts only on the owner's command `Keyingi bosqichni boshla`, after the T1 review. |
| **Git** | S0 committed and pushed as `89b41a6`. T1 is in the working tree only: **not committed, not pushed**. |

## Phase status

| Phase | Status | Evidence |
|---|---|---|
| T0 Architecture audit | COMPLETED | Report: [`docs/reports/2026-10-31-t0-work-management-audit.md`](docs/reports/2026-10-31-t0-work-management-audit.md) (written at `f794a1b`, no code changed). Owner reviewed it on 2026-10-31: approved the five architecture decisions below and ordered S0 before T1. |
| S0 Security remediation | COMPLETED | Five audit findings fixed and verified (details below). Final review done and **accepted by the owner on 2026-10-31**. |
| T1 Unified Task Engine | COMPLETED | 2026-10-31; details below. Awaiting the owner's review. |
| T2 Project & subtask management | NOT_STARTED | Next permitted phase (after the T1 review) |
| T3 Workflow, review & dependency | NOT_STARTED | Needs T1, T2 |
| T4 Planning, calendar, timeline & SLA | NOT_STARTED | Needs T2, T3 |
| T5 Human & AI workforce | NOT_STARTED | Needs T1 |
| T6 AI task intelligence | NOT_STARTED | Needs T3, T5 |
| T7 Analytics & reporting | NOT_STARTED | Needs T1, T4 (T6 for AI cost) |

Phases run one at a time in roadmap order: T1 → T2 → T3 → T4 → T5 → T6 → T7.

## Approved architecture decisions (owner, 2026-10-31)

1. **AI cost in integer micro-USD.**
   - 1 USD = 1,000,000 micro-USD.
   - The provider's original cost is kept.
   - UZS reporting uses a stored exchange-rate snapshot, so history never changes when rates change.
2. **ACCEPTED leaves the task lifecycle.** Acceptance is a TaskAssignment state; task status and assignment status stay separate.
3. **Dependency types:** FINISH_TO_START, START_TO_START and FINISH_TO_FINISH. START_TO_FINISH is not implemented.
4. **AI agents may be REVIEWERS (advisory) but never APPROVERS.** Final approval is by an authorised human, and AI assessment and human approval are stored separately.
5. **All Business Units, stores and franchises included, eventually use the unified Task Engine.**
   - Stores migrate backward-compatibly in the appropriate phase, not in S0.
   - Franchise isolation is preserved.

### T1 decisions (owner, 2026-10-31)

1. **Lifecycle storage.** A new `tasks.lifecycle` column holds the 10 roadmap statuses. The existing `status` stays as the AI execution status and for the legacy flows, and the engine keeps the two in sync. The tasks table is not reshaped around the new statuses.
2. **Priority.** URGENT becomes CRITICAL. Data is migrated, and the API accepts URGENT as an alias for one phase.
3. **OWNER.** A task may have several OWNERs.

### Notes for T1 (from the roadmap compared with the current code)

These are not decisions; they will be raised at the start of T1.

- **Priority.** The roadmap names LOW / MEDIUM / HIGH / **CRITICAL**; the code has LOW / MEDIUM / HIGH / **URGENT**. The roadmap says not to replace existing enums without reason, so the mapping needs confirming.
- **Field names.** The roadmap's `startAt` / `dueAt` correspond to today's `scheduled_for` / `deadline`. They should be extended or renamed with a compatibility layer, not duplicated.

---

## T1: Unified Task Engine (2026-10-31)

### Summary

**One task table.** The `tasks` table is extended, not replaced or duplicated.
- **`lifecycle`:** the 10 roadmap states. The existing `status` stays the AI execution status and the legacy-flow status.
- **`version`:** optimistic concurrency.
- **`start_at`:** planned start. `deadline` is the due date.
- **`idempotency_key`:** one task per creator and key.
- **`blocked_reason`**, and **`last_actor`**, which names the writer of a transition.

**One assignment model: `task_assignments`.**
- Assignee type: HUMAN or AI_AGENT.
- Role: OWNER, CONTRIBUTOR, REVIEWER or APPROVER.
- State: ASSIGNED, ACCEPTED, DECLINED or RELEASED.
- Records assigned_by, assigned_at, accepted_at, released_at and reason.

**Consistency in the database (migration 022 triggers).** Every writer stays consistent, including the AI runtime's direct status writes and the store flow:
- legacy `status` → `lifecycle` sync;
- every lifecycle change is logged to `task_transitions` with its actor (`user:` / `agent:` / `system`);
- the version is bumped on every business change;
- the legacy assignee, reviewer and agent columns are mirrored into assignments;
- a unit trigger keeps assignments in the task's unit;
- an AI agent can never be APPROVER (CHECK);
- one active assignment per task, role and assignee (unique index).

**Domain: `domain/taskEngine.ts`.** It validates every transition (`LIFECYCLE_TRANSITIONS` in shared): current and target state, actor, required reasons, open dependencies, open required subtasks and version. Execution goes to the existing adapters, so there is no parallel system:
- **People's tasks:** `work.ts` `humanAdapter` (guarded legacy moves, parent aggregation, notices).
- **AI tasks:** `tasks.ts` (`transitionTask`, `reassignTask`, `cancelTask`).

**Assignment rules.**
- The assignee must exist, be active and be in the same unit.
- People are assigned only where `canAssignTo` allows; agents only within the caller's departments and with `ai_tasks:create`.
- No duplicates.
- An owner never reviews or approves their own task.
- Agents never approve.
- A person's task is owned by people; agents may contribute or review (advisory).
- An AI task has one executing AI owner and may have accountable human co-owners.
- A task may have several owners (owner decision).

**Approval and completion are separate:** IN_REVIEW → APPROVED (approver, or a reviewer or the owner of the work when no approver is assigned) → COMPLETED.

**AI tasks.** People may plan, queue, block and cancel them through the engine. The AI runtime starts and finishes them (its states are logged as `system`). AI review and approval through the engine is T3.

**Priority.** URGENT becomes CRITICAL in tasks, routines and the workload policy. The API accepts `URGENT` for one phase.

**Idempotency.** `Idempotency-Key` on `POST /api/tasks` and `POST /api/work`: a retry gets the first task back (200, `replayed: true`). A key reused for a different kind of request returns 409.

**Visibility.** An active assignment makes a person part of the task (`canSeeTask` / `visibleTaskSql`), so co-owners, contributors, reviewers and approvers can see and act on it.

### API

New endpoints, same convention, for both kinds of task:
- `GET /api/tasks/:id/engine`: task, assignments, transitions, and `can` (what this viewer may do now).
- `POST /api/tasks/:id/lifecycle` `{ to, reason?, version? }`.
- `POST /api/tasks/:id/assignments` `{ assigneeType, assigneeId, role, version? }`.
- `POST /api/tasks/:id/assignments/:assignmentId/release | accept | decline`.

Existing endpoints are unchanged. They accept `Idempotency-Key` and `startAt`, and return `lifecycle`, `version` and `startAt`.

### UI

`TaskEnginePanel` appears in the AI task modal and the people's-work modal. It shows:
- lifecycle, priority, dates and version;
- assignments with Inson/AI type, role and state, and accept / decline / remove actions;
- an "add assignee" form (person or agent, with role);
- lifecycle buttons taken from the server's `can`, with a reason field;
- recent activity.

Lists (AI task cards and people's work board and table) show a lifecycle tag.

### Changed files

- **New:**
  - `apps/server/src/db/migrations/022_task_engine.sql`
  - `apps/server/src/domain/taskEngine.ts`
  - `apps/server/src/routes/taskEngine.ts`
  - `apps/server/src/lib/idempotency.ts`, `apps/server/src/lib/priority.ts`
  - `apps/server/test/taskEngine.test.ts`
  - `apps/web/src/ui/TaskEnginePanel.tsx`
  - `packages/shared/src/taskEngine.ts`
- **Modified, server:**
  - `app.ts`
  - `connectors/tools.ts` (priority)
  - `domain/access.ts` (assignment visibility)
  - `domain/tasks.ts` (lifecycle fields, `last_actor`, idempotency and start)
  - `domain/units.ts` (`last_actor`, priority type)
  - `domain/work.ts` (`last_actor`, `humanAdapter` export, idempotency and start)
  - `domain/workload.ts`
  - `lib/audit.ts` (`actorTag`)
  - `routes/people.ts`, `routes/schedule.ts`, `routes/tasks.ts`, `routes/units.ts` (priority input, idempotency)
  - tests `db.test.ts` (registry) and `tasks.test.ts` (URGENT → CRITICAL)
- **Modified, shared:** `index.ts` (priority, export) and `dto.ts` (TaskDto lifecycle, version, startAt).
- **Modified, web:** `TaskDetail.tsx`, `people/Work.tsx`, `TaskPanel.tsx`, `CalendarPanel.tsx`, `people/PeoplePanel.tsx`, `styles.css`.

### Migrations

**022_task_engine** (tasks and routines rebuilt with foreign keys off and checked before commit).
- **Before applying to the dev DB:** a consistent copy was made with `VACUUM INTO` to `private/backup-before-022-2026-10-31T07-58-07-965Z.db`. Its row counts matched the live DB exactly and `integrity_check` returned ok.
- **Recovery path:** stop the server, copy that file over `data/sag.db`, and remove `-wal` / `-shm`.
- **Applied:** by the dev server at startup, after its own automatic backup `data/backups/pre-migrate-20261031T075826Z.db`.
- **After applying:**
  - 22 files = 22 applied, in order;
  - the fresh and dev schemas match: 183 objects, 0 differences;
  - row counts unchanged (87 users, 1 task, 71 agents);
  - the existing task was backfilled with lifecycle ASSIGNED, a HUMAN OWNER and a REVIEWER.

### Tests, typecheck and build

| Check | Result |
|---|---|
| Server tests | **288/288** (25 files). Includes the 11 new T1 tests; the existing W3.2 AI Director, isolation, people, runtime and reliability suites all pass unchanged. |
| Web tests | 71/71 |
| Server and web typecheck | clean |
| Web production build | clean |
| Running app | the engine endpoint and every main endpoint return 200, no server errors, and the panel renders in the work modal |

**T1 tests** (`apps/server/test/taskEngine.test.ts`):
- human and AI task creation;
- human and AI assignment, several owners, AI contributor and reviewer, AI never owner of a person's task nor approver (API and DB);
- invalid, inactive, duplicate and unauthorised assignee;
- cross-unit and franchise denial (route, domain and DB);
- a person's task end to end with revision and approval ≠ completion;
- invalid transitions and missing reasons;
- an AI task through the engine and the AI runtime;
- stale version → 409;
- idempotency for AI and people's tasks;
- the URGENT → CRITICAL alias;
- legacy flows keeping assignments in step.

### Known limitations and risks

- **Duplicate UI path.** The people's-work modal still has its legacy action buttons next to the engine panel. Both are authorised on the server and stay consistent through the triggers. They should be consolidated in a later phase.
- **AI review and approval** through the engine is T3. For now an AI result is approved through the existing approvals (`WAITING_APPROVAL`).
- **Store units** keep their own flow (`units.ts`). Their lifecycle and assignments are kept in step by the triggers, but the engine routes serve HQ scope. Migrating stores is planned for a later phase (owner decision 5).
- **Cross-unit handoff** (an assignment in another unit through an authorised request) is not built. Cross-unit assignment is simply refused.
- **Idempotency.** A replay returns the first task without comparing request bodies.
- **Integer micro-USD AI cost (decision 1)** is not part of the roadmap's T1 scope and is not implemented yet. Cost is still USD REAL. Proposed for T5 (workforce cost) or T7 (AI cost reporting).
- **Release.** The executing AI owner cannot be released; it is replaced through reassignment. A person's only owner cannot be released once work has started.
- **No real AI provider was used.** The configured Gemini key is reported invalid by the provider; all AI flows in the tests are test doubles.

---

## S0: security remediation (2026-10-31)

### Summary

| Finding | Root cause | Enforcement point |
|---|---|---|
| **S1** Cross-unit task creation through `parentId` | `POST /api/tasks` checked only that the parent was not a human task. The new task took the parent's unit, so with no agent or department it was created inside a franchise (201 on the old code). | `routes/tasks.ts`: `requireVisibleTask` (404, like a missing id) plus `canManageTask` or `tasks:manage`. The route is the enforcement point for a client-supplied `parentId`; internal callers (runner, scheduler, Telegram, units) never take one from a client. `domain/tasks.ts createTask` adds a backstop: it refuses a parent from another unit when the caller names the unit (`unitId`), and the `trg_task_unit` DB trigger keeps parent and child in one unit. |
| **S2** HQ and personal task leakage | `/api/calendar` and `/api/routines` required only `tasks:read`. The agent card's `currentTask` exposed any task title. | `visibleTaskSql` in the calendar; `canSeeRoutine` for routine lists, get-by-id (404) and calendar items; `routes/agents.ts card()`. |
| **S3** Cross-unit dependency leakage | `dependsOn` was unchecked, and the runner fed the prerequisite's result into the prompt. Reads returned every dependency and dependent id. | `requireVisibleTask` per dependency; same-unit backstop in `createTask`; migration 021 DB triggers; same-unit filter in `runner.priorResults`; `visibleTaskIds` on every read (`/api/tasks` list and detail, `/api/work`). |
| **S4** Agent knowledge isolation | Chat, task grounding and `search_company_knowledge` used the agent's department, not the requester's reach. | `access.ts` `readsDeptKnowledge`, `requesterOf` and `agentKnowledgeDept`, applied at retrieval time in `routes/runtime.ts`, `agents/runner.ts ground()` and `connectors/hub.ts env()` → `tools.ts`. |
| **S5** Delegation escalation | A holder of `permissions:delegate` bypassed every own-scope check. | `employees.ts grantPermission`: `holdsToDelegate` plus HQ-only target. `setDepartmentHead`: HQ target, and a non-admin must hold every permission of the department_head role. |

### Changed files

- **Server source:** `apps/server/src/`
  - `agents/runner.ts`
  - `connectors/hub.ts`, `connectors/tools.ts`
  - `domain/access.ts`, `domain/employees.ts`, `domain/tasks.ts`, `domain/work.ts`
  - `routes/agents.ts`, `routes/brain.ts`, `routes/runtime.ts`, `routes/schedule.ts`, `routes/tasks.ts`
  - `schedule/service.ts`
- **Tests:** `apps/server/test/isolation.test.ts` (11 new S0 tests), `test/people.test.ts` (one expectation updated to the S5 rule), `test/db.test.ts` (registry includes 021).
- **New:**
  - `apps/server/src/db/migrations/021_dependency_unit_guard.sql`
  - `docs/reports/2026-10-31-t0-work-management-audit.md`
  - `WORK_MANAGEMENT_ROADMAP.md`
  - `WORK_MANAGEMENT_PROGRESS.md`

### Migrations

**021_dependency_unit_guard** adds the triggers `trg_task_dep_unit` and `trg_task_dep_unit_upd`.
- It was applied to the dev DB by the running dev server, after the automatic backup `data/backups/pre-migrate-20261031T065936Z.db`.
- Existing data had 0 cross-unit dependencies.
- Registry: 21 files = 21 applied, in order.
- The fresh and dev schemas match: 163 objects, 0 differences.

### Tests, typecheck and build

| Check | Result |
|---|---|
| Server tests | 277/277 (24 files) |
| Web tests | 71/71 (7 files) |
| Server and web typecheck | clean |
| Web production build | clean |
| Dev server | healthy, no errors in log |

The new tests were also run against the unfixed code `f794a1b`: 10 of 11 fail there, and S1 returns 201. The one that passes there covers the domain backstop, which the DB trigger already enforced.

### Behaviour change

The director (who has `permissions:delegate`) can no longer grant permissions it does not hold, nor appoint department heads, because the department_head role carries `employees:manage_dept`. The administrator is unchanged.

### Known limitations and risks (outside S0)

- *(Found in the S0 final review, low.)* A visible subtask's `parentId` (in task DTOs and the `task.created` event) reveals the **id**, not the content, of a parent the viewer cannot see. Planned for T1, in the Scope layer.
- *(Policy.)* The director can revoke any grant, including grants made by the administrator. This only removes rights.

- Telegram-created tasks count as system work; the bot's own authorisation was not audited.
- Approval decisions need only global `tasks:manage` (planned for T3).
- `company_memory`, `instructions`, `routines` and `chat_messages` have no unit column.
- There is no API or AI rate limiting, and `COOKIE_SECURE` defaults to off.
- The chat path skips `checkLimits` and provider bookkeeping (planned for T5).
- Real providers were not exercised; all AI tests use mocks.
