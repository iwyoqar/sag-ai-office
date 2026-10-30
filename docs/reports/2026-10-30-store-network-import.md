# Home Design store network — import into SAG AI World (2026-10-30)

Owner request: every store from `Книга1.xlsx` becomes its own business unit and 3D building, with one human director
account, one AI Director agent, its own employees/tasks/KPIs, and strict isolation of franchise data.
Scope delivered: a working subset of SAG World W1 (org tree), W2 (unit isolation, data-sharing agreements),
W3 (provisioning, AI Director) and V (world view), started ahead of W0 at the owner's explicit request.

## Source workbook

`C:\Users\User\Downloads\Telegram Desktop\Книга1.xlsx`, sheet `Лист1`, sha256
`4a7b1d32b0b54060698f0d346e16befb55596ae6cd9e4c5e7d2b612a99ad8da5`. Layout: a region header row
(`<Region> Sag Magazin`) followed by its stores; marker `hd`/`f` (lowercase) in column C, D, E or F.
No addresses, coordinates, phones or directors in the file — none were invented.

| Region (as written) | Stores | HD (SAG-owned) | F (franchise) |
|---|---|---|---|
| Samarkand | 5 | 4 | 1 |
| Navoiy | 3 | 0 | 3 |
| Toshkent Shaxar | 6 | 5 | 1 |
| Xorazm | 3 | 1 | 2 |
| Qoraqalpog'iston | 1 | 0 | 1 |
| Toshkent viloyat | 1 | 0 | 1 |
| Jizzax | 2 | 0 | 2 |
| Surxandaryo | 1 | 1 | 0 |
| **Total** | **22** | **11** | **11** |

Store names are kept exactly as written (including `Yunusobsod`, `Sharof rashidof k`).

## Classification

| Marker | business_type | ownership_model | source_brand | source_marker |
|---|---|---|---|---|
| HD | SAG_BRANCH | SAG_OWNED | HOME_DESIGN | HD |
| F | INDEPENDENT_DEALER | FRANCHISE | HOME_DESIGN | F |

## Import result (dev database `data/sag.db`)

- Backup before import: `data/backups/before-store-import-2026-10-30T11-52-34-166Z.db`.
- Batch `imp_97a0c8ef6d264cee`: 22 units created, 7 regions created (Toshkent viloyat already existed as HQ's region),
  22 human directors (PENDING_ACTIVATION, no password, `is_active = 0`), 22 AI Directors (one per unit, hiring policy
  APPROVAL).
- Re-run (batch `imp_540bd0f72fe143b9`): 0 created, 22 unchanged, 0 directors, 0 AI Directors — idempotent.
- Tree now: 1 GROUP, 8 REGIONs, 23 UNITs (22 stores + `hq`). Existing HQ records unchanged (1 user, 46 agents,
  12 departments). `PRAGMA foreign_key_check`: 0 violations. No geo/address values stored.

Command: `npm run import:stores -w apps/server -- "<workbook.xlsx>"` (dry run) and `... --apply` (backs up, migrates,
imports in one transaction; records file name, sha256 and timestamp in `store_import_batches`).

## Database changes — migration `010_org_tree.sql`

New tables: `legal_entities`, `org_nodes` (+ `ownership_model`, `source_brand`, `source_marker`, `source_label`,
`import_batch_id`, `provision_key`), `store_import_batches`, `unit_memberships` (one `unit_director` per unit, unique
index), `user_invitations` (SHA-256 token hashes, expiry, single use), `data_sharing_agreements`, `unit_policies`.
Rebuilt: `departments` (+ `business_unit_id`, `floor_id` nullable). Added columns: `agents.business_unit_id`,
`agents.is_primary_director` (unique per unit while not archived), `tasks.business_unit_id`, `users.home_unit_id`,
`users.activation_status`, `audit_logs.business_unit_id`, `task_events.business_unit_id`. Roles `unit_director`,
`unit_manager`, `unit_staff`. Triggers refuse cross-unit references (task ↔ department/agent/parent/assignee/reviewer,
agent ↔ department, user ↔ department) and invalid tree shapes. Existing organisation → `sag-group` →
`toshkent-viloyat` → `hq`.

Deviations from docs/SAG_WORLD_DATA_MODEL.md: `legal_entity_id` is optional (franchise legal entities unknown);
agreements are proposed by the owning unit's director and become active when the grantee side approves
(`approved_by` nullable until then); composite FKs replaced by triggers (SQLite cannot add table constraints by ALTER).

Incident during this work: the running dev server (`tsx watch`) applied an early draft of 010 to `data/sag.db`.
Repaired in place after a backup (`data/backups/before-010-repair-2026-10-30T11-49-59-719Z.db`): two missing columns
added, ten triggers recreated from the final file; the schema now equals a fresh migration (120 objects compared).

## Authorisation (server-side)

- Store accounts may call only `/api/auth/*`, `/api/units*`, `/api/agreements/*`, `/api/notifications`; every
  company-wide route answers 403. On HQ routes an `:id` belonging to another unit answers 404 (agents, tasks, work,
  employees, users, departments, approvals, routines).
- Company-wide lists, stats, calendar, connector log, approvals, audit log, SSE stream and Telegram are limited to
  HQ (`business_unit_id = 'hq'`); the HQ audit log also shows SAG-owned units, never franchise entries.
- `domain/units.ts unitAccess()`: own unit members by role; HQ group level (admin/director) sees SAG_BRANCH units in
  detail; HQ memberships on a region with `include_descendants` cover SAG_BRANCH units only; franchise data only via
  active, approved, unexpired agreements, limited to their data classes (`people_counts`, `employees`, `tasks`, `kpi`,
  `ai_usage`) and level. HQ platform admins manage structure (assign director, approve agreements) without data access.
- Directors manage only their unit; they can give only `unit_manager`/`unit_staff`, never change themselves, never
  reach `user_roles` (company roles).
- AI Directors run on the existing runtime; for non-HQ tasks the runner loads no HQ documents/memory, writes no HQ
  memory, and `toolsFor()` returns no tools (no per-unit connector installations yet). The prompt states the unit.

## Files

Server: `db/migrations/010_org_tree.sql`, `domain/units.ts`, `routes/units.ts`, `import/{xlsx,stores,cli}.ts` (new);
`app.ts`, `lib/{auth,audit,events}.ts`, `domain/{tasks,access,agents,org,users,employees,stats,brain}.ts`,
`routes/{auth,tasks,events,brain}.ts`, `agents/{runner,prompt}.ts`, `connectors/{hub,tools}.ts`,
`schedule/service.ts`, `telegram/bot.ts`, `package.json` (script `import:stores`), `test/units.test.ts` (new),
`test/db.test.ts`. Shared: `dto.ts`, `index.ts`. Web: `scene/network/NetworkScene.ts`, `ui/NetworkView.tsx` (new);
`App.tsx`, `ui/{TopBar,Login}.tsx`, `api/{office,stats,system}.tsx/ts`, `styles.css`.

## Tests

| Suite | Result |
|---|---|
| Server (vitest), 12 files | **131 passed / 0 failed** (118 existing + 13 new in `units.test.ts`) |
| Web (vitest), 3 files | **39 passed / 0 failed** |
| Typecheck server + web | pass |
| Web production build | pass |

`units.test.ts` covers: workbook parsing and rejection; import counts, classification, pending directors,
one AI Director per unit, idempotent re-run, dry run writes nothing; DB refuses a second AI Director / human director;
activation (token single use, password policy, pending accounts cannot sign in); only platform admins assign
directors; the ten isolation cases of the request (own store, other stores, franchise vs SAG-owned vs HQ, HQ without
agreement, agreement scope / revoke / expiry, region alone grants nothing, employees inside their unit, AI agents
cannot cross units). Mutation check: disabling the business-type rule or the store-account route fence each turns
3 tests red.

Browser check (isolated stack on a scratch copy: API :4100 with Telegram/LLM/connectors/worker off, web :5174):
franchise director sees only their store; HQ admin sees 22 stores + head office in 8 region plots, HD/F badges and
legend counts 11/11/8; franchise panel for HQ shows card, director status and AI Director only; store employee sees
only own tasks and makes no HQ API calls.

Not run: parallel stress runs; real AI Director execution with Gemini (verification used the mock provider);
deployment to Render.

## Manual actions remaining

1. For each store: HQ admin opens the store in **Do'konlar** → "Haqiqiy direktorni tayinlash", enters the real
   person, hands over the one-time code (valid 7 days); the director activates on the sign-in screen.
2. Real addresses / coordinates when available (the 3D layout is schematic until then).
3. Franchise legal entities (TIN) and data-sharing contracts, then agreements in the app (API exists; no UI yet).
4. Per-unit connectors and knowledge base (W2) before store AI Directors get tools.
5. Production: the migration and import have run only on the dev DB; on Render run the import with `--apply`
   after deploy (it backs up first).
