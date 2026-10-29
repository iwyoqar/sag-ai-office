# Phase 2 hisoboti — Core backend (2026-10-29)

## Nima yaratildi
- **`apps/server`** — Node 24 + TypeScript + Fastify 5, `tsx` bilan ishga tushadi.
- **Ma'lumotlar bazasi** — `node:sqlite` (o'rnatilgan, FTS5 bor) + SQL migratsiya runner (`schema_migrations`). `001_init.sql`: 28 jadval — users/roles/permissions/sessions, floors/departments/agents/instructions, connectors (+credential refs, bo'lim va agent ruxsatlari), tasks/dependencies/events/messages/deliverables/approvals, agent_runs/tool_executions/usage_records, routines/routine_runs, knowledge_sources/documents/chunks, company_memory, audit_logs. FK, CHECK, UNIQUE va indekslar bilan. Prisma o'rniga — sababi ARCHITECTURE.md da.
- **Seed** — 7 qavat, 12 bo'lim, 19 connector (hammasi `disconnected`), 46 agent (hammasi `IDLE`, vazifasiz), global ko'rsatma, rollar/ruxsatlar, admin. Idempotent.
- **Auth** — scrypt parol xeshi, httpOnly session cookie (DB da faqat token xeshi), login rate-limit, 5 rol va ruxsat jadvali, audit log (secret'lar avtomatik `[redacted]`).
- **Agentlar** — CRUD, connector ruxsatlari (bo'limga ruxsat etilmagani rad etiladi), pause/resume, stop (faqat o'z ishi), archive (ochiq vazifalarni topshirish yoki bekor qilish talab qilinadi, tarix saqlanadi), boshqa bo'limga ko'chirish.
- **Vazifalar** — CRUD, avtomatik yo'naltirish (bo'limdagi eng kam band agent), yagona status o'tishlar jadvali (`packages/shared`), atomik o'tishlar (parallel yozuvchi 409 oladi), dependency (halqa rad etiladi, tugaganda avtomatik bo'shatish), cancel kaskadi, retry, reassign, progress, worker claim (lease, ikki marta olib bo'lmaydi), lease tugaganda qayta navbat (crash recovery).
- **Statistika** — `/api/stats` real jadvallardan, Asia/Tashkent kun chegaralari, bugun/7/30/custom.
- **Realtime** — SSE `/api/events`; har hodisa avval `task_events` ga yoziladi, qayta ulanganda `Last-Event-ID` orqali o'tkazib yuborilganlar qayta yuboriladi.
- **Frontend** — demo ma'lumotlar butunlay olib tashlandi. Login oynasi; qavatlar, bo'limlar, agentlar, connectorlar, statistika — API dan; SSE orqali jonli yangilanish (3D figuralar holati joyida yangilanadi, ro'yxat o'zgarsa qavat qayta quriladi); agent profilida Pause/Resume/Stop ishlaydi (ruxsatga qarab).
- **Hujjatlar** — `docs/API.md`, `.env.example`.

## Testlar
- Server: **37/37** (`npm test -w apps/server`) — DB/migratsiya (idempotentlik, FK/CHECK/UNIQUE, restartdan keyin saqlanish, rollback), auth (401, cookie, logout, xato parol, rate-limit, audit'da secret yo'q), avtorizatsiya (rollar, faqat o'z vazifasini tahrirlash), agentlar (yaratish, connector cheklovi, validatsiya, pause/resume, archive strategiyalari, stop izolyatsiyasi, transfer), vazifalar (routing, validatsiya, o'tishlar, eskirgan yozuvchi, retry/reassign, cancel kaskadi, dependency bo'shatish, halqa), **parallel claim** (ikki DB ulanish, 20 vazifa — dublikat yo'q), prioritet/paused/dependency, lease recovery, statistika (Tashkent vaqti, real qiymatlar), SSE (jonli + qayta ulanishda replay, 401).
- Web: **11/11** — geometriya, layout, tween, qavat tanlash/qaytish, statistika yig'indisi.
- `tsc --noEmit` (server, web) va `vite build` — xatosiz.
- Brauzerda: login (xato parol xabari, to'g'ri kirish), real statistika (0 lar, o'ylab topilmagan), API orqali vazifa yaratish/yakunlash va agent pause → UI sahifani yangilamasdan yangilandi, profildan Pause/Resume.

## Hali tayyor emas
- Agentlar hali **ishlamaydi**: vazifalar QUEUED holatida qoladi, chunki Claude API runner yo'q (Phase 3). Agent statuslari shuning uchun hammasi IDLE.
- Task paneli UI (yaratish/filtr/detal oynasi) — Phase 6; hozir API orqali.
- Foydalanuvchilarni boshqarish UI/endpoint (`users:manage`) — admin hozircha seed orqali; keyingi bosqichlarda.
- PostgreSQL adapteri — Phase 8.

## Ishga tushirish
```
npm install
npm run server   # API → http://127.0.0.1:4000 (birinchi start: migratsiya + seed)
npm run dev      # web → http://localhost:5173
```
Admin paroli: `.env` dagi `ADMIN_PASSWORD` (birinchi startda ishlatiladi). Bo'sh bo'lsa server logida bir marta chiqadi.

## Keyingi bosqich — Phase 3
Claude client (Anthropic SDK, model konfiguratsiyasi, timeout/retry/backoff/rate-limit, correlation ID), agent instruction engine (Global → Department → Agent), agent run lifecycle (claim → kontekst → Claude → tool calls → deliverable → status), usage/xarajat hisobi, kalitsiz mock rejim (aniq belgilangan), agent chat.
