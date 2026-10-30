# W3.2 HQ AI Director & autonomous workforce — report (2026-10-30)

Base: `4243d6a`. Working tree only: **not committed, not pushed, not deployed**. The next sprint has not started.

All end-to-end runs in this report use **mocked providers** (`MockLlm` and a fake Anthropic SDK), and say so. No real
AI execution was verified, because neither real credential works today (§12).

## 1. Initial audit (Phase 0)

| Area | Found | Gap closed in this sprint |
|---|---|---|
| Marketplace | 46 APPROVED templates, hire requests, limits, archive-all (W4) | AI-initiated `request_hire` |
| Agents | 47 HQ agents, all ACTIVE (46 seeded plus the test hire), all linked to a template, 0 task history. Also 22 store AI Directors, one per store. | — (no record changed) |
| HQ AI Director | `director-director-ai` ("Director AI", Chief of Staff), the orchestrator-department agent; not marked as primary director | identity resolved by `directorAgent()`; optional override in `ai_director_settings` |
| Orchestration | `kind = orchestrate`: plan by department → subtasks + `task_dependencies` → combine | structured plan, skill-based staffing, handoff records, evaluation, revisions, hiring |
| Runtime | leases, retries, tool loop, per-task limits, usage records | per-agent provider routing, family budget, notifications |
| Providers | Gemini only, REST client, one global client | Claude via the official SDK, router with fallback, classified health |
| Approvals, notifications, audit | exist | reused |
| Calendar | AI routines only | unchanged |
| HQ hiring policy | `unit_policies.hiring_policy = APPROVAL` | applied to AI-initiated hires |

### Cleanup recommendations

Nothing was archived or deleted.

- **Duplicate:** `design-creative-lead` ("Creative Lead", hired on 2026-10-30 as a marketplace test) duplicates the
  seeded `design-sevara` (same role, Creative Lead). Recommendation: archive the test hire.
- **Unused:** all 46 seeded agents have no task history. Keep them through the pilot. Afterwards, archive the ones the
  pilot does not use (Marketplace → Mavjud agentlar), or keep them as the workforce.

## 2. Providers (Phase 1)

### Clients and routing

- **`llm/anthropic.ts`** uses the official `@anthropic-ai/sdk` (1.3.0).
  - **Calls:** `beta.messages.create`; tool calls and tool results keep their ids.
  - **Usage:** taken from the provider, cache tokens included.
  - **Errors:** mapped from the typed SDK classes (most specific first):

    | SDK error | Code |
    |---|---|
    | Authentication / PermissionDenied | `auth` |
    | NotFound | `config` |
    | RateLimit (with `retry-after`) | `rate_limit` |
    | BadRequest | `bad_response` |
    | InternalServerError / connection | `server` |
    | Timeout | `timeout` |
    | Abort | `aborted` |

  - **Refusals:** a `refusal` stop reason becomes `blocked`.
  - **Server-side refusal fallback:** `fallbacks: "default"` is on for the models that accept it. Turn it off with
    `ANTHROPIC_SERVER_FALLBACK=off`.
  - **Health check:** a `models.retrieve` call, so no tokens are spent.
- **`llm/router.ts` (`ProviderRouter`)** is one `LlmClient` for the whole platform.
  - **Provider choice:** per agent (`agents.provider`, `agents.model`); orchestrated jobs use the AI Director's
    settings.
  - **Fallback:** follows `LLM_FALLBACK` (an ordered list) and happens only on rate limits, outages, timeouts and
    credential or config errors. Never on a refusal, a bad request or an abort.
  - **Cost:** each answer is priced at the provider that gave it.
  - **Embeddings and grounded search** stay on Gemini.
- **Gemini** (`llm/gemini.ts`) stays on Google's official REST API. It now accepts a per-request model and returns a
  classified health status. Ruling: no Gemini SDK swap in this sprint (see §13).

### Health statuses

Each provider reports one of `not_configured`, `invalid_credentials`, `rate_limited`, `available` or
`unavailable`. They show at startup, in `/api/workforce` and in the dashboard.

### Configuration and records

- **Settings** (`.env`): `LLM_PROVIDER` (gemini | anthropic | mock), `LLM_FALLBACK`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL` (default `claude-opus-5-5`, changeable without code), `ANTHROPIC_PRICE_*_PER_M`. Prices come from
  the environment and are never hard-coded; 0 means not entered.
- **Credentials:** keys are read from the environment only. They are never put in a request body, a log line or an
  API response; the pino scrubbing from W0 still applies.
- **Tracking:** `agent_runs.provider` and `usage_records.provider` record who answered. Tokens are provider-reported;
  cost is an estimate.

## 3. AI Director (Phase 2)

- **Identity:** the active agent of HQ's orchestrator department. `ai_director_settings` can pin another agent and
  set its provider and model.
- **Limits** (`ai_director_settings`): max subtasks 6, max revisions 2, max pending AI hire requests 3, budget alert
  at 80 %.
- **Tasks:** a task submitted without a department becomes an orchestrated job for the director. This is the existing
  path; no second task system was added.
- **Scope:** the director sees only HQ departments, HQ agents and HQ knowledge (unit-scoped retrieval from W1).

## 4. Task decomposition (Phase 3)

- **The plan** is strict JSON, checked with zod and retried once if invalid. It contains:
  - objective, context and expected outcome;
  - required skills and approval requirements;
  - subtasks: department, skills, deliverable and dependencies (earlier subtasks only);
  - missing skills.
- **Stored as:** JSON in `tasks.plan`, and as the readable deliverable "Ish rejasi" (work plan).
- **Size:** the number of subtasks is capped. A plan above the cap is rejected; after the second invalid answer the job
  fails with the reason.
- **Order:** a subtask waits until its dependencies are DONE, then receives their results as context.

## 5. Delegation and handoff (Phase 4)

### Choosing agents

The platform, not the model, picks each agent (`selectAgent`):

- **Pool:** active HQ agents only — never paused, archived or another unit's.
- **Scoring:** overlap of the needed skills and title with the agent's role, responsibilities and skills, plus a
  bonus for the planned department.
- **Load:** current open tasks and work already given out in the same plan count against an agent.
- **Nobody fits:** the subtask waits unassigned and the AI Director files a hire request.

### Handoff records

- **One per subtask** in `task_handoffs`. Each holds the sender, the recipient (or none yet), the parent, the unit,
  the structured input (objective, description, skills, deliverable, dependencies, why that agent), the output format
  and a link to the task.
- **Status** is the task's own state: pending, queued, running, done, failed, blocked or cancelled. It is never copied,
  so it cannot drift.
- **What agents see:** only their own task and the results of their dependencies. Agents never read each other's
  conversations.

### Limits and loop prevention

- **Delegation depth:** one level. Subtasks are never orchestrated again.
- **Bounded by settings:** subtasks and revisions (`ai_director_settings`), concurrency (the runner), retries
  (per-task attempts), time and tokens (per-task limits).
- **Budget:** the whole job spends from the parent's ceilings. The job is the plan, every subtask and every revision.

## 6. Result evaluation (Phase 5)

### How a result is checked

- **Deterministic check first:** a missing or near-empty deliverable is `NEEDS_REVISION` without asking the model
  (`evaluator = checks`).
- **Then the director's model** judges, as strict JSON:
  - Was the task completed?
  - Is the deliverable there?
  - Is information missing?
  - Does it contradict the other results?
  - Do calculations state their assumptions?
  - Are there sources where needed?
- **An answer that cannot be parsed** becomes `NEEDS_HUMAN_REVIEW`. It is never accepted blindly.

### What each verdict does

| Verdict | What happens |
|---|---|
| `ACCEPTED` | The result is used in the final document. |
| `NEEDS_REVISION` | A revision subtask goes to the same agent, with the feedback and the earlier version as context. The earlier deliverable is kept, and both versions are recorded in `task_evaluations`. |
| `NEEDS_REVISION` at the revision limit | Becomes `NEEDS_HUMAN_REVIEW`. |
| `REJECTED` | The project is blocked and the Human Director is notified. |
| `NEEDS_HUMAN_REVIEW` | The final result goes to the existing approval (`WAITING_APPROVAL`). |

## 7. `request_hire` (Phase 6)

`requestHireForAgent()` uses the existing Marketplace and the same hire-request table; no second hiring module was
built.

- **Who may call it:** only the unit's active AI Director, and only for HQ.
- **When:**
  - the plan lists missing skills;
  - or a subtask finds no agent.
- **What it does:**
  1. Searches the approved templates.
  2. Checks the unit's hiring policy.
  3. Runs the W4 checks (limits, budget, AUTO list, risk).
  4. Records the request with `requested_by_type = agent`.
  5. Notifies the admins.
- **By policy:**

  | Policy | Effect |
  |---|---|
  | `APPROVAL` (default) | Always a PENDING request; a person decides. |
  | `RESTRICTED` | Refused; only a person may hire. |
  | `AUTO` | Hires at once only when every check passes, including the department's AUTO list. |

- **Safeguards:** no duplicate requests, no second agent of a template the department already has, at most 3 pending
  AI requests.
- **Never done:** AI agents never create human accounts.

## 8. Workforce dashboard (Phase 7)

- **Endpoint:** `GET /api/workforce`. It requires `brain:manage` or `users:manage`; an employee gets 403.
- **Dashboard:** "AI ishchi kuchi" (AI workforce) in the top bar. Everything comes from real rows; no progress is
  estimated.
  - **Status:** provider health, and the director with its provider and model.
  - **Counts:** templates; agents (active, available, busy, suspended); pending hire requests; tasks (running,
    completed, failed, blocked).
  - **Usage:** 30-day tokens and estimated spend per provider, with the number of mock calls labelled.
  - **Submit form:** "AI Direktorga topshiriq" (task for the AI Director).
  - **Per project:** objective, every subtask with its agent, dependencies, status, stage, error and verdict, and the
    project's approvals and hire requests.
- **Settings:** `PUT /api/workforce/director` (admin) changes the director's settings. `PUT /api/agents/:id/provider`
  (`agents:manage`) sets one agent's provider and model.

## 9. Notifications (Phase 8)

Sent through the existing `notify()`, deduplicated per task and kind, to the task's creator and HQ admins:

| Kind | When |
|---|---|
| `hire.pending` | A new hire request |
| `project.approval` | A task needs approval |
| `project.blocked` | A subtask failed or was rejected, or nobody fits a piece |
| `project.failed` | The job failed |
| `project.completed` | The job is done |
| `budget.threshold` | The job reached 80 % of its cost ceiling |

**Telegram:** not wired. The existing bot posts to a group only, and personal Telegram notices are still an open item.
`notify()` is the single hook a Telegram sender will attach to; no fake approval cards were built.

## 10. Security

- **Scope:** agents are picked from the task's unit only. Retrieval is unit-scoped (W1). Store agents and franchise
  data are never used.
- **Permissions and tools:** agents cannot grant themselves anything. Grants come from the Marketplace hire (template ∩
  department connectors), and tool calls still go through the ordered W2.1 authorization.
- **No free-form actions:** there is no model-generated HTTP and no code execution.
- **Approvals:** hiring cannot bypass APPROVAL. Writes still need approval.
- **Audit:** plans, evaluations, hire requests, director settings and provider changes are all recorded.

## 11. Tests

| Suite | Result |
|---|---|
| Server | **256 / 256** (23 files) |
| Web | **63 / 63** |
| Typecheck (server, web), production build | pass |

New tests are in `test/director.test.ts` (15 tests; MOCK providers):

- **Providers:**
  - health statuses;
  - Claude tool-call ids, usage and error-class mapping, and the refusal;
  - routing, fallback only on rate limits, no fallback on a refusal, per-provider cost;
  - provider recorded on runs and usage.
- **Final acceptance (MOCK):** the growth-strategy scenario end to end.
- **Evaluation:**
  - a revision that keeps the earlier version;
  - the revision limit leading to human review;
  - a rejection that blocks and notifies;
  - the deterministic empty-result check.
- **Limits:** no delegation loops and the plan-size cap; the whole-project budget.
- **Staffing and hiring:**
  - staffing within the unit and never a paused agent;
  - `request_hire` under APPROVAL, RESTRICTED and AUTO, with no duplicates and only the director allowed;
  - a plan's missing skill turned into a Marketplace request.
- **API:** `/api/workforce` permissions and settings.

Existing orchestrator tests were updated for the evaluation step: their scripted mock now answers the evaluator and
returns full-length results.

### Final acceptance scenario (MOCK providers)

The test is "final acceptance (MOCK providers)" in `director.test.ts`, run on "SAG Home Design uchun choraklik
o'sish strategiyasi" (a quarterly growth strategy for SAG Home Design).

1. The AI Director (`director-director-ai`) receives the task and writes a structured plan (stored).
2. It creates four real subtasks:
   - market research → marketing;
   - marketing plan → marketing, depending on the research;
   - sales opportunities → sales;
   - financial budget → finance, depending on the marketing plan and the sales opportunities.
3. Each subtask is staffed from its department, and four handoff records are written.
4. The agents run. The budget ran last and received the marketing and sales results.
5. Each result is evaluated. A separate test covers a result sent back for revision, with both versions kept.
6. The AI Director combines the accepted results. The final deliverable "Yakuniy natija" (final result) and a
   `project.completed` notification reach the admin.
7. Tokens and cost are recorded on every run. The runs are labelled `mode = mock`.

## 12. Real providers

| Provider | Status on this machine (startup health check) |
|---|---|
| Gemini | **invalid_credentials** ("API key not valid") — the key in `.env` must be replaced |
| Anthropic | **not_configured** — no `ANTHROPIC_API_KEY` |

Because neither provider works, no real model call was made in this sprint, and none is claimed.

## 13. Limitations

- **Gemini client:** stays on the official REST API rather than Google's SDK. It is tested, and swapping it would
  change tool-calling, embeddings and grounded search for no functional gain now.
- **Claude:**
  - JSON is requested by instruction (the existing parser strips fences and validates with zod), not structured
    outputs;
  - long requests do not stream.
- **Planning:**
  - skill matching is word overlap, not semantic;
  - a subtask with no agent waits until a person assigns it after the hire.
- **Evaluation:** cross-result contradiction checking relies on the director model; there is no deterministic
  numeric reconciliation.
- **Budgets:** the per-project budget is in USD, at the configured prices. UZS budgets (W1) are not yet linked to AI
  spend.
- **Not built:**
  - Telegram notices and approval cards;
  - other units (stores) and their AI Directors' hiring;
  - a Custom Agent Builder beyond the Marketplace template editor (W4).
- **UI:** the dashboard was not checked in a browser: signing in needs the owner's password. The data API is tested.
