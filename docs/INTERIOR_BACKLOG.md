# Realistik interyer — kechiktirilgan vazifalar (backlog)

Holat: 2026-10-29 da to'xtatildi (foydalanuvchi qarori: avval loyiha funksional ishlashi, keyin interyer).
Pilot qavat: **5 — Marketing**. Keyin qolgan qavatlarga (B, 1–4, 6) kengaytiriladi.

## Allaqachon tayyor (kodda bor, testlangan)
- `apps/web/src/scene/office/plan.ts` — Marketing rejasi: 4 ta pod (16 ish stoli), majlis xonasi (shisha devor + eshik), analitika devori, kreativ lounge, kontent rejalash zonasi, kampaniya displeylari, kofe nuqtasi, o'simliklar, zona yorliqlari. Har stolning o'tirish va "yaqinlashish" nuqtasi bor.
- `apps/web/src/scene/office/nav.ts` — navigatsiya: 0.2 m panjara, fasad konturi + to'siqlar (agent radiusi bilan), A* (diagonal burchakni kesmasdan), ko'rish chizig'i bo'yicha silliqlash.
- `apps/web/src/scene/office/behaviour.ts` — backend status → harakat (o'tirib ishlash, o'ylash, majlis, tasdiq kutish, xato, tugatish, pauza).
- `apps/web/test/office.test.ts` — 8 test: stollar soni, mebel fasad ichida, har o'rindiqqa yo'l bor, barcha stollar va majlis o'rindiqlari bog'langan, yo'l shisha devorni eshikdan aylanib o'tadi, bino tashqarisiga yo'l yo'q, status xaritasi.
- Backend: `agents.workstation` — har agentning doimiy stoli (seed, ishga olish, ko'chirish, arxivlashda to'g'ri).

## Qilinadigan ishlar (tartib bilan)
1. **Mebel to'plami** (`office/furniture.ts`, InstancedMesh):
   - oq stol (yupqa metall oyoqlar), pod orasidagi to'siq paneli, monitor (ekran — status bo'yicha yorqinlik), klaviatura, sichqoncha, bloknot/krujka;
   - ergonomik stul (o'rindiq, to'r suyanchiq, qo'ltiqlar, gaz-lift, 5 nurli taglik, g'ildiraklar);
   - majlis stoli + 8 stul, devor TV, 3 ekranli analitika devori, kredenza;
   - L-divan, kreslo, dumaloq kofe stoli, gilam, moodboard, kitob javoni;
   - kanban doska (stikerlar), baland stol + stullar, displey stendlari, skameyka, kofe nuqtasi;
   - o'simliklar: oq tuvak (Lathe) + barg klasterlari (instanced, rang farqi), baland "sansevieriya".
2. **Arxitektura**: fasad konturi bo'yicha oq devorlar (qalinlik 0.25 m, kesim yuzasi oq), pol-shift shisha bo'limlar va oq ustunchalar, egri old shisha devor; kameraga qaragan old devorlar past (0.9 m) kesiladi; pol — och kulrang, yengil yaltiroq, plitka teksturasi; qalin plita (diorama "maketi").
3. **Inson figuralari** (`office/character.ts`): protsedural skelet (son → bel → ko'krak → bo'yin → bosh; yelka/tirsak/qo'l; son/tizza/oyoq), ~1.75 m real proporsiya; teri, soch (qisqa/uzun), kiyim ranglari agent id xeshidan (barqaror). Pozalar: turish, yurish sikli, o'tirish, yozish, o'ylash, gaplashish, kutish, bloklangan, xato, tugatish; bo'g'imlar bo'yicha silliq aralashtirish.
4. **Xatti-harakat kontrolleri**: status o'zgarganda — o'rnidan turish → A* yo'l bilan yurish (≈1.3 m/s, silliq burilish) → o'tirish; majlis o'rindig'ini band qilish; tugatgandan keyin stolga qaytish. Faqat backend holati harakatni belgilaydi; dekorativ nafas/qarash ruxsat.
5. **Nomlar va indikatorlar**: boshi ustida kichik nom plashkasi + status nuqtasi; hover — ixcham profil; bosish — mavjud profil paneli; stolni bosish ham egasini tanlaydi.
6. **Diorama ko'rinishi** (faqat realistik qavatlar uchun): qavat ochilganda yuqori va pastki clip tekisliklar shu qavatga yopiladi, tuman firuza rangga o'tadi, keyin GLB va kampus yashiriladi, fon — firuza (#13686b), plita ostida yumshoq soya; quyosh soyasi qavatga moslanadi.
7. **AO**: GTAOPass faqat qavat ko'rinishida. Talab: `logarithmicDepthBuffer` ni o'chirib, kamera `near/far` ni masofaga qarab dinamik qilish (kampusdagi z-fighting uchun).
8. **SceneController integratsiyasi**: `FloorInterior` va yangi `OfficeFloor` uchun umumiy interfeys (root, labels, pickables, update, applyAgents, highlight, key, dispose).
9. **Tekshiruv**: brauzerda — sifat, masshtab, yurish (devor/mebel orqali o'tmaslik), 60 fps atrofida unumdorlik; skrinshotlar bilan hisobot.
10. **Phase 3**: shu to'plamni B (IT), 1 (Reception), 2 (Sales + Design), 3 (Procurement), 4 (Director + Brain + Finance), 6 (HR + Home + Digital) qavatlariga — har biri o'z rejasi bilan.

## Eslatmalar
- Referens rasm (izometrik ofis) yuborilmagan edi; uslub matndagi tavsif bo'yicha.
- Litsenziyalangan rigged personaj asseti yo'q — protsedural skelet hujjatlashtirilgan zaxira yechim.
