# Agent Marketplace (W4, HQ first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HQ agents are hired only from a catalog of approved templates. Department heads hire within limits on
their own (AUTO), and everything else goes to the admin. Every check is recorded. The 46 seeded agents become the
catalog and are then archived by the admin.

**Architecture:** Migration 017 adds four tables and two `agents` columns. Server code is split three ways:
- `domain/marketplace.ts`: checks, hiring, decisions, templates, limits and archive-all.
- `domain/templatesFromAgents.ts`: a pure function that groups agents into templates.
- `routes/marketplace.ts`: thin zod routes.

Hiring reuses `createAgent` (desk, grants, instruction, audit, events) inside the decision transaction. The web side
is a `MarketplacePanel` modal opened from the TopBar.

**Tech Stack:** Fastify 5, node:sqlite (`Db` wrapper, nested `tx` via SAVEPOINT), zod, vitest; React 18 + TS.

**Spec:** `docs/superpowers/specs/2026-10-30-agent-marketplace-design.md`

## Global Constraints

- **Policy.** Hiring policy is AUTO for HQ heads. The admin is anyone with `users:manage`. A head is a user who is
  `departments.head_user_id`, and only for those departments.
- **Who can hire.** No AI agent can hire: there is no tool and no agent-callable path. `requested_by_type` is only
  `'user'`.
- **Money.** UZS in tiyin, as an INTEGER: `est_monthly_minor` and `monthly_budget_minor`. `null` limits mean "no
  limit".
- **Hard checks** reject: `template_approved`, `department_allowed`, `tools_within`, `pending_cap` (5 PENDING per
  department).
- **Soft checks** send the request to the admin: `agent_count`, `budget`, `auto_listed`, `risk` (HIGH).
- **Grants.** Granted tools = the template's `tools` ∩ the department's allowed connectors (`department_connectors`).
  Never more.
- **Versions.** An approved template version is immutable; edits create a new DRAFT version.
- **Decisions.** The checks re-run inside the decision transaction. The request moves with
  `UPDATE … WHERE status = 'PENDING'`, and 0 changed rows means no agent is created.
- **UI copy** is Uzbek, as in the spec: "Yollash", "darhol yollanadi", "admin tasdig'iga boradi",
  "rad etiladi: …", "narx kiritilmagan", "agent arxivlandi".
- **Deviation from the spec.** Seeded templates get `approved_by = NULL` and `approved_note = 'mavjud agentlardan'`.
  `approved_by` is a foreign key to `users(id)`, so `'system:migration-017'` cannot be stored.
- **Tools representation:** `[{ "connectorId": string, "actions": ("read" | "write")[] }]`. This mirrors
  `agent_connector_permissions.allowed_actions`.

## Review Focus

- **A head of two departments** may request hires for both, and for no other department. *Test in Task 4.*
- **The template gets a new approved version while a request for v1 is PENDING.** Approval rejects with
  `template_approved` ("andoza yangilangan") and notifies the head; no agent is created from a stale version.
  *Test in Task 4.*
- **The department allows none of the template's connectors.** The hire still succeeds with zero grants.
  `tools_within` passes, and its `detail` lists the dropped connectors. *Test in Task 3.*
- **`max_agents = 0`.** Every head request goes to the admin. With `max_agents = null`, count never blocks.
  *Test in Task 3.*
- **A justification that is only whitespace** gets 400, and nothing is recorded. *Test in Task 6.*

---

### Task 1: Migration 017 and shared DTOs

**Files:**
- Create: `apps/server/src/db/migrations/017_agent_marketplace.sql`
- Modify: `packages/shared/src/dto.ts` (append marketplace DTOs)
- Modify: `apps/server/test/db.test.ts:13` (append `"017_agent_marketplace.sql"` to the migration list)

**Interfaces:**
- Produces, as tables:
  - `agent_templates`: `id` TEXT PK, `business_unit_id` TEXT NOT NULL DEFAULT 'hq', `name`, `category`,
    `status` CHECK IN ('DRAFT','APPROVED','RETIRED'), `allowed_departments` TEXT DEFAULT '[]',
    `current_version` INTEGER, `created_by` TEXT REFERENCES users(id), `created_at`.
  - `agent_template_versions`:
    - PK (`template_id`, `version`);
    - `role`, `responsibilities`, `skills` DEFAULT '[]', `instructions` DEFAULT '', `tools` DEFAULT '[]';
    - `model`, `max_tokens_per_task` INTEGER, `est_monthly_minor` INTEGER NOT NULL DEFAULT 0 CHECK ≥ 0;
    - `risk_level` CHECK IN ('LOW','MEDIUM','HIGH');
    - `created_by`, `created_at`, `approved_by` REFERENCES users(id), `approved_at`, `approved_note`.
  - `agent_hire_requests`: the spec's §2 columns plus `override` INTEGER NOT NULL DEFAULT 0. Index on
    (`department_id`, `status`).
  - `department_hiring_limits`: `department_id` PK REFERENCES departments(id), `max_agents` INTEGER, `monthly_budget_minor`
    INTEGER, `auto_templates` TEXT DEFAULT '[]', `updated_by`, `updated_at`.
  - `ALTER TABLE agents ADD COLUMN template_id TEXT` and `ADD COLUMN template_version INTEGER`.
- Produces, as DTOs in `@sag/shared`:
  - `TemplateTool = { connectorId: string; actions: ("read" | "write")[] }`.
  - `TemplateVersionDto`: version, role, responsibilities, skills, instructions, tools, model, maxTokensPerTask,
    estMonthlyMinor, riskLevel, approvedAt, approvedNote.
  - `TemplateDto`: id, name, category, status, allowedDepartments, currentVersion, `current: TemplateVersionDto | null`,
    `draft: TemplateVersionDto | null`, `hiredCount: number`.
  - `HireCheckId`: the union of the 8 check ids.
  - `HireCheck = { id: HireCheckId; ok: boolean; hard: boolean; detail: string }`.
  - `HireOutcome = "hire" | "pending" | "reject"`.
  - `HireRequestDto`: id, templateId, templateVersion, templateName, departmentId, requestedBy {id, name},
    justification, checks, status, decidedVia, decidedBy, decisionReason, override, agentId, createdAt, decidedAt.
  - `HiringLimitDto`: departmentId, maxAgents | null, monthlyBudgetMinor | null, autoTemplates, activeAgents,
    committedMinor.

- [ ] **Step 1:** Append `"017_agent_marketplace.sql"` to the expected list in `db.test.ts`. Run
  `npx vitest run test/db.test.ts` and expect FAIL (list mismatch).
- [ ] **Step 2:** Write the migration and the DTOs as above.
- [ ] **Step 3:** Run `npx vitest run test/db.test.ts` and `npx tsc --noEmit -p .` in `apps/server`. Expect PASS and
  no output.
- [ ] **Step 4:** Commit with message `Marketplace: migration 017 and shared DTOs`.

### Task 2: Catalog from the existing agents

**Files:**
- Create: `apps/server/src/domain/templatesFromAgents.ts`
- Modify: `apps/server/src/db/seed.ts` (call `ensureAgentTemplates(db)` on both the early-return path and after
  seeding)
- Test: `apps/server/test/marketplace.test.ts` (new file, `describe("catalog from agents")`)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:
  - `groupAgents(agents: SourceAgent[]): TemplateSeed[]`. It is pure.
    - `SourceAgent = { id, name, role, departmentId, skills: string[], responsibilities, model, maxTokensPerTask,
      instructions: string, tools: TemplateTool[] }`.
    - `TemplateSeed = { id, name, category, departmentId, version: Omit<TemplateVersionDto, "version" | "approvedAt"
      | "approvedNote">, agentIds: string[] }`.
    - The grouping key is `departmentId + normalised role`: lowercase, trimmed, spaces collapsed. The id is
      `slug(departmentId + "-" + role)`. `category` is the department id.
    - Texts come from the first agent in id order. Tools are the union by connector, with actions unioned.
    - `riskLevel` is HIGH when any tool's actions include "write", LOW otherwise.
  - `ensureAgentTemplates(db: Db): number`.
    - It does nothing and returns 0 when `agent_templates` has any row.
    - Otherwise it reads the non-archived HQ agents with their latest active AGENT instruction and their
      `agent_connector_permissions`.
    - For each group it inserts a template (APPROVED, `allowed_departments = [departmentId]`, `current_version = 1`)
      and version 1 (`approved_at = now`, `approved_note = 'mavjud agentlardan'`).
    - It sets `agents.template_id` and `template_version = 1`, and returns the number of templates created.

- [ ] **Step 1: Write the failing tests**
  - `groupAgents merges same role in a department, unions tools, flags write as HIGH`: two agents, same department,
    roles `"SMM Specialist"` and `" smm  specialist"`. Tools are `[{gmail,[read]}]` and `[{gmail,[write]}, {drive,[read]}]`.
    Expect one seed, `agentIds.length === 2`, tools `gmail [read, write]` and `drive [read]`, risk `HIGH`.
  - `ensureAgentTemplates on the seeded DB`:
    - after `makeApp()`, there is at least 1 template;
    - every non-archived HQ agent has a non-null `template_id`;
    - every template is APPROVED with `current_version` 1;
    - a second call returns 0.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement both functions and call `ensureAgentTemplates(db)` from `seed()`.
- [ ] **Step 4:** Run the same command. Expect PASS. Then run `npx vitest run test/db.test.ts test/seed*.ts`. Expect
  PASS.
- [ ] **Step 5:** Commit with message `Marketplace: templates from the existing agents`.

### Task 3: Checks, limits and templates (domain)

**Files:**
- Create: `apps/server/src/domain/marketplace.ts`
- Test: `apps/server/test/marketplace.test.ts` (`describe("checks")`, `describe("templates and limits")`)

**Interfaces:**
- Consumes: Task 1 tables and DTOs, and `getDepartment(ctx, id)` from `domain/org.ts` (`.connectors`, `.isActive`).
- Produces:
  - `headDepartments(ctx: Ctx, userId: string): string[]` returns `SELECT id FROM departments WHERE head_user_id = ?`.
  - `checkHire(ctx: Ctx, i: { templateId: string; version?: number; departmentId: string; requester: "admin" |
    "head" }): { checks: HireCheck[]; outcome: HireOutcome; grants: TemplateTool[] }`.
    - The 8 checks run in the spec's order.
    - `version` defaults to `current_version`. `template_approved` fails if the template is not APPROVED, if the
      version is not `current_version`, or if the version is unapproved.
    - `outcome`: any failing hard check gives `"reject"`. Otherwise, for a head, any failing soft check gives
      `"pending"`. A head with everything passing gets `"hire"`. An admin with only soft failures also gets `"hire"`;
      the override is decided by the caller, see Task 4.
  - `listTemplates(ctx, u: AuthUser): TemplateDto[]`. Heads see only APPROVED templates.
  - `createTemplate(ctx, u, i: { name; category; allowedDepartments: string[]; version: VersionInput }):
    TemplateDto`. It is admin only. It creates a DRAFT template and draft version 1, and `riskLevel` is computed
    from the tools.
  - `addVersion(ctx, u, templateId, v: VersionInput): TemplateDto` creates a new DRAFT version (max + 1).
  - `approveVersion(ctx, u, templateId, version): TemplateDto` sets `approved_by`/`approved_at`,
    `current_version = version` and `status = 'APPROVED'`.
  - `retireTemplate(ctx, u, templateId): TemplateDto` sets status RETIRED.
  - `getLimits(ctx, u): HiringLimitDto[]` covers every active HQ department: all for the admin, own for heads.
    `committedMinor` is Σ the current-version `est_monthly_minor` of the department's non-archived agents with a
    template.
  - `setLimit(ctx, u, departmentId, p: { maxAgents?: number | null; monthlyBudgetMinor?: number | null;
    autoTemplates?: string[] }): HiringLimitDto` is admin only and upserts.
  - `VersionInput = { role; responsibilities; skills: string[]; instructions; tools: TemplateTool[]; model: string |
    null; maxTokensPerTask: number | null; estMonthlyMinor: number }`.
  - Every non-admin write throws `forbidden()`, and every write is audited (`marketplace.*`).

- [ ] **Step 1: Write the failing tests**
  - `each check fails on its own with a recorded detail`. Starting from a valid baseline, change one thing at a
    time:
    - retire the template, expect `template_approved` false and outcome `reject`;
    - use a department not in `allowedDepartments`, expect `department_allowed` false and `reject`;
    - insert 5 PENDING rows, expect `pending_cap` false and `reject`;
    - `maxAgents` = current count, expect `agent_count` false and `pending` for a head;
    - budget below committed + cost, expect `budget` false and `pending`;
    - template not in `autoTemplates`, expect `auto_listed` false and `pending`;
    - a write tool, expect `risk` false and `pending`.
  - `max_agents 0 sends every head request to the admin; null never blocks` (Review Focus).
  - `grants are template tools ∩ department connectors; none allowed still passes`. A template has `[gmail, drive]`
    and the department allows only `drive`: expect grants `[drive]`. A department allowing neither: grants `[]`,
    `tools_within.ok === true`, and `detail` mentions `gmail` (Review Focus).
  - `approved versions are immutable; edits make drafts`. `addVersion` after approval gives
    `current.version === 1` and `draft.version === 2`. `approveVersion(2)` moves `current` to 2.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement `domain/marketplace.ts` (the functions above).
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit with message `Marketplace: hire checks, templates and limits`.

### Task 4: Hire requests and decisions

**Files:**
- Modify: `apps/server/src/domain/agents.ts` (`AgentInput` + `createAgent`)
- Modify: `apps/server/src/domain/marketplace.ts`
- Test: `apps/server/test/marketplace.test.ts` (`describe("hiring")`)

**Interfaces:**
- Consumes: `checkHire`, `headDepartments` (Task 3), and `notify(ctx, { userId, kind, title, body, dedupeKey })`
  from `domain/notifications.ts`.
- Produces:
  - `AgentInput` gains `grants?: TemplateTool[]` and `template?: { id: string; version: number }`.
    - When `grants` is given it replaces the `connectorIds` handling, and each grant row stores `actions` as
      `allowed_actions`.
    - `template` is written to `agents.template_id` and `template_version`.
    - `checkConnectors` still runs on the grant connector ids.
  - `requestHire(ctx, u, i: { templateId: string; departmentId: string; justification: string; override?: boolean }):
    HireRequestDto`.
    - Who may call:
      - the admin, any department; with soft failures, `override: true` is required, otherwise
        `conflict("override_required")`;
      - a head, own departments only, otherwise `forbidden()`;
      - anyone else gets `forbidden()`.
    - An empty, trimmed justification gives `badRequest`.
    - The row is inserted with `checks`.
    - When the outcome is `reject`: status REJECTED, `decided_via = 'policy'`, reason = the failing hard check details.
    - When the outcome is `hire`: the agent is created, status APPROVED, `decided_via = 'policy'` for a head or
      `'user'` for the admin, `override` as given.
    - When the outcome is `pending`: status PENDING, and every admin is notified (`kind 'hire.pending'`).
  - `approveRequest(ctx, u, id, override: boolean): HireRequestDto` is admin only.
    - It re-runs `checkHire` with the request's version: a hard failure gives REJECTED with the reason; soft
      failures without `override` give `conflict("override_required")`.
    - It moves the request with `UPDATE … SET status='APPROVED' … WHERE id=? AND status='PENDING'`; 0 changes gives
      `conflict("already_decided")` and no agent is created.
    - It creates the agent and notifies the requester (`'hire.decided'`).
  - `rejectRequest(ctx, u, id, reason: string): HireRequestDto` is admin only. The reason is required. It notifies
    the requester.
  - `cancelRequest(ctx, u, id): HireRequestDto` is for the requester while PENDING.
  - `listRequests(ctx, u): HireRequestDto[]`: all for the admin, own departments for heads, newest first, PENDING
    first.
  - The created agent is named `template.name`. Role, responsibilities, skills, model, `maxTokensPerTask` and
    instructions come from the version.

- [ ] **Step 1: Write the failing tests** (use `addUser` plus `PUT /api/departments/:id/head`, or a direct
  `UPDATE departments SET head_user_id`):
  - `AUTO: a head's fully passing request hires at once`:
    - status APPROVED, `decidedVia 'policy'`, `agentId` set;
    - the agent has `template_id` and a workstation;
    - its grants equal `checkHire().grants`.
  - `soft failure → PENDING; admin approval re-runs checks and needs override`:
    - set `maxAgents` = count, so the request is PENDING and the admin has a `hire.pending` notification;
    - `approveRequest(…, false)` gives 409 `override_required`;
    - `approveRequest(…, true)` gives APPROVED with `override 1`.
  - `hard failure at decision time rejects`: retire the template after the request, then approve. Expect REJECTED,
    the reason mentions `template_approved`, and no new agent.
  - `new approved version while pending → rejected as stale` (Review Focus).
  - `concurrent approvals create one agent`: call `approveRequest` twice in sequence. The second throws
    `already_decided`, and the agent count grows by 1 only.
  - `head of two departments requests for both, not a third` (Review Focus).
  - `rejectRequest needs a reason and notifies the requester`.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement the `createAgent` extension and the request functions.
- [ ] **Step 4:** Run the same command plus `npx vitest run test/agents*.ts test/connectors*.ts`. Expect PASS (the
  existing `createAgent` behaviour is unchanged when `grants` is absent).
- [ ] **Step 5:** Commit with message `Marketplace: hire requests, AUTO policy and admin decisions`.

### Task 5: Archive the seeded agents

**Files:**
- Modify: `apps/server/src/domain/marketplace.ts`
- Test: `apps/server/test/marketplace.test.ts` (`describe("archive all")`)

**Interfaces:**
- Consumes: `archiveAgent(ctx, id, { strategy: "cancel" }, actor)` from `domain/agents.ts`. Check the existing
  `OpenTaskStrategy` value for cancel and use it. The cancel note is "agent arxivlandi".
- Produces:
  - `archivePreview(ctx, u): { agents: number; openTasks: number }`: non-archived HQ agents that are not primary
    directors, and their open tasks. It is admin only.
  - `archiveAll(ctx, u): { archived: number; cancelledTasks: number }`. It runs in one transaction, audits
    `marketplace.archive_all`, and is admin only.

- [ ] **Step 1: Write the failing test**
  - `archive-all: preview counts, cancels open tasks, keeps history, idempotent`:
    - create one task for a seeded agent;
    - the preview equals the counts;
    - after `archiveAll`, the task is CANCELLED, every HQ agent is ARCHIVED, and the `tasks` and `audit` rows still
      exist;
    - a second call returns `{ archived: 0, cancelledTasks: 0 }`.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit with message `Marketplace: archive all seeded agents`.

### Task 6: HTTP routes

**Files:**
- Create: `apps/server/src/routes/marketplace.ts`
- Modify: `apps/server/src/app.ts` (`await app.register(marketplaceRoutes(deps))`)
- Test: `apps/server/test/marketplace.test.ts` (`describe("API")`)

**Interfaces:**
- Consumes: every Task 3–5 function. It follows the pattern of `routes/people.ts` (`parse(schema, req.body)`,
  `requireUser(req)`).
- Produces: the endpoints in spec §6, with these response shapes:
  - `{ templates }`, `{ template }`, `{ limits }`, `{ limit }`;
  - `{ checks, outcome, grants }` for `POST /check`;
  - `{ request }`, `{ requests }`, `{ agents, openTasks }`, `{ archived, cancelledTasks }`.
  - Status codes: POST create gives 201; check and approve give 200.
- Body schemas, in zod:
  - `justification: z.string().trim().min(3).max(1000)`;
  - `reason: z.string().trim().min(3)`;
  - `override: z.boolean().optional()`;
  - `estMonthlyMinor: z.number().int().min(0)`;
  - `tools: z.array(z.object({ connectorId: z.string(), actions: z.array(z.enum(["read", "write"])).min(1) }))`.

- [ ] **Step 1: Write the failing tests**
  - `API permissions`:
    - an employee gets 403 on `POST /api/marketplace/requests`;
    - a head gets 403 for another department and 403 on `PUT /api/marketplace/limits/:id` and on `archive-all`;
    - the admin gets 200 on all of them.
  - `whitespace justification is 400 and records nothing` (Review Focus): count `agent_hire_requests` before and
    after.
  - `POST /check writes nothing`: the request count is unchanged.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts`. Expect FAIL (404s).
- [ ] **Step 3:** Implement the routes and register them.
- [ ] **Step 4:** Run `npx vitest run` (full server). Expect every test to pass.
- [ ] **Step 5:** Commit with message `Marketplace: HTTP routes`.

### Task 7: Marketplace UI

**Files:**
- Create: `apps/web/src/ui/marketplace/outcome.ts`, `apps/web/src/ui/marketplace/MarketplacePanel.tsx`
  (tabs Katalog, So'rovlar, Andozalar, Limitlar, Mavjud agentlar; split into `Catalog.tsx`, `Requests.tsx`,
  `Templates.tsx`, `Limits.tsx` and `ArchiveAll.tsx` if the panel passes about 300 lines)
- Modify: `apps/web/src/ui/TopBar.tsx` (prop `onMarketplace?: () => void`; the "Marketplace" button shows when
  `can("users:manage") || user?.managedDepartments?.length`)
- Modify: `apps/web/src/App.tsx` (`marketplaceOpen` state, render the panel)
- Modify: `apps/web/src/ui/BrainPanel.tsx:482-485` (the hire form becomes a note plus a button that opens the
  marketplace)
- Modify: `apps/web/src/styles.css` (a `.marketplace` block)
- Test: `apps/web/test/marketplace.test.ts`

**Interfaces:**
- Consumes: Task 6 endpoints and `@sag/shared` DTOs. It uses the existing `useLoad`, `run`, `Msg`, `Loading` and
  `Empty` from `ui/people/common`.
- Produces:
  - `outcomeLabel(outcome: HireOutcome, checks: HireCheck[]): { tone: "ok" | "warn" | "bad"; text: string }`:
    - `hire` gives "darhol yollanadi";
    - `pending` gives "admin tasdig'iga boradi: " plus the failing soft check details joined with "; ";
    - `reject` gives "rad etiladi: " plus the failing hard check details.
  - `formatUzs(minor: number): string` returns "narx kiritilmagan" for 0. Otherwise it gives so'm with thousand
    separators (minor / 100, rounded).

- [ ] **Step 1: Write the failing test**
  - `outcomeLabel maps each outcome with the failing details`;
  - `formatUzs(0) === "narx kiritilmagan"` and `formatUzs(125_000_000) === "1 250 000 so'm"`.
- [ ] **Step 2:** Run `npx vitest run test/marketplace.test.ts` in `apps/web`. Expect FAIL.
- [ ] **Step 3:** Implement `outcome.ts`, then the panel, the TopBar button, the App wiring and the Brain link.
  - **Hire dialog:** heads see only `managedDepartments`. Show `outcomeLabel` from `POST /check` before submitting.
    The admin sees an override checkbox when the outcome needs one.
  - **Andozalar:** the editor edits the draft (creating one with `POST versions`). It shows approve and retire
    buttons and lists the agents hired from the template.
  - **Mavjud agentlar:** load the preview, then confirm with `window.confirm` listing both counts.
- [ ] **Step 4:** Run `npx vitest run` and `npx tsc --noEmit` in `apps/web`. Expect PASS and no output.
- [ ] **Step 5:** Commit with message `Marketplace: web panel`.

### Task 8: Verify in the browser and update the docs

**Files:**
- Modify: `docs/SAG_WORLD_IMPLEMENTATION_PLAN.md` (W4 status: HQ marketplace ✅; stores, `request_hire` tool and
  Telegram card ⏳)
- Modify: `docs/IMPLEMENTATION_PLAN.md` (a new status row)

- [ ] **Step 1:** Restart the dev server so migration 017 and the templates apply. The automatic pre-migration
  backup is made. Open the app as admin. Expect the "Marketplace" button and a catalog with the migrated templates.
- [ ] **Step 2:** In the Limitlar tab, set Marketplace limits for one department. Then hire one template into it.
  Open that floor and expect the new agent at a desk.
- [ ] **Step 3:** Do not run archive-all on the dev database without the owner's go-ahead in chat. Show the preview
  counts only.
- [ ] **Step 4:** Run the server and web test suites, `npx tsc --noEmit` in both apps, and `npx vite build`.
  Expect everything to pass.
- [ ] **Step 5:** Update the docs and commit with message `Marketplace: docs and status`.
