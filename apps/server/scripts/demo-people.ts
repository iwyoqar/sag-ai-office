// Builds an isolated demo database with people and work, for manual/browser checks of the employee features.
// Never touches the normal dev database. Usage: tsx scripts/demo-people.ts <db path> <password file>
// The password file holds one generated test password (shared by all demo accounts); it is not printed.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { EventBus } from "../src/lib/events.js";
import { loadUser } from "../src/lib/auth.js";
import { createEmployee, setDepartmentHead } from "../src/domain/employees.js";
import { acceptWork, blockWork, createWork, reportWork, startWork, submitWork } from "../src/domain/work.js";

const [path, pwFile] = process.argv.slice(2);
if (!path || !pwFile) throw new Error("usage: demo-people.ts <db path> <password file>");
for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
const password = `Demo-${randomBytes(9).toString("base64url")}`;
writeFileSync(pwFile, password);

const db = new Db(path);
db.migrate();
await seed(db, { adminPassword: password });
const ctx = { db, bus: new EventBus(db) };
const admin = loadUser(db, db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id)!;
const as = (id: string) => loadUser(db, id)!;
const h = (n: number) => new Date(Date.now() + n * 3600e3).toISOString();

const mk = (username: string, displayName: string, jobTitle: string, departmentId: string, roles: string[], managerId?: string) =>
  createEmployee(ctx, admin, { username, displayName, password, jobTitle, departmentId, roles, managerId }).then((e) => e.id);

const director = await mk("director", "Akmal Rahimov", "Direktor", "director", ["director"]);
const mHead = await mk("dilnoza", "Dilnoza Karimova", "Marketing rahbari", "marketing", ["employee"], director);
setDepartmentHead(ctx, admin, "marketing", mHead);
const pHead = await mk("jasur", "Jasur Toshmatov", "Ta'minot rahbari", "procurement", ["employee"], director);
setDepartmentHead(ctx, admin, "procurement", pHead);
const aziza = await mk("aziza", "Aziza Yusupova", "SMM mutaxassisi", "marketing", ["employee"], mHead);
const bek = await mk("bekzod", "Bekzod Aliyev", "Dizayner", "marketing", ["employee"], mHead);
const nodira = await mk("nodira", "Nodira Saidova", "Kontent menejer", "marketing", ["employee"], mHead);
await mk("sardor", "Sardor Qodirov", "Xarid mutaxassisi", "procurement", ["employee"], pHead);

// director → head → subtasks
const campaign = createWork(ctx, as(director), { title: "Yangi marketing kampaniyasi", assigneeId: mHead, deadline: h(24 * 10), priority: "HIGH", estimateHours: 4 });
acceptWork(ctx, as(mHead), campaign.id);
const s1 = createWork(ctx, as(mHead), { title: "Raqobatchilar tahlili", parentId: campaign.id, assigneeId: aziza, estimateHours: 10, deadline: h(20) });
const s2 = createWork(ctx, as(mHead), { title: "Reklama kreativlari", parentId: campaign.id, assigneeId: bek, estimateHours: 16, deadline: h(30), weight: 2 });
createWork(ctx, as(mHead), { title: "Kontent kalendari", parentId: campaign.id, assigneeId: nodira, estimateHours: 6, deadline: h(60) });
createWork(ctx, as(mHead), { title: "Qo'shimcha g'oyalar", parentId: campaign.id, assigneeId: nodira, isOptional: true });
acceptWork(ctx, as(aziza), s1.id);
startWork(ctx, as(aziza), s1.id);
reportWork(ctx, as(aziza), s1.id, { progress: 60, actualHours: 5, note: "Uchta raqobatchi ko'rib chiqildi" });
acceptWork(ctx, as(bek), s2.id);
startWork(ctx, as(bek), s2.id);
submitWork(ctx, as(bek), s2.id, "Birinchi variantlar tayyor");

// Aziza is overloaded on purpose (several near deadlines + one overdue)
for (const [t, est, due] of [["Instagram postlari", 12, 10], ["Hamkorlar bilan uchrashuv tayyorgarligi", 8, 18], ["Oylik hisobot", 6, -5]] as const) {
  const x = createWork(ctx, as(mHead), { title: t, assigneeId: aziza, estimateHours: est, deadline: h(due) });
  acceptWork(ctx, as(aziza), x.id);
}
const blocked = createWork(ctx, as(pHead), { title: "Yetkazib beruvchi shartnomasi", assigneeId: pHead, estimateHours: 4, deadline: h(48) });
startWork(ctx, as(pHead), blocked.id);
blockWork(ctx, as(pHead), blocked.id, "Yuridik bo'lim javobi kutilmoqda");

// activity so presence is not "away"
db.run("UPDATE users SET last_activity_at = ? WHERE status = 'active'", new Date().toISOString());
db.close();
console.log("demo database ready");
