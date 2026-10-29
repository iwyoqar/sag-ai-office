# SAG AI OFFICE — Arxitektura

## 1. Umumiy ko'rinish

```
┌──────────────────────────── Browser ─────────────────────────────┐
│ React + TS (Vite)                                                │
│  ├─ 3D: Three.js (imperativ SceneController, React'dan ajratilgan)│
│  ├─ UI: floor panel, task panel, agent profile, Brain, calendar  │
│  └─ Realtime: SSE (/api/events) → store                          │
└───────────────▲──────────────────────────────▲───────────────────┘
                │ REST (JSON, cookie session)  │ SSE
┌───────────────┴──────────────────────────────┴───────────────────┐
│ Node.js + TS backend (Fastify)                                   │
│  ├─ Auth (session cookie, roles: admin/director/hr/member/viewer)│
│  ├─ Domain: departments, floors, agents, tasks, approvals        │
│  ├─ Orchestrator: decompose → DAG → assign → parallel run → merge│
│  ├─ Agent runtime: Claude client (Anthropic SDK), tools, limits  │
│  ├─ Brain: docs upload, extract, chunk, FTS search, instructions │
│  ├─ Connectors: registry, permissions, health, credential refs   │
│  ├─ Scheduler: routines (Asia/Tashkent), DB lease, no double-run │
│  ├─ Job queue: DB-backed (atomic claim + lease + retry/backoff)  │
│  └─ Event bus → SSE + TaskEvent/AuditLog persist                 │
└───────────────┬──────────────────────────────────────────────────┘
                │ Prisma
        SQLite (dev)  /  PostgreSQL (prod)
```

## 2. Texnologiya tanlovi (va sababi)

| Qatlam | Tanlov | Sabab |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Talabdagi stack; mavjud stack yo'q edi. |
| 3D | Three.js (to'g'ridan-to'g'ri) | R3F qo'shimcha qatlam; sahna bitta, imperativ boshqaruv (clipping, tween, render-on-demand) oddiyroq va tezroq. |
| Animatsiya | O'zimizning kichik tween util | GSAP faqat kamera tween uchun ortiqcha bog'liqlik. |
| Stil | Oddiy CSS + design tokenlar | Komponentlar kam; Tailwind keyin kerak bo'lsa qo'shiladi. |
| Backend | Node 24 + TS + Fastify | Yengil, tez, schema validatsiya; NestJS bu hajm uchun og'ir. |
| DB | **Node 24 `node:sqlite` + SQL migratsiyalar** (dev), PostgreSQL (prod, Phase 8) | Phase 2 da o'zgartirildi: Prisma engine'ni yuklab olish npm install-scripts siyosati bilan bloklanadi va native binary qo'shadi. O'rnatilgan `node:sqlite` (FTS5 bilan) hech qanday bog'liqliksiz ishlaydi. SQL portativ yozilgan (positional params, TEXT ISO vaqt, JSON → TEXT, `RETURNING`, CHECK constraintlar). Postgres uchun `Db` wrapper'ga `pg` adapteri qo'shiladi. |
| Queue | DB-backed jobs | Redis yo'q; yuklama kichik. Interfeys ajratilgan — BullMQ'ga almashtirish mumkin. |
| Realtime | SSE | Bir tomonlama oqim yetarli; buyruqlar REST orqali. Proxy/HTTP2 bilan mos. |
| LLM | `@anthropic-ai/sdk`, faqat backend | Kalit `.env` da; frontendga hech qachon chiqmaydi. |
| Search | SQLite FTS5 / Postgres `tsvector` | Haqiqiy ishlaydigan BM25 qidiruv; embedding provayderi sozlansa pgvector. |
| Testlar | Vitest (web + server), API integratsiya testlari | Kalitsiz — mock Claude client, natijalar "mock" deb belgilanadi. |

## 3. Repo tuzilishi (npm workspaces)

```
/3d                    mavjud model va generator (o'zgartirilmaydi)
/apps/web              React + Three.js frontend
  src/scene/           SceneController, buildingGeometry, clouds, agents3d, tween
  src/config/floors.ts qavat ↔ bo'lim xaritasi (Phase 2 dan keyin API'dan)
  src/ui/              panellar
  src/data/demo.ts     DEMO ma'lumotlar (aniq belgilangan)
/apps/server           (Phase 2) Fastify + Prisma
/docs                  audit, arxitektura, API, test hisobotlari
```

GLB `apps/web/public/models/` ga build vaqtida nusxalanadi (`scripts/sync-model`), manba `3d/` da qoladi.

## 4. 3D sahna dizayni

- **Yuklash**: GLB bir marta (`GLTFLoader`), loader progress UI'da.
- **Intro**: bulut sprite klasterlari (canvas'da generatsiya qilingan yumshoq tekstura) → kamera bulutlar orasidan uchadi, bulutlar radial tarqaladi → binoga zoom. Birinchi tashrif ~4.5 s, takroriy ~1.8 s (`localStorage`), `prefers-reduced-motion` → darhol yakuniy kadr. Istalgan vaqtda Skip.
- **Qavat zonalari**: `outline()` (Python skriptdan port) asosida har qavat uchun ekstruziya qilingan qobiq; ko'rinmas raycast nishoni + hover overlay (emissive band + kontur).
- **Kesim**: `renderer.localClippingEnabled`; tanlangan qavat shifti bo'yicha `Plane(0,−1,0, top)`. Bino materiallari `DoubleSide`. Yuqori qavatlar shaffof ghost (teskari clipping) — kontekst saqlanadi.
- **Interyer**: plita, bo'lim zonalari (rangli), xona devorlari, stollar, monitorlar, agent figuralari (umumiy geometriya/material, kerak bo'lsa `InstancedMesh`).
- **Podval**: yer osti beton qutisi; tanlanganda `paving`/`asphalt` materiallari yashiriladi.
- **Render-on-demand**: animatsiya/tween/controls harakati bo'lmasa kadr chizilmaydi.
- **Fallback**: WebGL yo'q bo'lsa — 2D qavatlar sxemasi, xuddi shu panellar bilan.

## 5. Domen modeli (Phase 2 — `apps/server/src/db/migrations/001_init.sql`)

Eslatma: `AgentInstruction` alohida jadval emas — `instructions` jadvali `scope = GLOBAL | DEPARTMENT | AGENT` bilan uchala darajani versiyalab saqlaydi. `Subtask` — `tasks.parent_id`. `Floor`/`Department` ma'lumotlari endi DB da; frontend ularni `/api/floors` dan oladi.

Asosiy entity'lar va munosabatlar:

- `User` —< `UserRole` >— `Role` —< `RolePermission` >— `Permission`
- `Floor` 1—< `Department` 1—< `Agent`
- `Agent` 1—< `AgentInstruction` (versiyalangan), `AgentConnectorPermission` >— `Connector`
- `Connector` 1—< `ConnectorCredentialReference` (faqat secret storage kaliti, qiymat emas), `DepartmentConnector`
- `Task` (self-relation `parentId` — subtask), `TaskDependency (taskId, dependsOnId)` UNIQUE
- `Task` 1—< `TaskEvent`, `AgentMessage`, `Deliverable`, `Approval`, `AgentRun` 1—< `ToolExecution`, `UsageRecord`
- `Routine` 1—< `RoutineRun` (UNIQUE `routineId + scheduledFor` — ikki marta ishga tushishdan himoya)
- `KnowledgeSource` 1—< `KnowledgeDocument` 1—< `KnowledgeChunk` (+ FTS indeks)
- `Instruction` (scope: GLOBAL | DEPARTMENT | AGENT, version, isActive)
- `CompanyMemory` (qarorlar, tuzatishlar, saboqlar)
- `AuditLog` (actor, action, target, correlationId, metadata — secret'larsiz)

### Statuslar (yagona manba: `packages/shared/status.ts`)
- Agent: `IDLE, THINKING, WORKING, COMMUNICATING, WAITING_APPROVAL, BLOCKED, ERROR, COMPLETED` + lifecycle `ACTIVE, PAUSED, ARCHIVED`
- Task: `BACKLOG → QUEUED → IN_PROGRESS → (WAITING_FOR_DEPENDENCY | WAITING_APPROVAL | BLOCKED) → DONE | FAILED | CANCELLED`
- O'tishlar jadval orqali tekshiriladi (`canTransition(from, to)`); noto'g'ri o'tish — 409.

### Parallel ishda dublikatdan himoya
Ishni olish: `UPDATE task SET status='IN_PROGRESS', leaseOwner=?, leaseUntil=? WHERE id=? AND status='QUEUED'` — faqat `rowsAffected=1` bo'lsa davom etadi. Lease muddati o'tsa, recovery ishni qayta navbatga qo'yadi.

## 6. Agent ishlash sikli (Phase 3)

1. Job claim (lease) → 2. task + access tekshiruvi → 3. instruktsiyalar: Global → Department → Agent (ustuvorlik: xavfsizlik qoidalari har doim Global'dan, keyin eng aniq scope) → 4. Brain'dan FTS kontekst (faqat ruxsat etilgan manbalar, `<document>` teglari ichida, "ma'lumot, buyruq emas" deb belgilangan) → 5. ruxsat etilgan tool'lar → 6. Claude API (timeout, retry + exponential backoff, 429 `retry-after`) → 7. tool call validatsiya va bajarish (yozish/yuborish/to'lov — `Approval` yaratadi va kutadi) → 8–10. deliverable saqlash → 11. status → 12. SSE event.

Har chaqiruv: `AgentRun` (correlationId, model, input/output tokens, cost, latency, error).
Limitlar task darajasida: `maxAgents, maxIterations, maxTokens, maxCostUsd, maxDurationMs`; agentlararo xabarlar soni cheklangan (loop himoyasi).

## 7. Orchestrator (Phase 4)

Katta task → Claude'ga structured output (JSON schema) bilan dekompozitsiya: `subtasks[{key, title, department, role, dependsOn[]}]` → DAG tekshiruvi (sikl yo'q, limitlar) → har subtask uchun agent tanlash (bo'lim + ko'nikma + yuklama) → dependency'si yo'q subtasklar parallel → natija `Deliverable` + `AgentMessage(handoff)` orqali keyingi subtaskka kontekst → oxirida synthesis agent birlashtiradi → foydalanuvchiga.

## 8. Xavfsizlik

- Secret'lar faqat server env / secret storage; DB da faqat `credentialRef`. Connector tokenlari AES-256-GCM (`SECRET_ENCRYPTION_KEY`) bilan shifrlanadi.
- Har API endpoint role/permission tekshiradi; agent tool'lari server tomonida ruxsat jadvali bo'yicha filtrlanadi — model o'zi ruxsat qo'sha olmaydi.
- Tashqi yozish/yuborish/to'lov/xarid — har doim `Approval` (inson).
- Prompt injection: hujjat va foydalanuvchi matni system prompt'ga qo'shilmaydi, faqat belgilangan ma'lumot bloklarida; tool natijalari ham ma'lumot sifatida.
- Log'larda secret redaction.

## 9. Bosqichlar
Phase 0 audit → 1 3D frontend → 2 core backend → 3 Claude API → 4 orchestrator → 5 Brain → 6 dashboard/calendar → 7 connectors → 8 integration/production. Har bosqich oxirida build + test + `docs/PHASE_N_REPORT.md`.
