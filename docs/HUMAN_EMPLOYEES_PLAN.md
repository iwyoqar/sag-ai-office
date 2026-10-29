# Human employees & workflow — audit and implementation plan

Date: 2026-10-29. Scope: "SAG AI OFFICE — Human Employee Management & Workflow System".

## Audit (what exists)

| Area | Found | Consequence |
|---|---|---|
| Accounts | `users` (scrypt hashes, hashed session tokens, httpOnly cookie), `roles`, `role_permissions`, `user_roles`, admin user management, login rate limit, audit log with secret redaction | Human employees **are** `users` rows extended with employee fields — no second account system |
| Roles | `admin, director, hr, member, viewer`; permissions are global (no department scope) | Add `department_head`, `employee`; add scoped, delegable per-user grants |
| Organisation | `floors`, `departments` (floor per department); no heads, no reporting lines | `departments.head_user_id`, `users.manager_id` |
| Tasks | one `tasks` table for AI work: statuses `BACKLOG…DONE`, `parent_id`, dependency DAG with cycle check, guarded atomic transitions, `task_events` history, audit, `requires_approval`, deliverables, approvals | Human work uses the **same table** (`kind = 'human'`, `assignee_user_id`), its own transition table, the same events/audit/dependencies |
| Status constraint | `tasks.status` has a CHECK listing only AI statuses | Migration 007 rebuilds `tasks` (SQLite 12-step procedure, foreign keys off during the copy) to add `ASSIGNED, ACCEPTED, IN_REVIEW, CHANGES_REQUESTED` and `kind = 'human'` |
| AI runner | claims only `QUEUED` tasks that have an `agent_id` | human tasks (no agent) are never picked up by agents |
| Task API | `/api/tasks*` lets any `tasks:read` holder read every task | human tasks are hidden there unless the caller may see them; they are driven only through `/api/work/*` |
| Realtime | `/api/events` broadcasts every event to every session | human-task and notification events carry no content and are delivered only to their audience |
| Notifications | Telegram group notifications for AI tasks only | new persistent `notifications` table (idempotent `dedupe_key`), optional Telegram DM only to a linked account |
| 3D | realistic office floors with AI agents seated by `agents.workstation` | employees take the department's remaining desks, distinct look + "person" tag; activity only from real data |

## Decisions

- **Status names.** Kept the project's `DONE` for "COMPLETED" (UI label: *Bajarildi / Completed*) and `BLOCKED`, `CANCELLED`, `BACKLOG`, `IN_PROGRESS`; added `ASSIGNED`, `ACCEPTED`, `IN_REVIEW`, `CHANGES_REQUESTED`.
- **Human transitions** (`HUMAN_TASK_TRANSITIONS` in `@sag/shared`):
  `BACKLOG→ASSIGNED|ACCEPTED|CANCELLED`, `ASSIGNED→ACCEPTED|BACKLOG(declined)|CANCELLED`, `ACCEPTED→IN_PROGRESS|BLOCKED|CANCELLED`,
  `IN_PROGRESS→IN_REVIEW|DONE(no review)|BLOCKED|CANCELLED`, `IN_REVIEW→DONE|CHANGES_REQUESTED|CANCELLED`,
  `CHANGES_REQUESTED→IN_PROGRESS|BLOCKED|CANCELLED`, `BLOCKED→IN_PROGRESS|ACCEPTED|CANCELLED`.
- **Parent aggregation** runs inside the same transaction as every child change (SQLite `BEGIN IMMEDIATE` serialises writers; updates are guarded by the current status): progress = weighted average over *required* children; any required child `BLOCKED` → parent `BLOCKED`; all required children `DONE` → parent `IN_REVIEW` (if the parent needs review) or `DONE`; automatic moves are recorded as events with `actor = system`.
- **Workload** is computed on read from live task data (always current) — configurable thresholds and fallbacks in setting `workload`; the last notified level is stored to send ORANGE/RED notices once.
- **No hard delete** of people: status `active | inactive | archived`; `inactive/archived` cannot log in, history keeps attribution.

## Phases

1. Migration 007 + shared types (roles, permissions, statuses, DTOs).
2. Access layer (`domain/access.ts`): role + scoped grants, managed departments, who may see/manage whom and which task.
3. Employees service + API (directory, profile, create/edit, status, roles, grants, avatar, org chart, department heads).
4. Work service + API (create/assign/delegate/split, accept/decline/start/progress/submit/approve/request changes/block/cancel, comments, attachments, reviews, aggregation).
5. Workload + notifications (+ deadline sweep in the scheduler, optional Telegram DM).
6. Tests for the 18 acceptance scenarios.
7. Web UI: People panel (directory, profile, forms, org chart, team), Work panel (views, Kanban/list, task detail), notifications bell.
8. 3D: employees on their department floor, selectable, activity from real data. Docs + report.
