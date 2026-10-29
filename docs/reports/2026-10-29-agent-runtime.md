# Agent runtime (Gemini) + orchestrator + vazifalar paneli — 2026-10-29

## Nima ishlaydi (real Gemini bilan tekshirildi)
- **AI provayder**: Google Gemini REST API (`gemini-2.5-flash`, `.env` dan), kalit faqat serverda (`x-goog-api-key` sarlavhasida, URL da emas; loglarda yashirin). Start paytida va har 10 daqiqada sog'liq tekshiruvi.
  Provayder interfeysi (`apps/server/src/llm/types.ts`) — keyin Claude qo'shilsa, runner o'zgarmaydi.
- **Agent runner**: navbatdagi vazifani atomik oladi (bir agent — bir vaqtda bitta vazifa), ko'rsatmalar zanjiri (kompaniya → bo'lim → agent), oldingi natijalar kontekst sifatida, Gemini chaqiruvi, natija (deliverable), token/xarajat yozuvi, holatlar (THINKING → WORKING → COMPLETED/ERROR → IDLE). Vaqtinchalik xatolarda qayta urinish (429 da Gemini aytgan kutish vaqti bilan), bekor qilish/to'xtatishda chaqiruv to'xtatiladi.
- **Orchestrator**: bo'lim tanlanmagan vazifa → Director AI reja tuzadi (JSON, tekshiriladi: bo'limlar mavjud, halqa yo'q, ≤6 ta) → kichik vazifalar bo'limlarga, bog'liqliklar bilan → mustaqillari parallel → natijalar keyingisiga uzatiladi (handoff xabarlari) → Director yakuniy hujjatni birlashtiradi. Kichik vazifa muvaffaqiyatsiz bo'lsa, umumiy vazifa BLOCKED.
- **Agent bilan chat**: profil oynasida; javob agent roli va ko'rsatmalari asosida; tarix saqlanadi.
- **UI**: yuqorida "AI: Gemini / MOCK / ulanmagan" belgisi; "Vazifalar" paneli (yaratish: bo'lim yoki avto, agent, muhimlik, muddat; filtrlar; progress va bosqich); vazifa oynasi (kichik vazifalar, natijalar Markdown, faoliyat jurnali, AI chaqiruvlari, bekor qilish / qayta urinish / agentni almashtirish).
- **Real vaqt**: SSE heartbeat (`ping` hodisasi) + mijozda watchdog — proksi orqali "o'lik" oqim qolib ketsa, avtomatik qayta ulanadi va ma'lumotlarni yangilaydi.

## Real sinov
"Gilam mahsulotlari uchun keyingi oy Instagram kontent rejasi va taxminiy reklama budjeti" — Director 3 ta kichik vazifa tuzdi (strategiya → kontent rejasi, parallel budjet), ~1.5 daqiqada yakuniy hujjat (o'zbek tilida, manbalar ko'rsatilgan, yetishmagan ma'lumotlar taxmin deb belgilangan). ~14k token. Chat: Nilufar (Finance) o'z rolida javob berdi.

## Testlar
- Server 53/53 (shu jumladan runtime: oddiy vazifa, retry, xato, bir agent — bir vazifa, bekor qilish, orchestrator to'liq oqimi, noto'g'ri reja, kichik vazifa xatosi, prompt injection himoyasi, Gemini mijozi soxta fetch bilan — kalit sarlavhada, 429 kutish, noto'g'ri kalit, safety blok; chat va /api/system).
- Web 27/27, typecheck va build xatosiz.
- Avtomatik testlarda faqat MockLlm ishlatiladi (`mode = mock`); real Gemini faqat qo'lda sinovda.

## Muhim eslatmalar
- Bepul Gemini tarifida Google so'rovlarni mahsulotini yaxshilash uchun ishlatishi mumkin — maxfiy ma'lumot yubormang.
- Bepul limit: ~10 so'rov/daqiqa — runner so'rovlar orasini 6.5 s qiladi (`LLM_MIN_INTERVAL_MS`). Katta vazifa (reja + 3 qism + birlashtirish) ≈ 5 so'rov.
- Xarajat "taxminiy" (bepul tarifda $0). Pullik tarifga o'tilsa `LLM_PRICE_*` ni to'ldiring.
- Tashqi amallar (xabar yuborish, to'lov) hali yo'q — agentlar faqat matnli natija beradi va "tasdiq uchun tavsiya" yozadi.

## Keyingi qadamlar
1. The Brain: kompaniya haqida ma'lumot va ko'rsatmalarni UI dan tahrirlash, hujjat yuklash + qidiruv (RAG).
2. Telegram bot (vazifa yaratish, natija va tasdiq xabarlari).
3. Approval oqimi, limitlar UI, foydalanuvchilarni boshqarish.
4. Hosting: PostgreSQL adapteri yoki SQLite + zaxira, HTTPS, deploy hujjati.
