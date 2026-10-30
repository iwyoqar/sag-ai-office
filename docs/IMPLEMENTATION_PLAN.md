# SAG AI OFFICE — Implementation plan

Current master prompt: "Realistic 3D Office, Autonomous AI Agents, The Brain & Telegram Integration" (2026-10-29).
It replaces the earlier phase numbering. Work already done is mapped below, so nothing working is rebuilt.

Status legend: ✅ done & verified · 🟡 partial · ⬜ not started

## Phase map

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 0 — Audit | code, GLB, stack, docs | ✅ | `PROJECT_AUDIT.md`, `ARCHITECTURE.md`, this file |
| 1 — 3D prototype | intro, building, hover, floor select, camera, back, fallback | ✅ | [report](reports/2026-10-29-3d-prototype.md) |
| 1b — Real-world campus | campus layout from photos/satellite, industrial buildings, roads, parking, vehicles, campus/building/office camera modes, labels, building panel | ✅ | [layout & assumptions](CAMPUS_LAYOUT.md) |
| 2 — First realistic interior | one complete floor: architecture, furniture, glass, plants, light/AO, human characters, navigation, backend-driven behaviours | ✅ | 5 — Marketing, hand-made plan; see [INTERIOR_BACKLOG.md](INTERIOR_BACKLOG.md) |
| 3 — All floor interiors | extend the validated kit to B, 1–4, 6 with department layouts | ✅ | generated per-floor plans (`zonePlan`) with department signature furniture; `?simple` keeps the old zone view |
| 4 — Backend & agent runtime | DB, auth, agents, tasks, lifecycle, SSE, AI runner (Gemini; provider interface ready for Claude), usage, chat, task UI | ✅ | [backend](reports/2026-10-29-core-backend.md) · [runtime](reports/2026-10-29-agent-runtime.md) |
| 5 — Orchestrator & collaboration | decomposition, DAG, parallel runs, messages, aggregation | ✅ | Director plans → subtasks → handoffs → final; approvals; task limits (tokens, cost, time, AI calls, subtasks) with UI; handoffs drawn as 3D arcs |
| 6 — The Brain | knowledge + RAG, instructions, agent mgmt UI, connectors UI, agent actions | ✅ | company profile + knowledge from the SAG Holding presentation and the factory report (`docs/company`); agent tool calling (Gemini functions) with per-call approval for write actions; internal tools, web search, Telegram post; Gmail/Drive/Sheets/Calendar/Slack/Notion ready, active once credentials are set; CRM/ERP/accounting/ads etc. wait for the product choice — [report](reports/2026-10-30-phase6-brain.md) |
| 7 — Telegram | Bot API, group, commands, idempotency, notifications, approvals | ✅ | long polling (dev) or webhook with secret header (prod); commands, approvals, notifications, admin/allowed IDs in The Brain |
| 8 — Calendar & analytics | routines scheduler, calendar views, usage | ✅ | RRULE routines (Asia/Tashkent), server-side scheduler, month/week/day calendar, stats |
| 8b — Human employees & workflow | employee accounts, org hierarchy, scoped/delegable permissions, human task lifecycle with review, subtasks + parent aggregation, workload indicator, notifications, People UI, employees in 3D | ✅ | [plan](HUMAN_EMPLOYEES_PLAN.md) · [report](reports/2026-10-30-human-employees.md) · [workload](WORKLOAD.md) |
| 9 — Integration & production | Postgres adapter, security review, perf, deploy docs | ⬜ | |

## Phase 2 — design decisions

**Visual direction.** Realistic isometric architectural model, not low-poly/voxel. When a floor opens it becomes a
*diorama*: the floor slab and its interior float on a teal surround; the rest of the building and the ground are hidden.
The transition still starts from the real GLB: top and bottom clip planes close in on the floor's band of the actual
building before the diorama walls take over at the same coordinates.

**Architecture of a floor.** Built from the facade outline in `build_sag_building.py` (same `outline()` port as Phase 1):
white perimeter walls with floor-to-ceiling glass bays (curved curtain wall on the front bulge), cut at a constant
section height so the camera sees in. Interior partitions, glass meeting rooms, white desks, ergonomic chairs, monitors,
keyboards, plants in white pots, lounge furniture and display walls.

**Rendering.** PBR materials + room environment map, soft PCF sun shadows framed on the open floor, GTAO ambient
occlusion (floor view only), render-on-demand outside floor view. Repeated furniture parts are `InstancedMesh`.

**Characters.** Procedural rig (hips → spine → chest → neck → head; shoulder/elbow/hand; hip/knee/foot), real human
proportions (~1.75 m), varied skin/hair/clothing per agent derived from a stable hash of the agent id. Pose library
(stand, walk, sit, type, think, talk, wait, blocked, error, celebrate) blended in joint space.

**Navigation.** Occupancy grid (0.2 m) rasterised from the plan's obstacle rectangles + walls, A* with 8-neighbours,
line-of-sight smoothing; agents walk between approach points and sit/stand with short scripted transitions.

**Backend → behaviour.** `status`/`lifecycle` from the API decide the activity; nothing is randomised:

| Backend | Activity |
|---|---|
| IDLE | seated, relaxed (decorative breathing / glance) |
| WORKING | seated at own desk, typing |
| THINKING | seated, hand to chin |
| COMMUNICATING | walks to the meeting table, talks |
| WAITING_APPROVAL | stands at desk, amber marker |
| BLOCKED | seated, hands on head, orange marker |
| ERROR | stands at desk, red marker |
| COMPLETED | stands and stretches, then sits |
| PAUSED (lifecycle) | seated, dimmed, "paused" plate |

**Stable workstations.** `agents.workstation` (per department, unique among non-archived agents) is persisted;
seeded in roster order, next free index on hire/transfer, freed on archive.

## Still open (outside Phase 9)
- Connector credentials: Google OAuth client + `SECRETS_KEY`, Slack and Notion tokens (code ready); CRM/ERP/accounting/ads/analytics/recruiting: product choice needed (e.g. Bitrix24, amoCRM, 1C, SAP).
- Company profile text ("Kompaniya haqida") and Telegram admin user IDs: waiting for the owner.
- People: personal Telegram notices, calendar/availability (see the 2026-10-30 report).

## Open items / risks
- No reference image was attached to the prompt; the style follows the written description.
- Rigged licensed character assets are not available offline; the procedural rig is the documented fallback.
- Telegram: the previously exposed bot token must be revoked; the new one goes only into `.env`.
