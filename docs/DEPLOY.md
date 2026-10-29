# Deploy: Render (backend) + Vercel (frontend)

```
Brauzer ──► Vercel (sag-ai-office.vercel.app)
              ├─ statik sayt (3D, UI)
              └─ /api/*  ──rewrite──►  Render (sag-ai-office-api.onrender.com)
                                         ├─ API + SSE
                                         ├─ agent runner (Gemini)
                                         ├─ Telegram bot (long polling)
                                         └─ SQLite: /var/data/sag.db (doimiy disk)
```

`/api` Vercel orqali proksilanadi, shuning uchun brauzer uchun hammasi bitta domen: login cookie birinchi tomon (first-party), CORS kerak emas.

## 1. Render (backend) — bir marta

1. https://dashboard.render.com → **New → Blueprint** → GitHub'dagi `iwyoqar/sag-ai-office` reposini tanlang (Render'ga private repoga ruxsat bering).
2. Render `render.yaml` ni o'qiydi va `sag-ai-office-api` xizmatini (Starter plan, Frankfurt, 1 GB disk) taklif qiladi.
3. Maxfiy qiymatlarni kiriting (lokal `.env` dagilardan nusxa oling):
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_PASSWORD` — prod uchun **yangi, kuchli** parol (birinchi ishga tushishda admin shu parol bilan yaratiladi)
   - `TELEGRAM_ADMIN_USER_IDS` — sizning Telegram user ID'ingiz (vergul bilan bir nechta bo'lishi mumkin)
4. **Apply**. Deploy tugagach: `https://sag-ai-office-api.onrender.com/api/health` → `{"ok":true,…}`.
   Agar Render boshqa manzil bergan bo'lsa (nom band bo'lsa), `vercel.json` dagi `destination` ni o'sha manzilga almashtiring va qayta deploy qiling.

> Muhim: bitta Telegram bot tokenini bir vaqtda faqat **bitta** server o'qiy oladi. Render ishga tushgach, lokal kompyuterdagi serverda `.env` ga `TELEGRAM_ENABLED=false` yozing (yoki lokal serverni o'chiring) — aks holda ikkalasi bir-biriga xalaqit beradi (Telegram 409 xatosi).

## 2. Vercel (frontend)

Repo ildizidagi `vercel.json` hamma narsani belgilaydi (build: `npm run build -w apps/web`, natija: `apps/web/dist`, `/api` → Render).
CLI bilan: `vercel deploy --prod`. GitHub bilan avtomatik deploy uchun Vercel loyihasida **Settings → Git → Connect** orqali repoga ulang.

## 3. Ma'lumotlar

- Prod baza bo'sh boshlanadi (lokal `data/sag.db` ko'chirilmaydi): 7 qavat, 12 bo'lim, 46 agent seed qilinadi, admin `ADMIN_PASSWORD` bilan.
- Zaxira: Render disk snapshotlari (Render avtomatik kunlik snapshot oladi) + kerak bo'lsa `/var/data/sag.db` ni yuklab olish.
- Diskli xizmatlarda Render "zero-downtime" deployni o'chiradi: yangi versiya eski to'xtagandan keyin ishga tushadi (bir necha soniya uzilish) — bu Telegram bot va agentlar ikki marta ishlamasligi uchun aynan to'g'ri.

## 4. Cheklovlar

- SSE (real vaqt) Vercel rewrite orqali o'tadi; ulanish proksida uzilsa, sayt 20 s heartbeat + watchdog bilan avtomatik qayta ulanadi va o'tkazib yuborilgan hodisalarni oladi.
- Hujjat yuklash limiti 15 MB; Vercel rewrite orqali katta fayllar uchun to'g'ridan-to'g'ri Render manzilidan foydalanish mumkin.
