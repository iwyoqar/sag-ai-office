# Realistik interyer — kechiktirilgan vazifalar (backlog)

Holat: 2026-10-30 — 1–10-bandlar bajarildi (7-band pishirilgan kontakt soyalar bilan).
Pilot qavat: **5 — Marketing**. Keyin qolgan qavatlarga (B, 1–4, 6) kengaytiriladi.

## Allaqachon tayyor (kodda bor, testlangan)
- `apps/web/src/scene/office/plan.ts` — Marketing rejasi: 4 ta pod (16 ish stoli), majlis xonasi (shisha devor + eshik), analitika devori, kreativ lounge, kontent rejalash zonasi, kampaniya displeylari, kofe nuqtasi, o'simliklar, zona yorliqlari. Har stolning o'tirish va "yaqinlashish" nuqtasi bor.
- `apps/web/src/scene/office/nav.ts` — navigatsiya: 0.2 m panjara, fasad konturi + to'siqlar (agent radiusi bilan), A* (diagonal burchakni kesmasdan), ko'rish chizig'i bo'yicha silliqlash.
- `apps/web/src/scene/office/behaviour.ts` — backend status → harakat (o'tirib ishlash, o'ylash, majlis, tasdiq kutish, xato, tugatish, pauza).
- `apps/web/test/office.test.ts` — 8 test: stollar soni, mebel fasad ichida, har o'rindiqqa yo'l bor, barcha stollar va majlis o'rindiqlari bog'langan, yo'l shisha devorni eshikdan aylanib o'tadi, bino tashqarisiga yo'l yo'q, status xaritasi.
- Backend: `agents.workstation` — har agentning doimiy stoli (seed, ishga olish, ko'chirish, arxivlashda to'g'ri).

## Bajarildi (2026-10-29)
1. **Mebel to'plami** — `office/furniture.ts`: stol podlari (monitor ekrani agent holati rangida), ergonomik stul, majlis stoli, devor TV, analitika devori, kredenza, L-divan, kreslo, kofe stoli, gilam, moodboard, javon, kanban, baland stol/stullar, displey stendlari, kofe nuqtasi, skameyka, o'simliklar (Lathe tuvak), shisha bo'limlar; Phase 3 uchun: server stoykalari (LED), resepshn peshtaxtasi, Brain yadrosi, direktor stoli, oq doska. Har buyum material bo'yicha bitta geometriyaga birlashtirilgan (qavatda ~350–520 draw call).
2. **Arxitektura** — qalin plita (maket ko'rinishi), 60 sm plitkali pol, fasad bo'yicha past oq devor, orqada to'liq balandlikdagi devor (devorga osilgan ekranlar shu yuzada).
3. **Inson figuralari** — `office/character.ts`: protsedural skelet (~1.8 m), teri/soch/kiyim agent id xeshidan; pozalar: turish, yurish sikli, o'tirish, yozish, o'ylash, gaplashish, kutish, bloklangan, xato, tugatish — bo'g'imlar bo'yicha silliq aralashtirish.
4. **Harakat** — `office/actor.ts`: o'rnidan turish → A* bilan yurish (1.3 m/s) → o'tirish; majlis o'rindig'ini band qilish; yo'lda yangi holat kelsa qayta yo'naltirish. Testlar: devor/mebel orqali o'tmaydi.
5. **Nomlar** — bosh ustida nom + status nuqtasi (o'tirganda pastroq), tanlanganda kattalashadi; odamni yoki uning monitorini bosish — profil.
8. **Integratsiya** — umumiy `Interior` interfeysi; `OfficeFloor` reja bor qavatlar uchun, `?simple` URL parametri eski yengil ko'rinishga qaytaradi.
9. **Tekshiruv** — brauzerda 5, 4, B qavatlar ko'rildi; holat o'zgarishida majlisga yurib borish va o'tirish tekshirildi.
10. **Phase 3** — 5-qavat qo'lda chizilgan reja; qolgan qavatlar (B, 1, 2, 3, 4, 6) bo'limlar zonasidan avtomatik reja (`zonePlan`): har bo'limga stol podlari, umumiy majlis stoli, bo'limlar orasida shisha, bo'limga xos jihozlar. Har qavat uchun test: mebel ichkarida, ustma-ust tushmaydi, har o'rindiqqa yo'l bor.

## Inson xodimlar (2026-10-30)
- Realistik qavatlarda xodimlar bo'limining bo'sh stollarida o'tiradi, nishon (lanyard) va 👤 yorlig'i bilan AI agentlardan ajraladi.
- Holat faqat haqiqiy ma'lumotdan: ish bajaryapti / tekshiryapti / bloklangan / bo'sh; 30 daqiqa faolliksiz — joyida emas (stol bo'sh).
- Cheklovlar: majlis/kalendar ma'lumoti yo'q (majlis ko'rsatilmaydi); stol saqlanmaydi (bo'limdagi tartib bo'yicha); `?simple` ko'rinishida xodimlar yo'q.

## Bajarildi (2026-10-30)
6. **Diorama ko'rinishi** — realistik qavat ochilgach fon va tuman firuza (#13686b) rangga silliq o'tadi, so'ng GLB bino, kampus va yer yashiriladi; qavat plitasi ostida yumshoq soya (blob + quyosh soyasini ushlovchi tekislik). Qavat almashtirishda bino kesim animatsiyasi uchun qaytadi; orqaga/kampusga chiqishda hammasi tiklanadi.
7. **AO** — GTAOPass o'rniga rejadan **pishirilgan kontakt soyalar**: mebel, stol podlari, stullar ostida va devor bo'ylab yumshoq qorayish (dumaloq buyumlarga dumaloq soya), plitadan tashqariga chiqmaydi. Sabab: renderer kampus uchun `logarithmicDepthBuffer` ishlatadi, chuqurlikka asoslangan post-processing uni o'qiy olmaydi; pishirilgan usul aniq va ish vaqtida bepul.
- **Xodimlar stoli saqlanadi** (`users.desk`, migratsiya 008): bo'limdagi eng kichik bo'sh raqam; arxivlanganda bo'shaydi, boshqa bo'limga o'tganda yangisi beriladi. 3D'da xodimlar bo'lim stollarining oxiridan, agentlar boshidan o'tiradi — biri ishga olinsa, boshqasi joyidan siljimaydi.
- **Kelish/ketish**: xodim "joyida emas" holatidan qaytsa lift oldidan stoliga yurib keladi; ketsa liftgacha yurib, yo'qoladi (xira yorlig'i bo'sh stolda qoladi).

## Qolgan ishlar
- 5-qavatdan boshqa qavatlar uchun qo'lda chizilgan rejalar (hozir avtomatik `zonePlan`) — ixtiyoriy.
- `?simple` (yengil) ko'rinishda xodimlar ko'rsatilmaydi.
- Xodimlar majlisga yurmaydi (kalendar/majlis ma'lumoti yo'q).

## Eslatmalar
- Referens rasm (izometrik ofis) yuborilmagan edi; uslub matndagi tavsif bo'yicha.
- Litsenziyalangan rigged personaj asseti yo'q — protsedural skelet hujjatlashtirilgan zaxira yechim.
