# SAG AI OFFICE — API (Phase 2)

Base: `/api`. JSON in/out. Auth: httpOnly session cookie `sag_session` (from `POST /api/auth/login`).
In dev the web app proxies `/api` to `http://127.0.0.1:4000`, so the cookie stays same-origin.

Errors: `{ "error": { "code", "message", "details?" }, "requestId" }`. Every response carries `x-request-id`.

| Status | When |
|---|---|
| 400 `validation` / `bad_request` | invalid body/query (zod issues in `details`) |
| 401 `unauthorized` / `invalid_credentials` | no / bad session, wrong login |
| 403 `forbidden` | missing permission |
| 404 `not_found` | unknown id |
| 409 | `invalid_transition` (with `allowed`), `concurrent_update`, `agent_has_open_tasks` (with `tasks`), `task_closed`, `agent_archived`, `not_retryable` |
| 429 `too_many_attempts` | > 5 failed logins / minute per IP+username |

## Roles → permissions (default, stored in DB)

| Role | Permissions |
|---|---|
| admin | all |
| director | tasks:read/create/manage, agents:read/control, audit:read |
| hr | tasks:read/create, agents:read/manage/control |
| member | tasks:read/create, agents:read |
| viewer | tasks:read, agents:read |

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → `{user}` + cookie |
| POST | `/auth/logout` | |
| GET | `/auth/me` | `{user}` with roles + permissions |
| GET | `/audit?limit&targetId` | `audit:read` |
| GET | `/health` | public |

## Organisation

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/floors` | agents:read | `{floors[], departments[]}` |
| GET | `/connectors` | agents:read | real status; all `disconnected` until Phase 7 |
| GET | `/stats?range=today\|7d\|30d\|custom&from&to` | tasks:read | per department; days in Asia/Tashkent; `from/to` = `YYYY-MM-DD` |

Stats fields: `agents, active, idle, inProgress, queued, waitingApproval` (now) and `completed, errors, avgMinutes, tokens, costUsd` (in range; tokens/cost from `usage_records`).

## Agents

| Method | Path | Perm | Body |
|---|---|---|---|
| GET | `/agents?departmentId&includeArchived=true` | agents:read | |
| GET | `/agents/:id` | agents:read | profile: agent, recentTasks, connectors (+granted), instructions, errors, usage |
| POST | `/agents` | agents:manage | `{name, role, departmentId, model?, skills?, responsibilities?, instructions?, connectorIds?, maxTokensPerTask?, maxCostPerTaskUsd?}` |
| PATCH | `/agents/:id` | agents:manage | any of name, role, model, skills, responsibilities, limits (lifecycle/department are **not** patchable) |
| PUT | `/agents/:id/connectors` | agents:manage | `{connectorIds}` — must be a subset of the department's connectors |
| POST | `/agents/:id/pause` / `resume` | agents:control | |
| POST | `/agents/:id/stop` | agents:control | only this agent's IN_PROGRESS / WAITING_APPROVAL tasks → BLOCKED |
| POST | `/agents/:id/archive` | agents:manage | `{strategy: "reassign", toAgentId}` or `{strategy: "cancel"}`; without it → 409 if open tasks |
| POST | `/agents/:id/transfer` | agents:manage | `{departmentId, strategy?, toAgentId?}`; drops connector grants the new department lacks |

Archived agents keep all history; they are hidden from `GET /agents` unless `includeArchived=true` and cannot receive tasks.

## Tasks

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/tasks?group=ALL\|BACKLOG\|IN_PROGRESS\|WAITING\|DONE\|FAILED&status=A,B&departmentId&agentId&parentId&topLevel=true&limit` | tasks:read | |
| GET | `/tasks/:id` | tasks:read | task + subtasks, dependents, events, messages, deliverables, approvals, runs, tools |
| POST | `/tasks` | tasks:create | `{title, description?, departmentId?, agentId?, priority?, deadline?, parentId?, dependsOn?, limits?, maxAttempts?, backlog?}` |
| PATCH | `/tasks/:id` | creator or tasks:manage | title, description, priority, deadline, limits (not on closed tasks) |
| POST | `/tasks/:id/cancel` | creator or tasks:manage | cascades to open subtasks |
| POST | `/tasks/:id/retry` | tasks:manage | FAILED/BLOCKED → QUEUED |
| POST | `/tasks/:id/reassign` | tasks:manage | `{agentId}`; in-flight work goes back to the queue |
| POST | `/tasks/:id/transition` | tasks:manage | `{to, reason?}` — manual override, validated |

Routing on create: `agentId` → that agent (must be ACTIVE); only `departmentId` → least-loaded ACTIVE agent; neither → `BACKLOG` (orchestrator, Phase 4).
Unfinished dependencies → `WAITING_FOR_DEPENDENCY`; released to `QUEUED` automatically when they are all `DONE`. Cycles are rejected.

### Status transitions (`packages/shared`)

```
BACKLOG → QUEUED | CANCELLED
QUEUED → IN_PROGRESS | WAITING_FOR_DEPENDENCY | BACKLOG | CANCELLED
IN_PROGRESS → WAITING_APPROVAL | WAITING_FOR_DEPENDENCY | BLOCKED | FAILED | DONE | CANCELLED | QUEUED
WAITING_FOR_DEPENDENCY → QUEUED | BLOCKED | CANCELLED
WAITING_APPROVAL → IN_PROGRESS | QUEUED | FAILED | CANCELLED
BLOCKED → QUEUED | FAILED | CANCELLED
FAILED → QUEUED          DONE, CANCELLED → (final)
```

Every write is `UPDATE … WHERE id = ? AND status = <expected>`; a concurrent writer gets 409. Workers claim with a single guarded `UPDATE … RETURNING` plus a lease; expired leases are re-queued every 30 s and at startup.

## Realtime — `GET /events` (SSE)

`tasks:read`. Event names: `task.created, task.updated, task.status, task.progress, agent.updated, agent.status, agent.paused, agent.resumed, approval.requested, connector.activity, agent.message`, plus `ready` after replay.

```
id: 42
event: task.status
data: {"id":42,"type":"task.status","at":"…","taskId":"tsk_…","agentId":"…","departmentId":"…","data":{"from":"QUEUED","to":"IN_PROGRESS"}}
```

Events are stored in `task_events` before they are sent. A client reconnecting with `Last-Event-ID` (EventSource does this automatically) receives everything it missed, including across server restarts.
