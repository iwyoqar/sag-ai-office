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
- Zaxira: shifrlangan off-site backup (6-bo'lim). Render disk snapshotlari qo'shimcha himoya, lekin ular bir xil provayderda va tiklanishi tekshirilmagan — asosiy zaxira emas.
- Diskli xizmatlarda Render "zero-downtime" deployni o'chiradi: yangi versiya eski to'xtagandan keyin ishga tushadi (bir necha soniya uzilish) — bu Telegram bot va agentlar ikki marta ishlamasligi uchun aynan to'g'ri.

## 4. Cheklovlar

- SSE (real vaqt) Vercel rewrite orqali o'tadi; ulanish proksida uzilsa, sayt 20 s heartbeat + watchdog bilan avtomatik qayta ulanadi va o'tkazib yuborilgan hodisalarni oladi.
- Hujjat yuklash limiti 15 MB; Vercel rewrite orqali katta fayllar uchun to'g'ridan-to'g'ri Render manzilidan foydalanish mumkin.

## 5. Ishchi (worker) hayot sikli va tiklanish

Server bitta jarayon: API + agent runner + scheduler + Telegram. SQLite bitta yozuvchi bilan ishlaydi, shuning uchun
**bitta baza fayliga bitta server jarayoni** (ikkinchi worker faqat shu host va shu diskda, hech qachon boshqa mashinada
yoki tarmoq diskida).

- **Lease:** har bir AI vazifa 90 s lease bilan olinadi va ish davomida har 30 s yangilanadi (heartbeat). Har bir olish
  `lease_epoch` ni oshiradi; runner faqat o'z `lease_owner` + `lease_epoch` i bilan yozadi. Lease'ini yo'qotgan ish
  (masalan, osilib qolgan jarayon) keyingi ishning natijasini ustidan yoza olmaydi va o'zi to'xtaydi.
- **Graceful stop (SIGTERM, deploy):** yangi vazifa olinmaydi → olingan vazifalar darhol navbatga qaytariladi (urinish
  hisoblanmaydi) → LLM chaqiruvlari bekor qilinadi → 10 s gacha kutiladi → HTTP va baza yopiladi. 20 s dan oshsa jarayon
  majburan tugaydi. Ikkinchi signal hech narsani buzmaydi.
- **Crash:** `uncaughtException` / `unhandledRejection` loglanadi, xuddi shu stop yo'li bilan chiqiladi (kod 1) — Render
  qayta ishga tushiradi.
- **Ishga tushish:** heartbeat'i to'xtagan workerlarning vazifalari darhol navbatga qaytadi (eski 15 daqiqalik lease'ni
  kutmasdan); "band" ko'rinib, hech narsa qilmayotgan agentlar IDLE ga qaytadi; tasdiqlangan, lekin bajarilish paytida
  uzilgan tashqi amallar `unknown` deb belgilanadi — ular avtomatik qayta bajarilmaydi, odam tashqi tizimda tekshiradi.
- Vazifa workerni ketma-ket `max_attempts` marta "o'ldirsa", u FAILED bo'ladi (cheksiz aylanmaydi).
- **Health:** `/api/health` — jarayon tirikligi. `/api/ready` — baza yoziladimi, worker holati, navbat kechikishi (s),
  oxirgi tekshirilgan backup yoshi (s); baza yozilmasa 503. Ochiq endpoint: faqat holat va yoshlar, nomlar/xatolar yo'q.

## 6. Backup va tiklash

Backup **sozlanmaguncha o'chiq** — hech narsa hech qayerga yuborilmaydi. Saqlash joyini egasi tanlaydi.

Har bir sikl: `VACUUM INTO` (ishlayotgan bazadan izchil nusxa) → `integrity_check` → gzip → AES-256-GCM (`BACKUP_KEY`)
→ obyekt + manifest (sha256, hajm, sxema versiyasi, jadval qatorlari soni) yuklanadi → **yuklangan obyekt qayta yuklab
olinib, ochilib, tekshiriladi** (shundan keyingina "verified") → eski backuplar retention bo'yicha o'chiriladi. Har qadam
`backup_runs` va audit logda. Kalitlar va parollar loglarga yozilmaydi.

| O'zgaruvchi | Ma'nosi |
|---|---|
| `BACKUP_TARGET` | `s3` (S3-mos: AWS S3, Cloudflare R2, Backblaze B2, MinIO) yoki `dir` (boshqa disk/volume — off-site emas) |
| `BACKUP_KEY` | 32 bayt, base64 (`openssl rand -base64 32`). **Alohida, oflayn saqlang**: kalitsiz backupni tiklab bo'lmaydi |
| `BACKUP_KEY_ID` | kalit nomi (standart `k1`); rotatsiyada yangi nom bering |
| `BACKUP_OLD_KEYS` | eski kalitlar `k0:<base64>,…` — eski backuplarni tiklash uchun |
| `BACKUP_S3_ENDPOINT` | `https://…` (masalan `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`) |
| `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET` | region (R2 uchun `auto`) va bucket |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | faqat shu bucketga yozish/o'qish/o'chirish huquqi bo'lgan kalit |
| `BACKUP_DIR` | `dir` uchun papka |
| `BACKUP_PREFIX` | obyekt prefiksi (standart `sag-ai-office/`) |
| `BACKUP_INTERVAL_MINUTES` | standart 60 (minimal 5) |
| `BACKUP_RETAIN_HOURLY` / `_DAILY` / `_MONTHLY` | standart 48 / 30 / 12 |

Yarim sozlangan konfiguratsiya (masalan kalit yo'q) server logida xato sifatida chiqadi va backup ishga tushmaydi.

**Maqsadlar:** RPO ≤ 1 soat (interval bo'yicha; 15 daqiqagacha tushirish mumkin), RTO ≤ 30 daqiqa (yuklab olish +
tekshirish + faylni almashtirish + restart). Bu raqamlar haqiqiy saqlash joyida vaqt o'lchangan sinovdan keyin
tasdiqlanadi — hozircha faqat lokal papka bilan sinalgan.

**Buyruqlar** (`apps/server` ichida, `.env` yoki host muhitidagi sozlamalar bilan):

```bash
npm run backup -- now
```

```bash
npm run backup -- list
```

```bash
npm run backup -- verify sag-ai-office/sag-20261030T120000Z.db.gz.enc
```

**Tiklash runbook:**
1. Kerakli obyektni tanlang (`list`) va tekshiring (`verify`).
2. Yangi faylga tiklang (mavjud faylni hech qachon ustidan yozmaydi):
   `npm run backup -- restore <obyekt> /var/data/sag.restored.db`
3. Xizmatni to'xtating (Render: Suspend yoki manual deploy oldidan), joriy faylni saqlab qo'ying
   (`mv /var/data/sag.db /var/data/sag.before-restore.db`, `-wal`/`-shm` fayllar bilan), tiklanganini joyiga qo'ying
   (`mv /var/data/sag.restored.db /var/data/sag.db`).
4. Xizmatni ishga tushiring, `/api/ready` va bir nechta sahifani tekshiring.
5. Vaqtni va natijani W0 hisobotiga / incident logga yozing.

**Migratsiyadan oldin:** server yangi migratsiyani qo'llashdan oldin avtomatik ravishda
`data/backups/pre-migrate-<vaqt>.db` nusxasini oladi (oxirgi 5 tasi saqlanadi). Migratsiya noto'g'ri bo'lsa:
to'xtating, shu faylni joyiga qo'ying, oldingi versiyani deploy qiling.

## 7. Proxy va mijoz IP

`TRUSTED_PROXIES` — `X-Forwarded-For` ga faqat shu proksilardan ishoniladi: son (hop) yoki IP/CIDR ro'yxati. Render'da
`1` (faqat Render load balancer). Hech qachon "hammaga ishon" emas — aks holda har kim IP'ini o'zi tanlaydi. Eski
`TRUST_PROXY=true` endi `1` hop deb tushuniladi. Login cheklovi bazada: akkaunt bo'yicha 5 xatodan keyin eksponent
blok (30 s → 15 daqiqagacha), bitta IP'dan 15 daqiqada 30 xato — IP almashtirish akkaunt cheklovini chetlab o'tolmaydi.
