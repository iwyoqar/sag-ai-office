# SAG AI WORLD --- Enterprise Work Management

## Claude Code uchun T1--T7 master roadmap

Ushbu faylni repository root'ga `WORK_MANAGEMENT_ROADMAP.md` nomi bilan
saqlang. Claude Code bu hujjatni doimiy yo'riqnoma sifatida ishlatadi.
Siz faqat `Keyingi bosqichni boshla` deb buyruq berasiz. Claude progress
faylini tekshiradi va navbatdagi bitta bosqichni bajaradi.

------------------------------------------------------------------------

# 0. GLOBAL RULES

## Mahsulot tamoyili

SAG AI WORLD'da inson xodimlari va AI agentlari yagona Task Engine
orqali ishlaydi. Human Task va AI Task uchun parallel tizimlar
yaratmang. Task modeli umumiy, execution adapter'lari esa HUMAN va
AI_AGENT uchun alohida bo'lishi mumkin.

## Mavjud arxitektura

Har bir bosqich boshida repository, database schema, migrations, routes,
domain services, permissions, AI runtime, Business Unit isolation,
notifications, calendar, files va UI'ni tekshiring. Mavjud funksiyalarni
qayta yozishdan oldin reuse imkoniyatini aniqlang. Mavjud kodni
ko'rmasdan model yoki endpoint taxmin qilmang.

## Texnik cheklovlar

-   SQLite saqlanadi. PostgreSQL'ga migratsiya qilmang.
-   Mavjud NestJS/Fastify/TypeScript arxitekturasidan foydalaning.
-   Mavjud Gemini/Anthropic provider abstraction'ni reuse qiling.
-   Pul qiymatlari integer minor units ko'rinishida saqlanadi.
-   Secrets frontend, logs, comments yoki prompt history'ga tushmasin.
-   Mock execution real execution sifatida ko'rsatilmasin.
-   Business Unit va franchise data isolation buzilmasin.
-   Agentlar inson akkauntlarini yarata olmaydi va inson
    permission'larini bera olmaydi.
-   Cross-unit ishlar faqat mavjud authorization va typed/auditable
    request mexanizmi orqali bajariladi.

## Git xavfsizligi

-   Har bosqich boshida `git status` va `git diff` tekshiring.
-   Boshqa sessiya o'zgarishlarini saqlang.
-   `reset`, `rebase`, `stash`, force-push yoki destructive Git
    amallarini bajarmang.
-   Commit/push faqat foydalanuvchi aniq ruxsat berganda.
-   Local database yoki employee ma'lumotlarini o'chirmang.
-   Migration'larni mavjud tartib va registry qoidasi asosida qo'shing.
-   Dev bazaga migration qo'llashdan oldin backup va recovery yo'lini
    tekshiring.

## Security

Har bir endpoint server-side authorization bajarishi shart. Har bir
Task/Project uchun actor, Business Unit, department, assignee scope,
action permission va cross-unit sharing tekshirilsin. Frontend'da
elementni yashirish security emas. Agent task ID'ni bilishi unga kirish
huquqini bermaydi.

## Test va sifat

Har bosqich yakunida: 1. Server testlari. 2. Web testlari. 3. Server va
web typecheck. 4. Production build. 5. Migration/schema consistency. 6.
Permission va Business Unit isolation testlari. 7. Regression testlar.
8. Git diff/status review.

Test yiqilsa, keyingi bosqichga o'tmang. Real provider yoki tashqi
integratsiya credentials bilan tekshirilmagan bo'lsa, ishlayapti deb
da'vo qilmang.

## Progress tracking

Repository root'da `WORK_MANAGEMENT_PROGRESS.md` yarating va doim
yangilang. Unda quyidagilar bo'lsin:

-   Current phase.
-   Phase status: NOT_STARTED / IN_PROGRESS / BLOCKED / COMPLETED.
-   Completed phases.
-   Summary of implementation.
-   Changed files.
-   Migrations added/applied.
-   Tests/typecheck/build results.
-   Known limitations and risks.
-   Next permitted phase.
-   Last updated timestamp.

Har bir ish boshida roadmap va progress faylini qayta o'qing. Progress
fayli yo'q yoki shubhali bo'lsa, Git history, code, migrations va tests
orqali holatni tiklang. Taxmin bilan phase'ni COMPLETED deb belgilamang.

### Buyruqlar

-   `Auditni boshla`: faqat T0 audit. Kodni o'zgartirmaydi.
-   `Keyingi bosqichni boshla`: progressni tekshiradi va faqat
    navbatdagi bitta phase'ni bajaradi. Oldingi phase COMPLETED
    bo'lmasa, to'xtaydi.
-   `T1 ni boshla` (yoki boshqa aniq phase): dependency phase'lar
    COMPLETED bo'lsa bajaradi.
-   `Status`: faqat progress hisobotini beradi, kodga tegmaydi.

Bir buyruqda faqat bitta phase. Tugagach progressni yangilang va
to'xtang. Avtomatik keyingi phase'ga o'tmang.

## Har bosqich yakunidagi hisobot

1.  Phase va natija.
2.  Amalga oshirilgan ishlar.
3.  O'zgargan/yangi fayllar.
4.  Migration/schema.
5.  API/UI.
6.  Test/typecheck/build.
7.  Security/isolation tekshiruvlari.
8.  Mock yoki ishlamaydigan qismlar.
9.  Risklar.
10. Progress fayli holati.
11. Keyingi phase.

------------------------------------------------------------------------

# T0 --- ARCHITECTURE AUDIT (majburiy gate)

Agar T0 audit allaqachon bajarilgan bo'lsa, mavjud hisobot va hozirgi
repository holatini tekshirib progressga qayd eting. Arxitektura
sezilarli o'zgarmagan bo'lsa, auditni takrorlamang.

Tekshiring: - Task models, routes, domain services. - Human task
create/assign/execute flow. - AI task create/assign/runtime flow. -
Agent runtime va HQ AI Director. - Project mavjudligi. - Business
Unit/department scope va permissions. - Comments, attachments,
notifications. - Calendar, workload, analytics. - Tests va migrations.

Taqdim eting: - Architecture diagram. - Models and relationships. - API
inventory. - Human va AI workflows. - Reusable components. - Gaps. -
Migration/API/UI proposal. - Security risks. - T1--T7 dependency map.

T0 davomida kodni o'zgartirmang. Foydalanuvchi auditni ko'rib T1'ga
ruxsat bergach T0 COMPLETED hisoblanadi.

------------------------------------------------------------------------

# T1 --- UNIFIED TASK ENGINE

## Maqsad

Human va AI assignee'larni qo'llaydigan yagona, ishonchli Task Engine.

## Ishlar

1.  Mavjud Task model, task routes, AI runtime va employee workflow'ni
    audit qiling. Yetarli mavjud modelni kengaytiring, parallel model
    yaratmang.

2.  Task quyidagilarni qo'llab-quvvatlasin:

    -   id, title, description.
    -   businessUnitId, optional departmentId.
    -   createdBy actor.
    -   status, priority.
    -   startAt, dueAt, completedAt.
    -   createdAt, updatedAt.
    -   concurrency/version field, agar kerak bo'lsa.

3.  Assignment abstraction mavjud bo'lmasa, `TaskAssignment` yarating:

    -   taskId.
    -   assigneeType: HUMAN / AI_AGENT.
    -   assigneeId.
    -   assignmentRole: OWNER / CONTRIBUTOR / REVIEWER / APPROVER.
    -   assignedBy, assignedAt, acceptedAt, releasedAt.
    -   assignment status.

4.  Assignment qoidalari:

    -   Duplicate assignment taqiqlansin.
    -   Assignee active va mavjud bo'lsin.
    -   Human assignee tegishli unit/department scope'da bo'lsin.
    -   AI agent unit policy, tool scope va hiring policy'ga mos
        bo'lsin.
    -   Cross-unit assignment faqat ruxsatli handoff orqali.
    -   OWNER soni uchun aniq domain qoida belgilang.

5.  Task lifecycle:

    -   BACKLOG
    -   PLANNED
    -   ASSIGNED
    -   IN_PROGRESS
    -   BLOCKED
    -   IN_REVIEW
    -   REVISION
    -   APPROVED
    -   COMPLETED
    -   CANCELLED

    Mavjud enum'larni sababsiz almashtirmang. Business status va AI
    execution status alohida bo'lsin.

6.  Priority:

    -   LOW
    -   MEDIUM
    -   HIGH
    -   CRITICAL

7.  Status transition'lar domain service orqali tekshirilsin. Actor
    permission, current status, target status va required fields
    tekshirilsin. Barcha transition audit qilinsin.

8.  Mavjud API convention asosida task create/read/list/update,
    assign/reassign, accept, start, block/unblock, submit for review va
    cancel operatsiyalarini taqdim eting. Keraksiz duplicate endpoint
    yaratmang.

9.  Idempotency, duplicate submission prevention, transaction safety va
    concurrent update protection qo'shing.

10. UI:

    -   Task list/detail.
    -   Status, priority, deadline.
    -   Human/AI assignee turi.
    -   Assignment role.
    -   Activity preview.
    -   Permission asosidagi action'lar.

## T1 testlari

Human/AI task create; human/AI assignment; invalid/inactive assignee;
duplicate assignment; unauthorized assignment; cross-unit denial;
invalid transition; concurrent update; idempotency; W3.2 AI Director
regression; franchise isolation.

## T1 Acceptance Criteria

Bitta Task modeli human va AI uchun ishlaydi. Assignment turi/roli aniq.
Server authorization majburiy. Lifecycle validate qilinadi. Eski AI task
flow buzilmaydi. Audit va barcha test/build tekshiruvlari toza.

T1 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T2 --- PROJECT & SUBTASK MANAGEMENT

## Maqsad

Katta maqsadlarni Project → Task → Subtask → Checklist/Deliverable
strukturasida boshqarish.

## Ishlar

1.  Project entity mavjud bo'lmasa yarating yoki kengaytiring:

    -   id, name, description.
    -   businessUnitId.
    -   owner actor.
    -   status, priority.
    -   startAt, dueAt, completedAt.
    -   createdBy, timestamps.

2.  Project status:

    -   DRAFT
    -   PLANNED
    -   ACTIVE
    -   ON_HOLD
    -   COMPLETED
    -   CANCELLED

3.  Task hierarchy:

    -   Project ichidagi root task.
    -   Parent task va subtask.
    -   Circular parent relationship taqiqlansin.
    -   Nesting depth limit belgilang.
    -   Parent progress child task'lardan hisoblanishi mumkin. Computed
        va manual progress farqlansin.

4.  Checklist:

    -   title, description.
    -   sortOrder.
    -   completed.
    -   completedBy, completedAt.

5.  Milestone:

    -   name, description.
    -   target date.
    -   status.
    -   linked tasks.

6.  Task templates:

    -   name, scope.
    -   default priority.
    -   default subtasks/checklist.
    -   suggested assignees.
    -   relative deadlines.

    Template'dagi eski assignee ID'larni tekshirmasdan ko'chirmang.

7.  UI:

    -   Project list/detail.
    -   Project task tree.
    -   Task/subtask editor.
    -   Checklist.
    -   Milestones.
    -   Template picker.
    -   Project progress.

## T2 testlari

Project CRUD/permissions; unit isolation; task hierarchy; circular
hierarchy rejection; depth validation; checklist CRUD; milestone status;
template task creation; progress calculation; archive/delete va orphan
prevention.

## T2 Acceptance Criteria

Project va hierarchy persistent. Human va AI bir project ichida
ishlaydi. Checklist/milestone ishlaydi. Progress real task data'dan
olinadi. Standalone task flow saqlanadi.

T2 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T3 --- WORKFLOW, REVIEW & DEPENDENCY

## Maqsad

Task dependency, deliverable, review, approval va revision jarayonlarini
qurish.

## Ishlar

1.  Dependency modeli:

    -   predecessorTaskId.
    -   successorTaskId.
    -   dependencyType.
    -   createdBy, createdAt.

2.  Dependency turlari:

    -   FINISH_TO_START.
    -   START_TO_START.
    -   FINISH_TO_FINISH.
    -   START_TO_FINISH (faqat real use case bo'lsa).

3.  Qoidalar:

    -   Self-dependency taqiqlansin.
    -   Circular dependency taqiqlansin.
    -   Cross-unit dependency faqat ruxsatli sharing/handoff orqali.
    -   Dependency o'zgarishi audit qilinsin.
    -   Blocked task reason saqlansin.

4.  Submission/deliverable:

    -   Summary.
    -   Existing file storage reference.
    -   SubmittedBy, submittedAt.
    -   Acceptance criteria result.
    -   Version/revision number.

    Fayl binary'larini Task jadvaliga yozmang. Mavjud attachment
    tizimini reuse qiling.

5.  Acceptance criteria:

    -   Description.
    -   Required/optional.
    -   Pass/fail yoki review state.
    -   Reviewer comment.

    Submission paytida mezonlar snapshot qilinsin, agar keyingi tahrir
    tarixni buzishi mumkin bo'lsa.

6.  Review flow:

    -   Assignee submit qiladi.
    -   Task IN_REVIEW bo'ladi.
    -   Reviewer tekshiradi.
    -   APPROVED yoki REVISION.
    -   Revision uchun sabab va talablar.
    -   Qayta topshirilganda yangi version.
    -   Approval'dan keyin task yakuniy holatga o'tadi.

7.  Workflow policy:

    -   Review required.
    -   Approval required.
    -   Reviewer/approver role.
    -   Escalation/revision policy.

8.  AI review human approval o'rnini faqat aniq policy ruxsat berganda
    bosishi mumkin.

9.  UI:

    -   Dependency list/graph.
    -   Blocked reason.
    -   Submission/deliverables.
    -   Acceptance criteria.
    -   Review panel.
    -   Approve/request revision.
    -   Review history.

## T3 testlari

Dependency turlari; cycle prevention; cross-unit denial; submission
versions; criteria validation; unauthorized approval; reviewer/approver
separation; revision/approval; audit; AI review policy.

## T3 Acceptance Criteria

Cycle yo'q. Block reason ko'rinadi. Deliverable version history
saqlanadi. Review va approval ajratilgan. Faqat ruxsatli actor
tasdiqlaydi. Barcha qarorlar audit qilinadi.

T3 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T4 --- PLANNING, CALENDAR, TIMELINE & SLA

## Maqsad

Task va Project'larni vaqt bo'yicha rejalashtirish, calendar, deadline
va SLA.

## Ishlar

1.  Mavjud Calendar/Work Schedule'ni reuse qiling.

2.  Schedule:

    -   plannedStartAt, plannedDueAt.
    -   actualStartAt, actualCompletedAt.
    -   timezone policy.
    -   working calendar reference.

3.  Server UTC saqlashi mumkin; UI user/Business Unit timezone'ida
    ko'rsatsin. Timezone qoidasi aniq bo'lsin.

4.  Calendar views:

    -   My tasks.
    -   Department.
    -   Business Unit.
    -   Project.
    -   Milestones.
    -   Overdue.

5.  Gantt/timeline:

    -   Project timeline.
    -   Task duration.
    -   Subtasks.
    -   Milestones.
    -   Dependencies.
    -   Blocked state.
    -   Progress.
    -   Baseline/current dates (faqat zarur bo'lsa).

6.  Drag-and-drop date changes permission bilan himoyalansin va
    dependency qoidalarini buzmasin.

7.  SLA config:

    -   Priority.
    -   Response target.
    -   Completion target.
    -   Working hours/calendar.
    -   Pause conditions.
    -   Escalation thresholds.
    -   Notification policy.

    SLA qiymatlarini hardcode qilmang. Business Unit bo'yicha
    konfiguratsiya qiling.

8.  SLA hisobida working hours, holidays (mavjud bo'lsa), blocked pause
    policy, timezone va priority hisobga olinsin.

9.  Mavjud notification system'ni reuse qiling. Trigger'lar:

    -   Assigned/accepted.
    -   Due soon/overdue.
    -   Dependency completed.
    -   Blocked/unblocked.
    -   Review/revision/approval.
    -   SLA breach.
    -   Milestone due.

    Notification deduplication va retry qo'llang.

10. UI: calendar, Gantt, SLA indicator, due date editor, schedule
    settings, overdue/upcoming filters.

## T4 testlari

Timezone; due date validation; working hours; SLA
pause/resume/escalation; dependency scheduling; calendar scope;
notification deduplication; overdue calculation; holiday/time boundary.

## T4 Acceptance Criteria

Calendar/timeline real data. Deadline/timezone to'g'ri. SLA
configurable. Notification duplicate emas. Unit isolation saqlanadi.

T4 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T5 --- HUMAN & AI WORKFORCE MANAGEMENT

## Maqsad

Inson va AI agentlarning workload, availability, skill va capacity'ni
yagona ko'rinishda boshqarish.

## Ishlar

1.  Human va AI domain entity'larini bitta Employee jadvaliga majburan
    birlashtirmang. Unified workforce read/service layer yarating.

2.  Umumiy ko'rsatkichlar:

    -   actorType.
    -   actor identity.
    -   Business Unit/department.
    -   skills/capabilities.
    -   availability.
    -   active assignments.
    -   estimated workload.
    -   capacity.

3.  Human workforce uchun mavjud HR data'ni reuse qiling:

    -   role/department.
    -   skills (faqat mavjud data).
    -   work schedule.
    -   availability.
    -   leave integration (mavjud bo'lsa).
    -   active assignments.
    -   estimated effort.

    Ma'lumot yo'q bo'lsa taxmin qilmang.

4.  AI workforce:

    -   agent status.
    -   allowed tools/capabilities.
    -   Business Unit scope.
    -   hiring policy.
    -   max concurrent executions.
    -   rate/concurrency limits.
    -   estimated cost.
    -   execution health.
    -   active assignments.

5.  Workload calculation:

    -   estimated effort.
    -   priority.
    -   due date.
    -   active assignments.
    -   work schedule.
    -   capacity.
    -   AI concurrency.

    Estimated effort yo'q bo'lsa 0 deb yashirmang; UNKNOWN holatini
    ko'rsating.

6.  Skill-based recommendation:

    -   required skills.
    -   role.
    -   unit/department permission.
    -   availability.
    -   workload.
    -   deadline feasibility.
    -   historical performance (faqat ishonchli data bo'lsa).

    Recommendation avtomatik assignment emas. Auto-assignment faqat aniq
    policy bilan.

7.  Capacity:

    -   Human capacity.
    -   AI concurrency.
    -   Department capacity.
    -   Unit workload.
    -   Overloaded/underutilized detection.

8.  UI:

    -   Workforce overview.
    -   Human/AI filters.
    -   Actor workload.
    -   Active assignments.
    -   Capacity.
    -   Skills/capabilities.
    -   Assignment recommendations.

## T5 testlari

Human workload; AI concurrency; unknown effort; availability; skill
match; cross-unit denial; franchise isolation; unauthorized capacity
edit; recommendation explanation; budget/concurrency limits.

## T5 Acceptance Criteria

Human va AI workload bir dashboard'da. Domain identity saqlanadi.
Workload real data'dan. AI concurrency ishlaydi. Tavsiyalar
permission'ni chetlab o'tmaydi.

T5 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T6 --- AI TASK INTELLIGENCE

## Maqsad

Natural-language topshiriqlarni structured project/task plan'ga
aylantirish va AI execution'ni yagona Task Engine bilan bog'lash.

## Ishlar

1.  Natural-language intake:

    -   Objective.
    -   Expected outcome.
    -   Business Unit.
    -   Scope.
    -   Constraints.
    -   Deadline.
    -   Budget.
    -   Required departments.
    -   Missing information.

    Muhim ma'lumot yetishmasa taxmin qilmang; clarification so'rang.

2.  Structured plan:

    -   Project proposal.
    -   Tasks/subtasks.
    -   Acceptance criteria.
    -   Dependencies.
    -   Suggested assignees.
    -   Estimated effort.
    -   Suggested deadlines.
    -   Required approvals.
    -   Assumptions/risks.

3.  AI output qat'iy schema bilan validate qilinsin. Free-form AI
    text'ni to'g'ridan-to'g'ri DB'ga yozmang.

4.  Assignment recommendation T5 workforce data va permission
    qoidalariga tayansin. Skill mismatch, workload conflict, deadline
    risk va rationale ko'rsatiladi.

5.  Approval:

    -   Draft plan.
    -   Human review.
    -   Approve.
    -   Create project/tasks.
    -   Reject/request changes.

    Budget, hiring, cross-unit access va critical deadline o'zgarishlari
    alohida approval/permission talab qiladi.

6.  Mavjud AI Director va agent runtime'ni reuse qiling. Execution:

    -   Authorization validate.
    -   Task instructions/criteria load.
    -   Authorized tools only.
    -   Progress record.
    -   Structured result/deliverable.
    -   Review submission.

7.  Task status va AI execution status alohida.

8.  Guardrails:

    -   Max delegation depth.
    -   Max subtasks per request.
    -   Max retries.
    -   Timeout.
    -   Budget/cost limit.
    -   Tool allowlist.
    -   Unit scope.
    -   Idempotency.
    -   Human approval thresholds.
    -   Recursive delegation prevention.

9.  Explainability:

    -   Nega task'ga ajratildi.
    -   Nega assignee tavsiya qilindi.
    -   Assumptions.
    -   Missing information.
    -   Risks.

    Chain-of-thought yoki maxfiy internal reasoning'ni
    saqlamang/ko'rsatmang. Faqat qisqa rationale va qaror asoslarini
    qayd qiling.

## T6 testlari

Valid/invalid AI schema; clarification; permission-safe assignment;
workload-aware recommendations; approval; AI execution integration; mock
labeling; retry/timeout; budget; delegation depth; recursion prevention;
cross-unit isolation.

## T6 Acceptance Criteria

Natural-language request structured plan bo'ladi. Plan validate
qilinadi. Approval policy ishlaydi. Tasdiqlangandan keyin task'lar
yaratiladi. AI yagona Task Engine'dan foydalanadi. Real/mock farqi aniq.

T6 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# T7 --- TASK ANALYTICS & REPORTING

## Maqsad

Rahbarlarga real task va workforce data asosida ishonchli analitika
berish.

## Ishlar

1.  Metrics:

    -   Total tasks.
    -   Backlog, assigned, in progress, blocked, in review.
    -   Completed, cancelled, overdue.
    -   Completion rate.
    -   On-time completion rate.
    -   Average cycle time.
    -   Average lead time.
    -   Revision rate.
    -   SLA compliance.
    -   Workload by department.
    -   Workload by human/AI.
    -   AI execution cost.
    -   Failed AI executions.

2.  Har bir metric uchun formula, date range va cancelled task'lar
    denominator'ga kirish-kirmasligini hujjatlashtiring.

3.  Dashboard scopes:

    -   My Work.
    -   Department.
    -   Business Unit.
    -   HQ Group.

    HQ faqat ruxsatli data'ni jamlaydi. Franchise sharing agreement'siz
    ko'rinmaydi.

4.  Filters:

    -   Date range.
    -   Business Unit.
    -   Department.
    -   Project.
    -   Priority.
    -   Status.
    -   Human/AI.
    -   Assignee.
    -   SLA state.

    Filterlar server-side bo'lsin.

5.  Reports:

    -   Task performance.
    -   Department performance.
    -   Project health.
    -   Overdue.
    -   Workload.
    -   AI execution.
    -   AI cost.
    -   SLA.

6.  AI insights:

    -   Repeated delays.
    -   Workload overload.
    -   High revision task types.
    -   SLA breach trends.
    -   AI execution failures.
    -   Project risks.

    Har bir insight dalil/metric reference bilan bo'lsin. Sababsiz
    xulosa yo'q.

7.  Performance:

    -   DB indexes.
    -   Optimized aggregation.
    -   Pagination.
    -   Date range limits.
    -   Cache faqat consistency aniq bo'lsa.
    -   Katta report uchun mavjud background job infra mos bo'lsa
        foydalaning.

## T7 testlari

Metric formulas; date/time boundaries; cancelled task handling;
BU/department scope; franchise isolation; filters; pagination;
aggregation; AI evidence references; export authorization.

## T7 Acceptance Criteria

Dashboard real backend data. Metric formulas hujjatlashtirilgan.
HQ/Unit/Department scope to'g'ri. Franchise isolation saqlangan.
Performance maqbul. AI insights dalilga tayangan.

T7 tugagach progressni yangilang va to'xtang.

------------------------------------------------------------------------

# FINAL END-TO-END ACCEPTANCE SCENARIO

T1--T7 tugagach quyidagi workflow'ni test qiling:

HQ Director: "2027-yilda SAG Home Design savdosini 30% oshirish bo'yicha
loyiha ishlab chiq."

Kutiladigan flow:

1.  HQ Director request yuboradi.
2.  AI talabni tahlil qiladi.
3.  Project, tasks va subtasks taklif qiladi.
4.  Acceptance criteria, dependencies va deadline ko'rsatadi.
5.  Human/AI assignee tavsiya qiladi.
6.  Ruxsatli rahbar plan'ni tasdiqlaydi.
7.  Project/task'lar yagona Task Engine'da yaratiladi.
8.  Research Agent bozor tahlilini bajaradi.
9.  Finance Agent moliyaviy model tayyorlaydi.
10. Marketing Manager kampaniya ishlarini bajaradi.
11. Dependency va workload kuzatiladi.
12. Deliverables topshiriladi.
13. Reviewer tekshiradi.
14. Revision kerak bo'lsa qaytariladi.
15. Tasdiqlangan task'lar yakunlanadi.
16. Project progress yangilanadi.
17. HQ dashboard natijalarni ko'rsatadi.
18. Audit history to'liq saqlanadi.
19. AI cost va execution natijalari hisobotda ko'rinadi.

Real business data/provider credentials yo'q bo'lsa, fixtures va mock
provider ishlating, lekin real natija deb ko'rsatmang.

------------------------------------------------------------------------

# FINAL PRODUCT RULES

-   Bitta Task Engine.
-   Human va AI uchun yagona assignment abstraction.
-   Alohida execution adapter'lar.
-   Project → Task → Subtask.
-   Validated lifecycle.
-   Dependency va review.
-   Workload va SLA.
-   AI planning with approval.
-   Business Unit isolation.
-   Auditability.
-   Real backend metrics.
-   No duplicate architecture.

**Eng muhim qoida:** har bir phase mustaqil ishlaydigan, testdan o'tgan
va oldingi phase'ni buzmaydigan holatda yakunlanadi. Foydalanuvchi
`Keyingi bosqichni boshla` demaguncha keyingi phase boshlanmaydi.
