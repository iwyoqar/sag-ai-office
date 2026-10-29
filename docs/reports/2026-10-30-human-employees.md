# Report — Human Employee Management & Workflow (2026-10-30)

Plan and audit: [HUMAN_EMPLOYEES_PLAN.md](../HUMAN_EMPLOYEES_PLAN.md). Workload method: [WORKLOAD.md](../WORKLOAD.md).

## What was built

| Area | Implementation | Verified by |
|---|---|---|
| Employee accounts | Employees are `users` rows extended with job title, department, floor, manager, email, status (active/inactive/archived), start date, weekly capacity, working hours, timezone, last activity, avatar (PNG/JPEG/WebP ≤ 1 MB, magic-byte checked). Login by username or email; scrypt hashes and hashed session tokens unchanged; nothing secret reaches the browser. AI agents stay a separate entity | tests 1–2, 4, 15 |
| Roles | `admin`, `director`, `department_head`, `employee` (legacy `hr/member/viewer` kept). Department heads are set per department (`departments.head_user_id`) | tests 1, 3 |
| Permissions | Role permissions + per-user **grants**, optionally limited to one department, optionally delegable. Department-scoped permissions apply only to departments the user heads; heads never manage other heads/directors/admins; nobody changes their own roles or grants themselves anything; admin-only permissions can only come from an admin. All sensitive actions are audited | tests 3, 4, 16 |
| Organisation | Org chart (director → departments → heads → members, plus AI agent count), head assignment from the UI, reporting lines validated as a tree | tests 1, 16; browser |
| Task lifecycle | Same `tasks` table as AI work (`kind = 'human'`), new statuses `ASSIGNED, ACCEPTED, IN_REVIEW, CHANGES_REQUESTED` (`DONE` = completed). Accept / decline (reason required) / start / progress + actual hours / submit / approve / request changes (comment required) / block / unblock / cancel / (re)assign. Review optional per task; no self-approval. Every change: guarded update + history event (who, when, from → to) + audit, in one transaction | tests 5, 6–11 |
| Hierarchy | Director → head → subtasks → employees with ownership kept on the parent; required vs optional subtasks; weights; parent progress = weighted required progress; blocked required subtask blocks the parent; all required done → parent to review (or done) automatically, recorded as `actor = system`; dependency DAG with cycle guard | tests 6–11, 12 |
| Concurrency | `BEGIN IMMEDIATE` transactions + status-guarded updates: two connections finishing the last two subtasks at the same moment produce exactly one parent completion; a double-submitted action applies once (second gets 409) | test 12 (worker threads, file DB) |
| Workload | Explainable GREEN/YELLOW/ORANGE/RED with summary + reasons, low-confidence flag, configurable thresholds, no double counting, completed/in-review work excluded | tests 13–14; browser |
| Notifications | Persistent, idempotent (`dedupe_key`) in-app notifications: assigned, reassigned, accepted, declined, submitted for review, changes requested, approved/completed, deadline within 24 h, overdue, workload ORANGE/RED. Bell with unread count. People's work is **never** posted to the Telegram group | tests 6–11, 13, sweep test |
| Realtime | People events carry ids only and reach only their audience (assignee, owners, reviewers, ancestors' owners; company-wide readers) | realtime test |
| Isolation from AI API | `/api/tasks` hides human tasks, refuses to transition/reassign/retry them or to attach agent subtasks to them | test 18 |
| UI | *Xodimlar* panel: work views (my / team / department / company / review / overdue / blocked) as Kanban or list; directory with search, department/status filters and sorting; profile (details, workload panel, tasks, roles & grants, activity history, status, avatar); add/edit form with client + server validation; org chart; workload policy; task detail with all workflow actions, comments, attachments (always downloaded, never rendered inline), reviews, subtasks, status history; notifications bell. Responsive below 700 px | browser (see below) |
| 3D | Employees sit at their department's free desks on the realistic floors, wear an ID badge on a lanyard and have a 👤 name plate (AI agents: "AI"). Pose from real data only: working (task in progress), reviewing (reviews waiting), blocked, available; no activity for 30 min = away (empty desk, dimmed plate). Clicking a person or their monitor opens their profile and tasks | web test; browser |

## Tests and checks

- Server: **105 passed** (14 new in `test/people.test.ts`; all earlier AI agent, Telegram, brain, schedule, auth tests still pass).
- Web: **36 passed** (new presence-mapping test); `tsc --noEmit` clean for server and web; `vite build` succeeds.
- Migration 007 applied to a copy of the real dev database: 20 tasks and 257 events preserved, `PRAGMA foreign_key_check` clean
  (the running dev server had already applied it to `data/sag.db` the same way).
- **Browser** (isolated demo stack on ports 4100/5174 with its own database from `apps/server/scripts/demo-people.ts`; the
  pane was hidden, so checks used the DOM/accessibility tree, not screenshots): head's Kanban and review queue; request-changes
  without a comment shows the error; approval updates the parent (65 %, "1/3 majburiy bajarildi", still in progress);
  directory shows workload only for the head's own department; 3D floor 5 shows four people with correct poses and clicking
  one opens her profile; add-employee form shows field errors and the server's "Bu login band"; an employee sees no
  org chart/company views (API 403); the director sees the full org chart and all company tasks.

## Files

- Server: `db/migrations/007_people_workflow.sql`, `db/db.ts` (foreign-key-off rebuild support), `db/seed.ts`,
  `domain/{access,employees,work,workload,notifications}.ts`, `routes/people.ts`, `routes/{tasks,events,auth}.ts`,
  `lib/auth.ts`, `domain/{tasks,users,stats}.ts`, `schedule/service.ts`, `telegram/bot.ts`, `app.ts`,
  `scripts/demo-people.ts`, `test/people.test.ts`, `test/fixtures/submit-worker.*`.
- Shared: statuses, human transitions, roles, permissions, DTOs.
- Web: `ui/people/{common,Employees,Work,PeoplePanel}.tsx`, `App.tsx`, `ui/TopBar.tsx`, `api/office.tsx`,
  `config/status.ts`, `scene/office/{OfficeFloor,character,behaviour}.ts`, `scene/{SceneController,interior}.ts`,
  `styles.css`, `vite.config.ts` (`WEB_PORT`, `API_TARGET`).

## Known limitations

- One assignee per task (several people → subtasks), as the specification allows.
- No calendar/meeting data for people, so the 3D office never shows them in meetings; desks are the department's free
  desks in hiring order (stable while the roster is stable), not a persisted seat; the `?simple` zone view shows agents only.
- Telegram: personal Telegram notices for employees are not sent yet (a `telegram_user_id` field exists); the group never
  receives people's work.
- Attachments are stored in the database (≤ 10 MB each); fine for SQLite dev, to move to object storage in production.
- Realtime events are filtered with the permissions loaded when the stream opened; a revoked permission applies on the
  next reconnect (data APIs check on every request).
- Visual screenshots of the new UI were not taken (browser pane hidden); layout was checked through the DOM only.

## Next steps

Production phase (Postgres adapter, object storage for attachments/avatars, security review), personal Telegram notices,
calendar/availability for people, persisted human desks.
