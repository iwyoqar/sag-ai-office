# Agent marketplace (W4, HQ first) — design

Date: 2026-10-30. Status: approved in conversation by the owner, awaiting spec review.
Builds on: `docs/SAG_WORLD_DATA_MODEL.md` §3.4 (marketplace schema), `docs/SAG_WORLD_ARCHITECTURE.md` §7.2 (hiring
policies), `docs/SAG_WORLD_IMPLEMENTATION_PLAN.md` W4.

## 1. Goal and decisions

The 3D office should contain only agents hired through a marketplace. Every hire must be checked and recorded with
its reason. Department heads should be able to hire routine agents without waiting for the admin.

Owner decisions:
- The 46 seeded HQ agents are **archived**. Their history (tasks, costs, audit) is kept.
- **Hiring policy: AUTO.** A department head hires on their own within limits. Anything outside the limits goes to
  the admin for approval.
- **The catalog is built from the 46 existing agents**: their role, responsibilities, skills, instructions, tool
  grants and model.
- **Approach 1**: the documented W4 schema, built for HQ now, so the store units (W3/W4) can use it later unchanged.

Decided on the owner's "no preference": all four limits apply. They are agent count per department, the templates a
department may hire, the monthly AI budget in UZS, and the risk level. A template with write tools is always HIGH
risk and always goes to the admin.

Out of scope for this step:
- store units;
- the AI Director's `request_hire` tool;
- Telegram approval cards;
- deducting real AI spend from budgets (estimated monthly cost only).

## 2. Data model (migration 017)

**`agent_templates`**
- Fields: `id`, `name`, `category`, `status` (`DRAFT` | `APPROVED` | `RETIRED`), `allowed_departments` (JSON array;
  empty means any HQ department), `created_by`, `created_at`.
- The `business_unit_id` column defaults to `'hq'`, so templates can be per unit later.

**`agent_template_versions`**
- Primary key: (`template_id`, `version`).
- Fields:
  - `role`, `responsibilities`, `skills` (JSON), `instructions`, `tools` (JSON);
  - `model` (nullable = platform default), `max_tokens_per_task`;
  - `est_monthly_minor` (UZS tiyin, integer, default 0);
  - `risk_level` (`LOW` | `MEDIUM` | `HIGH`);
  - `created_by`, `created_at`, `approved_by`, `approved_at`.
- An approved version never changes; editing creates a new DRAFT version.
- The template points at its current published version: `agent_templates.current_version`.

**`agent_hire_requests`**
- As in the data model doc §3.4.
- Additions:
  - `requested_by_type` is only `'user'` in this step (`'agent'` stays reserved);
  - `checks` holds the JSON result of every check;
  - `decided_via` is `'policy'` (AUTO) or `'user'`;
  - `override` (0/1) records an admin approval past a limit.
- Status values: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`.

**`department_hiring_limits`**
- Fields: `department_id` (PK), `max_agents` (nullable = no limit), `monthly_budget_minor` (nullable = no limit),
  `auto_templates` (JSON array of template ids the head may hire without approval), `updated_by`, `updated_at`.

**`agents`** gets two new columns: `template_id` and `template_version` (nullable for history).

## 3. Catalog from the existing agents

This is a pure function plus migration step `buildTemplatesFromAgents`. It runs once in migration 017, and only on
active and paused HQ agents.

- **Grouping.** Agents with the same normalised role in the same department become one template. Its id is a slug
  of the department and role. `allowed_departments` is that department.
- **Version 1.** Fields come from the agent:
  - `role`, `responsibilities`, `skills`, `model`, `max_tokens_per_task`;
  - `instructions` is the latest AGENT-scope instruction text;
  - `tools` is the agent's connector grants.

  Where a group has several agents, the version takes the union of their tools and the first agent's text.
- **Status.** `APPROVED`, with `approved_by = 'system:migration-017'`. These are the settings already running.
- **Cost.** `est_monthly_minor = 0`; the admin fills it in.
- **Risk.** `risk_level` is computed from `tools` against the tool registry: HIGH when any tool is a write tool,
  LOW otherwise.
- **Existing agents.** Each gets its `template_id` and `template_version`, so the history shows where hires came
  from.

## 4. Archiving the 46 agents

The migration does not archive anything. Archiving is an admin action:
- `GET /api/marketplace/archive-preview` returns how many agents would be archived and how many open tasks would be
  cancelled.
- `POST /api/marketplace/archive-all` does it in one transaction:
  - every open task of those agents is cancelled with the note "agent arxivlandi" (agent archived);
  - every non-archived HQ agent is archived and its desk freed;
  - everything is audited;
  - running a second time archives nothing and returns 0.

The existing per-agent archive keeps its rule: an agent with open tasks cannot be archived without reassigning them.

## 5. Hiring

**Who may do what**

| Actor | Can |
|---|---|
| Admin (`users:manage`) | Hire into any HQ department, manage templates, versions and limits, decide requests, archive all. |
| Department head (`departments.head_user_id`) | Request a hire into their own department only, with a justification (required). |
| Anyone else, including every AI agent | Cannot hire. No endpoint and no tool. |

**Checks.** Every request and every decision runs `checkHire()`. Each check is recorded in `checks` as
`{ id, ok, detail }`. Checks are of two kinds:

- **Hard checks** — failing one rejects the request:
  1. `template_approved`: the template is APPROVED and the version is the current approved one.
  2. `department_allowed`: the department is active and in `allowed_departments`, or the list is empty.
  3. `tools_within`: tools granted = template tools ∩ connectors installed for the department. The hire never
     grants a tool outside the template.
  4. `pending_cap`: at most 5 PENDING requests per department.
- **Soft checks** — failing one sends the request to the admin:
  5. `agent_count`: active and paused agents in the department + 1 ≤ `max_agents`.
  6. `budget`: Σ `est_monthly_minor` of the department's non-archived agents + the template's ≤ `monthly_budget_minor`.
  7. `auto_listed`: the template is in the department's `auto_templates`.
  8. `risk`: `risk_level` is not HIGH.

**Outcome**
- Any hard check fails: the request is REJECTED with its reason, and no agent is created.
- A head's request where every check passes: it is APPROVED at once (`decided_via = 'policy'`) and the agent is
  created.
- A head's request where only soft checks fail: it is PENDING and the admin is notified.
- The admin's own hire: hard checks must pass. If soft checks fail, the UI shows them and the admin confirms with
  `override = 1`.
- An admin decision on a PENDING request: the checks run again inside the decision transaction.
  - A hard check that now fails means the request cannot be approved.
  - A soft check that fails needs `override = 1`.
- A rejection records its reason and notifies the head.

**Creating the agent**

All of this happens in the same transaction as the decision:
- a new agent in the department, with name, role, responsibilities, skills, model and token limit from the version;
- an AGENT instruction with the version's instructions;
- connector grants = `tools_within`;
- `template_id` and `template_version`;
- the next free workstation (3D plans grow, see `scene/office/plan.ts`);
- audit `agent.hire`, the `agent.updated` event, and a notification to the requester.

The request row is updated with `UPDATE … WHERE status = 'PENDING'`. A second concurrent approval changes no rows
and creates no agent.

**The Brain.** The old "Yangi agentni ishga olish" (hire new agent) form is replaced by a link to the marketplace.
Pause, resume, transfer and archive stay.

## 6. API (`routes/marketplace.ts`)

| Method | Path | Who |
|---|---|---|
| GET | `/api/marketplace/templates` | admin, heads (approved only for heads) |
| POST | `/api/marketplace/templates` | admin, creates a DRAFT template with version 1 |
| POST | `/api/marketplace/templates/:id/versions` | admin, creates a new DRAFT version |
| POST | `/api/marketplace/templates/:id/versions/:v/approve` | admin |
| POST | `/api/marketplace/templates/:id/retire` | admin |
| GET / PUT | `/api/marketplace/limits` | GET: admin and heads (own department); PUT: admin |
| POST | `/api/marketplace/check` | admin, heads; returns the checks and the predicted outcome, writes nothing |
| POST | `/api/marketplace/requests` | admin, heads |
| GET | `/api/marketplace/requests` | admin all, heads own departments |
| POST | `/api/marketplace/requests/:id/approve` (body `{ override? }`) and `/reject` (body `{ reason }`) | admin |
| POST | `/api/marketplace/requests/:id/cancel` | the requester, while PENDING |
| GET | `/api/marketplace/archive-preview` | admin |
| POST | `/api/marketplace/archive-all` | admin |

Validation uses zod. Errors use the existing error envelope.

## 7. UI

A **"Marketplace"** button in the TopBar, shown to the admin and department heads, opens a modal with tabs.
- **Katalog** (catalog). Template cards show:
  - name, role, short responsibilities, tools, model;
  - a risk badge and the monthly cost, or "narx kiritilmagan" (no price yet).

  There are category and department filters and a search box. **"Yollash"** (hire) opens a form: department
  (heads see only their own) and justification. The predicted outcome from `/check` shows as one of "darhol
  yollanadi" (hired now), "admin tasdig'iga boradi" (goes to the admin), or "rad etiladi: …" (rejected, with the
  reason).
- **So'rovlar** (requests):
  - heads see their own requests with status and checks;
  - the admin sees all, PENDING first, with "Tasdiqlash" (approve) and "Rad etish" (reject, reason required);
  - soft-check failures need an explicit override tick.
- **Andozalar** (templates, admin only):
  - a template list with versions;
  - editing creates a draft;
  - "Tasdiqlash" publishes and "Eskirgan" (retired) removes the template from the catalog;
  - the agents hired from each template are listed.
- **Limitlar** (limits, admin only): one row per department with max agents, monthly budget (UZS) and the AUTO
  template list.
- **Mavjud agentlar** (existing agents, admin only): the archive-all preview and a confirm button.

## 8. Errors and edge cases

| Case | Handling |
|---|---|
| A template is retired, or a department deactivated, while a request is pending | The approval fails a hard check, the request is rejected with the reason, and the head is notified. |
| A head loses the head role | Their pending requests stay for the admin to decide. They cannot make new requests. |
| Cost is 0 | Counts as 0 in the budget. The catalog shows "narx kiritilmagan". |
| Archive-all runs twice | Nothing more is archived. The result is 0. |
| Concurrent approvals | One agent at most (conditional update, see §5). |

## 9. Testing

Server (vitest, in-memory DB):
- **Migration 017.** Templates are created from the seeded agents, the same roles are merged, agents are linked and
  risk is computed.
- **Checks.** Each check fails on its own and is recorded with its reason. Hard checks reject; soft checks go to
  PENDING.
- **AUTO.** A head's request that passes everything creates an agent at once, with `decided_via = 'policy'`.
- **Admin decision.** Checks re-run when the admin decides. Override is needed for soft failures, and a hard failure
  blocks approval.
- **Tools.** A hire grants exactly template ∩ installed tools.
- **Permissions.** A head cannot hire into another department (403). An employee cannot hire at all (403). No AI
  agent gets a hire tool.
- **Concurrency.** Two approvals of the same request create one agent.
- **Archive-all.** The preview counts are right, open tasks are cancelled, history is kept, and it is idempotent.

Web (vitest): the outcome badge mapping from check results.

Browser: catalog → hire as admin → the agent appears at a desk on its floor.

## 10. Files

New:
- `db/migrations/017_agent_marketplace.sql`
- `domain/marketplace.ts` (checks, hire, decisions, templates, limits, archive-all)
- `domain/templatesFromAgents.ts` (pure grouping, used by the migration step)
- `routes/marketplace.ts`
- `test/marketplace.test.ts`
- `apps/web/src/ui/marketplace/*` (`MarketplacePanel`, `Catalog`, `Requests`, `Templates`, `Limits`, `ArchiveAll`)

Changed:
- `app.ts` (routes)
- `db/db.ts` (if the migration needs a TypeScript step)
- `packages/shared` DTOs
- `TopBar.tsx`, `App.tsx`
- `BrainPanel.tsx` (hire form replaced by a link)
- docs: the implementation plan status
