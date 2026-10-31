# Work Management progress

**Rules:** [`WORK_MANAGEMENT_ROADMAP.md`](WORK_MANAGEMENT_ROADMAP.md) (owner's master roadmap, copied unchanged).

**Last updated:** 2026-10-31T07:20Z

| | |
|---|---|
| **Current phase** | None in progress. S0 (security remediation, inserted between T0 and T1 at the owner's request) was accepted by the owner on 2026-10-31. |
| **Completed phases** | T0, S0 |
| **Next permitted phase** | **T1 Unified Task Engine**. It starts only on the owner's command `Keyingi bosqichni boshla` (or `T1 ni boshla`). Nothing starts automatically. |
| **Git** | Base `f794a1b` (main, pushed). S0, T0 report and these files are in the working tree only: **not committed, not pushed**. |

## Phase status

| Phase | Status | Evidence |
|---|---|---|
| T0 Architecture audit | COMPLETED | Report: [`docs/reports/2026-10-31-t0-work-management-audit.md`](docs/reports/2026-10-31-t0-work-management-audit.md) (written at `f794a1b`, no code changed). Owner reviewed it on 2026-10-31: approved the five architecture decisions below and ordered S0 before T1. |
| S0 Security remediation | COMPLETED | Five audit findings fixed and verified (details below). Final review done and **accepted by the owner on 2026-10-31**. |
| T1 Unified Task Engine | NOT_STARTED | Next permitted phase |
| T2 Project & subtask management | NOT_STARTED | Needs T1 |
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

### Notes for T1 (from the roadmap compared with the current code)

These are not decisions; they will be raised at the start of T1.

- **Priority.** The roadmap names LOW / MEDIUM / HIGH / **CRITICAL**; the code has LOW / MEDIUM / HIGH / **URGENT**. The roadmap says not to replace existing enums without reason, so the mapping needs confirming.
- **Field names.** The roadmap's `startAt` / `dueAt` correspond to today's `scheduled_for` / `deadline`. They should be extended or renamed with a compatibility layer, not duplicated.

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
