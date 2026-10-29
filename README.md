# SAG AI OFFICE

SAG binosining 3D modeli ichidagi ko'p agentli AI ofis. Hozirgi holat: **Phase 2** — 3D interfeys + backend (DB, auth, agentlar, vazifalar, real vaqt). Agentlar Claude API orqali ishlashni Phase 3 da boshlaydi.

## Ishga tushirish

Kerak: Node.js 24+ (o'rnatilgan `node:sqlite` ishlatiladi).

```bash
npm install
cp .env.example .env   # ADMIN_PASSWORD ni to'ldiring (ixtiyoriy)
```

Ikki terminalda:

```bash
npm run server
```

```bash
npm run dev
```

Brauzer: http://localhost:5173 — login `admin`, parol `.env` dagi `ADMIN_PASSWORD` (bo'sh bo'lsa, birinchi startda server logida bir marta chiqadi).

Boshqa buyruqlar:

```bash
npm test           # web + server testlari
npm run typecheck  # server tiplari
npm run build      # web production build
```

## AI (agentlar)
Agentlar Google Gemini orqali ishlaydi. `.env` ga `GEMINI_API_KEY` yozing (bepul kalit: https://aistudio.google.com/apikey) va serverni qayta ishga tushiring.
Yuqoridagi belgi: **AI: Gemini** — ishlayapti, **AI: ulanmagan** — kalit yo'q (vazifalar navbatda kutadi), **AI: MOCK** — faqat sinov rejimi (`LLM_PROVIDER=mock`), haqiqiy AI emas.
Bo'lim tanlanmagan vazifani Director AI bo'limlarga bo'lib, natijalarni birlashtiradi.

## Tuzilma
- `3d/` — bino modeli va generatori (manba).
- `apps/web/` — React + Three.js frontend.
- `apps/server/` — Fastify API, SQLite (`data/sag.db`), migratsiyalar `src/db/migrations`.
- `packages/shared/` — statuslar, o'tishlar jadvali, rollar, API tiplari.
- `docs/` — audit, arxitektura, [API](docs/API.md), bosqich hisobotlari.
