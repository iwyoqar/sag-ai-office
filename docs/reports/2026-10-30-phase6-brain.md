# Report — Phase 6: The Brain (2026-10-30)

## Company knowledge
- Sources: the "SAG Holding" presentation (HTML) and the marketing internship report "Gilam qanday ishlab chiqariladi?"
  (PDF). Text was extracted locally; nothing was sent elsewhere.
- `docs/company/kompaniya-haqida.md` → global instruction **"Kompaniya haqida"** (short; part of every agent's system prompt).
- Knowledge documents (company-wide, versioned, BM25 + Gemini embeddings):
  - "SAG Holding — kompaniya profili" (11 companies, history, figures, export markets);
  - "SAG gilam zavodi — ishlab chiqarish va uskunalar" (process map, extrusion/twisting/heat-set machines, 37 looms table,
    lab tests, glue line, finishing, Plan department, marking codes, SAG Home Design system);
  - "SAG gilam kolleksiyalari va dizayn" (design process, 6 styles, raw materials, 27 collections with segments).
- Loader: `apps/server/scripts/load-company-knowledge.ts` (uses the API, so versioning, embeddings and audit apply).
- Live check (Gemini): "how many looms" → 37 (30 Vandewiele + 7 Schönherr), largest 150-reed №34/№36, with the source cited.

## Agent actions through connectors
| Kind | Tools | Runs |
|---|---|---|
| Internal (all agents) | `search_company_knowledge`, `list_company_people`, `propose_company_memory` | at once |
| Internal (granted) | `create_employee_task` | after approval, with the approver's rights |
| Web search | `web_search` (Gemini + google_search grounding) | at once |
| Telegram | `telegram_post_group` | after approval |
| Gmail | `gmail_search` / `gmail_send` | at once / after approval |
| Drive | `drive_search` / `drive_create_document` | at once / after approval |
| Sheets | `sheets_read` / `sheets_append` | at once / after approval |
| Calendar | `calendar_list_events` / `calendar_create_event` | at once / after approval |
| Slack | `slack_list_channels` / `slack_post_message` | at once / after approval |
| Notion | `notion_search` / `notion_create_page` | at once / after approval |

- Permission = department may use the connector **and** the agent holds a read (or read + write) grant **and** the
  connector is really connected. Arguments are validated before anything leaves the server.
- Write calls create an approval showing exactly what will be sent; a person with `tasks:manage` approves (runs once,
  claimed atomically) or rejects with a reason. Every call (incl. denied/invalid) is in `tool_executions` + audit log.
- The runner lets the model use tools up to 4 rounds, then forces the answer, and appends an honest "Amallar" list
  (done / waiting for approval / error) to the deliverable.
- Google: OAuth consent from the UI; the refresh token is stored AES-256-GCM encrypted (`SECRETS_KEY` only in env);
  access tokens only in memory. Slack / Notion tokens only in env. Tokens are never returned by any API.

## Fixes found on the way
- A Gemini 429 asking to wait for hours (daily quota) made the client sleep for ~9 h and freeze the task. Now any wait
  over 90 s fails at once with a clear message ("taxminan 3 soatdan keyin…"); back-off waits are abortable.
- Lease recovery now also closes the crashed worker's open `agent_runs` row ("uzildi").

## Verification
- Server: 117 tests (9 new connector tests against a fake HTTP layer: permissions, read/write split, approval-once,
  Gmail message format and token refresh, invalid/denied calls never leave the server, approver rights for employee
  tasks, encrypted OAuth storage, state check, no OAuth without `SECRETS_KEY`; Gemini function-call format; quota 429).
- Web: 39 tests, typecheck clean.
- Live with Gemini: function declarations accepted; the model called `web_search` and the runner executed it.
  The search itself hit the Gemini free-tier daily limit, so a full live web-search answer is **not yet verified**.
- UI checked in the browser: Connectorlar shows real state, tools, setup needs and the action log.

## Needed from the company
- Google: OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), `SECRETS_KEY`, `PUBLIC_URL`; then "Google bilan ulash".
- Slack `SLACK_BOT_TOKEN`, Notion `NOTION_TOKEN` (if used).
- CRM / ERP / accounting / ads / analytics / recruiting: which product (Bitrix24, amoCRM, 1C, SAP, …) and API access.

## Not done / limits
- Chat with an agent (profile chat) does not use tools yet — tasks do.
- Agent actions are approved in the web app only (Telegram `/approve` stays for result approvals).
- Gemini free tier: per-day limits stop agents until the quota resets; a paid key or a second provider removes this.
