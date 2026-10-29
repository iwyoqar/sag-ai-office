# SAG AI OFFICE — Phase 0 audit

Sana: 2026-10-29. Muallif: Claude (audit avtomatik bajarildi).

## 1. Loyiha papkasi holati

| Fayl | Holat | Izoh |
|---|---|---|
| `3d/build_sag_building.py` | Mavjud, 23 KB | Protsedural generator (numpy + Pillow). Blender kerak emas. Binoning barcha o'lchamlari shu yerda. |
| `3d/sag-bino.glb` | Mavjud, 2.26 MB | Skript chiqishi. 1 node, 1 mesh, 16 primitive (har material uchun bittadan), ~33k uchburchak, 2 ichki PNG tekstura. |
| `3d/viewer.html` | Mavjud | `@google/model-viewer` orqali oddiy ko'ruvchi. Interaktivlik yo'q. |
| `.claude/launch.json` | **Yo'q edi** | Phase 1 da yaratildi. |
| `package.json`, backend, DB | **Yo'q** | Loyiha stacki belgilanmagan — yangidan tanlanadi (ARCHITECTURE.md). |
| Git | Repo emas | `git init` tavsiya etiladi (foydalanuvchi qaroriga qoldirildi). |

Muhit: Windows 11, Node 24.21, npm 11.19, Python 3.12. **PostgreSQL, Docker, Redis, Blender o'rnatilmagan.**

## 2. 3D model tahlili

Koordinatalar: metr, `+Y` — yuqoriga, `+Z` — old fasad (ko'cha tomoni).

### Qavat balandliklari (skriptdagi `PLINTH`, `FL`, `TOP`)

| Model qavati | Y oralig'i (m) | SAG bo'limi |
|---|---|---|
| — (yer osti, geometriya yo'q) | −3.6 … 0.0 | Podval — IT |
| 1-qavat | 0.75 … 5.0 | Reception |
| 2-qavat | 5.0 … 8.6 | B2B Sales + Designers |
| 3-qavat | 8.6 … 12.2 | Procurement |
| 4-qavat | 12.2 … 15.8 | Director + The Brain + Finance |
| 5-qavat | 15.8 … 19.4 | Marketing |
| 6-qavat | 19.4 … 23.0 | HR + Home Design + Digitalization |
| Tom | 23.0 … 24.8 (+ logo 28.6, antenna 33.8) | — |

Model 6 ta yer usti qavatiga ega — bu foydalanuvchi talab qilgan 1–6 qavatlarga to'liq mos keladi.

### Footprint (asosiy blok)
- To'g'ri to'rtburchak `x ∈ [−18, 18]`, `z ∈ [−12, 8]`.
- Old fasadda qavariq shisha yoy: `x ∈ [−13, 7]`, 1.5 m bo'rtib chiqadi (R ≈ 34.1 m).
- O'ng-old burchak: yumaloq shisha, markaz (13, 3), r = 5.
- Kirish podiumi: `x ∈ [−14.3, 8.3]`, `z ∈ [8, 12.6]`, balandligi 5.0 m.
- Aniq kontur `outline(o)` funksiyasida — frontendda shu formulaning TypeScript nusxasi ishlatiladi (`apps/web/src/scene/buildingGeometry.ts`). Koordinatalar taxmin qilinmagan.

### GLB struktura (tekshirildi, python orqali)
- Primitive'lar material bo'yicha: `stone` (10.9k tri), `metal` (7.5k), `steel` (7.2k), `logo_blue` (4.5k), `glass` (2k), boshqalar kichik.
- Bino qobig'i ichi bo'sh prizma (`prism`), qopqoqlar faqat sokol (0.75) va karniz (23.0) da. **Qavatlararo plita yo'q.**
- Yer (`paving`, y −0.1…0) va yo'l (`asphalt`) xuddi shu mesh ichida.

### Xulosa: qavatlarni ajratish
GLB ichida qavatlar alohida mesh/guruh **emas**. Tanlangan yechim (modelni o'zgartirmasdan):
1. GLB o'z holicha yuklanadi.
2. Har qavat uchun skriptdagi `outline()` va `FL` asosida **interaktiv zona meshlari** quriladi (raycast + hover yoritish).
3. Tanlangan qavat uchun **clipping plane** (y = qavat shifti) — bino kesim ko'rinishiga o'tadi; yuqori qism shaffof "ghost" nusxa sifatida kontekstni saqlaydi.
4. Ichki plita, xonalar, stollar va agentlar protsedural tarzda qo'shiladi.
5. Podval uchun yer ostida protsedural beton blok quriladi; podval tanlanganda yer qoplamasi yashiriladi.

Kelajakda: `build_sag_building.py` ga `--split-floors` rejimi qo'shib, har qavatni alohida node sifatida eksport qilish mumkin (skript bizniki, Blender kerak emas). Hozircha shart emas.

## 3. Referens: `ajsahni/agents-office`
Lokal nusxa `D:\SAG\agents-office` da bor. Faqat konsepsiyalar o'rganildi: bo'lim podlari, task bar orqali routing, "Brain" (notes papkasi + graph), connectorlar ro'yxati (`claude mcp list`), "TEAM" rejimi (lead vazifani bo'lib beradi), routines + "needs my OK", kalendar.
**Litsenziya (PolyForm Noncommercial + qo'shimcha shartlar) kodni, brendni yoki uni boshqa mahsulotga ulashni taqiqlaydi.** Shuning uchun undan hech qanday kod, asset yoki dizayn ko'chirilmaydi; SAG AI OFFICE mustaqil implementatsiya.

`D:\SAG\sag-world` — alohida loyiha (distribution control tower), bu loyihaga aloqasi yo'q.

## 4. Risklar va noma'lum jihatlar

| # | Risk | Ta'sir | Yechim |
|---|---|---|---|
| R1 | PostgreSQL/Docker yo'q | Phase 2 DB | Dev: SQLite (Prisma), prod: PostgreSQL. Prisma schema ikkalasiga mos yoziladi. |
| R2 | `ANTHROPIC_API_KEY` mavjudligi noma'lum | Phase 3 real agentlar | Kalitsiz — aniq belgilangan DEMO/mock rejim; real rejim faqat kalit bilan. |
| R3 | Connectorlar (Gmail, Telegram, CRM…) uchun OAuth ma'lumotlari yo'q | Phase 7 | Har biri "not configured" deb ko'rsatiladi; soxta "connected" yo'q. |
| R4 | GLB qavatlari ajratilmagan | 3D interaksiya | Koordinatali zonalar + clipping (yuqorida). |
| R5 | Podval geometriyasi yo'q | Podval ko'rinishi | Protsedural yer osti bloki. |
| R6 | Embedding provayderi tanlanmagan | RAG | Avval SQLite FTS5 / Postgres FTS (BM25) — haqiqiy ishlaydi; vektor qidiruv keyin, status UI da ochiq ko'rsatiladi. |
| R7 | Redis yo'q | Navbat | DB-asosidagi navbat (atomic claim, lease) — BullMQ shart emas. |
| R8 | Git repo emas | Regressiyalarni kuzatish | `git init` tavsiyasi. |
| R9 | GLB 2.26 MB | Yuklanish | Bir marta yuklanadi, kesh; intro animatsiya yuklanish vaqtini yopadi. |
| R10 | Moliyaviy real ma'lumot yo'q | Finance | Qiymatlar o'ylab topilmaydi; faqat API xarajatlari (haqiqiy usage) va foydalanuvchi kiritgan ma'lumotlar. |

## 5. Qayta audit — 2026-10-29 (yangi master prompt)

Joriy holat (ishlayotgan, saqlanadi):
- `apps/web` — Vite + React 18 + TS + Three.js 0.170: intro, qavat hover/click, kesim, podval, render-on-demand, WebGL fallback, login, SSE orqali jonli ma'lumot.
- `apps/server` — Fastify 5 + `node:sqlite`: 28 jadval, auth/RBAC, audit, agentlar, vazifalar (atomik o'tishlar, dependency, lease claim), stats, SSE replay. 37 test.
- `packages/shared` — statuslar, o'tishlar, rollar, DTO.
- GLB holati o'zgarmagan (1 node, material bo'yicha primitive'lar, qavatlar ajratilmagan) — qavat zonalari va kesim skript koordinatalari asosida.

Yangi talablar bilan farq:
- Interyerlar hozir sodda (kapsula figuralar, oddiy stollar) → Phase 2 da realistik "diorama" uslubiga o'tkaziladi, avval bitta qavat (Marketing).
- Agentlar joyi saqlanmaydi (layout tartibidan) → `agents.workstation` ustuni.
- Telegram, Claude runtime, orchestrator, The Brain UI, kalendar — hali yo'q (rejada).
- Telegram uchun `.env.example` ga placeholder qo'shildi; token faqat lokal `.env` da bo'ladi.

Batafsil reja: `docs/IMPLEMENTATION_PLAN.md`.

## 6. Phase 0 natijasi
- `docs/PROJECT_AUDIT.md` (shu fayl)
- `docs/ARCHITECTURE.md`
