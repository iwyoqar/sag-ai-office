# Phase 0 + Phase 1 hisoboti — 2026-10-29

## Nima yaratildi
- **Phase 0**: `docs/PROJECT_AUDIT.md` (fayllar, GLB tahlili, qavat balandliklari, risklar), `docs/ARCHITECTURE.md` (stack, DB modeli, agent sikli, orchestrator, xavfsizlik).
- **Phase 1 — 3D frontend** (`apps/web`, Vite + React 18 + TS + Three.js 0.170):
  - GLB bir marta yuklanadi (`3d/sag-bino.glb` → `public/models/`, `scripts/sync-model.mjs`). Model o'zgartirilmadi.
  - Intro: bulutlar (protsedural sprite klasterlar) → kamera bulutlar orasidan binoga uchadi, bulutlar tarqaladi. Birinchi tashrif ~4.6 s, takroriy ~1.9 s, `prefers-reduced-motion` → darhol. Model yuklanayotganda bulutlar va progress ko'rinadi, "O'tkazib yuborish" tugmasi.
  - Qavat zonalari Python skriptdagi `outline()` va `FL` qiymatlaridan (TS port: `src/scene/buildingGeometry.ts`) — taxminiy koordinata yo'q.
  - Hover: rangli yorug' band + kontur + pulsatsiya, kursor pointer, qavat kartasi (bo'limlar, agentlar, faol, vazifalar, tasdiqlar).
  - Click / chap panel / jadval: kamera qavatga uchadi, bino stol balandligida kesiladi (clipping plane, animatsiyali), yuqori qavatlar simli kontur sifatida qoladi. Esc / "← Bino" / breadcrumb — qaytish.
  - Interyer: plita, bo'lim zonalari (rangli), shisha to'siqlar, stollar, monitorlar, agent figuralari; IT — server stoykalari, Reception — qabul stoli va ekran, Brain — aylanuvchi yadro, Director — katta stol. Podval — yer osti beton bloki, yer qoplamasi teshik bilan almashtiriladi.
  - 8 agent holati vizual farqlanadi (rang, indikator shakli, ekran rangi, animatsiya); COMMUNICATING agentlar orasida harakatlanuvchi paket bilan yoy chiziq (boshqa qavatga — yuqoriga chiqadigan chiziq).
  - Agentni bosish → profil (vazifa, tarix, connectorlar, tokenlar, xato, Pause/Resume/Stop va chat — Phase 2–3 gacha o'chirilgan, sababi yozilgan).
  - Qavat paneli: 11 statistika, Bugun / 7 kun / 30 kun / Oraliq filtri, connectorlar qatori (hammasi "ulanmagan").
  - Render-on-demand (tinch overview'da GPU ishlamaydi), panel-aware kamera framing (view offset), mobil layout (bottom sheet + qavat chiplari), WebGL fallback (2D sxema).

## Ochiq belgilangan cheklovlar
- **Barcha agentlar va statistikalar DEMO** (`src/data/demo.ts`), har panelda `DEMO` belgisi, yuqorida "Backend: ulanmagan".
- Connectorlar hech biri ulangan deb ko'rsatilmaydi.

## Fayllar
Yangi: `package.json`, `.gitignore`, `.claude/launch.json`, `docs/*`, `apps/web/**`. O'zgartirilmagan: `3d/*`.

## Testlar
- `npm test` — 13/13 o'tdi: geometriya (qavat balandliklari, footprint, interyer), floor config, layout (zonalar bo'shliqsiz, stollar zona ichida va ustma-ust emas), tween, **qavat tanlash/qaytish state machine** (test #14), demo ma'lumot izchilligi.
- `npm run build` — `tsc --noEmit` + Vite build, xatosiz.
- Brauzerda qo'lda tekshirildi (1440×900 va tor/mobil): intro, hover band + karta, qavat 4/5/B ochish, agent profili, Esc ×2 bilan qaytish, konsolda xato yo'q.
- Tekshirilmagan: haqiqiy WebGL'siz brauzerda fallback (kod bor, qo'lda sinalmagan); `prefers-reduced-motion` rejimi brauzerda sinalmagan.

## Keyingi bosqich — Phase 2 (core backend)
`apps/server`: Fastify + Prisma (dev SQLite), migratsiyalar, auth (session + rollar), Department/Floor/Agent CRUD (seed — hozirgi demo ro'yxat asosida, lekin DB'da), Task CRUD + status transition jadvali, TaskEvent/AuditLog, SSE `/api/events`, API hujjati; frontend demo modulini API bilan almashtirish.
