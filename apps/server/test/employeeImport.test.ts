// Bulk import of HQ employees (.xlsx): dry run, all-or-nothing apply, activation codes, desks on activation.
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { adminClient, makeApp } from "./helpers.js";
import { loginFromName } from "../src/domain/employeeImport.js";

function workbook(rows: string[][]): Buffer {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cols = "ABCDEFG";
  const sheetRows = rows.map((r, i) =>
    `<row r="${i + 1}">${r.map((v, j) => (v ? `<c r="${cols[j]}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : "")).join("")}</row>`).join("");
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Xodimlar" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
  }));
}

const B = "----sagimport";
const multipart = (file: Buffer) => Buffer.concat([
  Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="xodimlar.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
  file, Buffer.from(`\r\n--${B}--\r\n`),
]);

async function setup() {
  const env = await makeApp();
  await adminClient(env.app);
  const cookie = (await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-pass" } })).cookies[0];
  const upload = async (file: Buffer, apply = false) => {
    const r = await env.app.inject({
      method: "POST", url: `/api/employees/import${apply ? "?apply=1" : ""}`, payload: multipart(file),
      headers: { cookie: `${cookie.name}=${cookie.value}`, "content-type": `multipart/form-data; boundary=${B}` },
    });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  return { ...env, upload };
}

const GOOD = workbook([
  ["SAG xodimlari ro'yxati"], // a title row above the header is skipped
  ["F.I.Sh", "Lavozim", "Bo'lim", "Login", "Email", "Rahbar"],
  ["Aziza Karimova", "SMM menejer", "Marketing", "", "aziza@sag.uz", ""],
  ["Бобур Алиев", "Закупщик", "procurement", "", "", ""],
  ["Dilnoza Rahimova", "Dizayner", "Marketing", "dilnoza", "", "aziza.karimova"],
]);

describe("HQ employee import", () => {
  it("dry run validates without writing; logins are generated in latin", async () => {
    const c = await setup();
    const before = c.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n;
    const r = await c.upload(GOOD);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: true, applied: false, created: [] });
    expect(r.body.rows.map((x: { username: string }) => x.username)).toEqual(["aziza.karimova", "bobur.aliev", "dilnoza"]);
    expect(r.body.rows[1]).toMatchObject({ departmentId: "procurement", jobTitle: "Закупщик" });
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(before);
    expect(loginFromName("O'tkir Ғофуров")).toBe("otkir.gofurov");
  });

  it("refuses to apply anything when one row is wrong, and says why per row", async () => {
    const c = await setup();
    const bad = workbook([
      ["Ism", "Bo'lim", "Email", "Rahbar"],
      ["Aziza", "Marketing", "aziza@sag.uz", ""],
      ["Nodir", "Yo'q bo'lim", "aziza@sag.uz", "hech.kim"],
    ]);
    const dry = await c.upload(bad);
    expect(dry.body.valid).toBe(false);
    expect(dry.body.rows[1].errors.join(" | ")).toMatch(/bo'lim topilmadi.*email band.*rahbar topilmadi/);
    const before = c.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n;
    expect((await c.upload(bad, true)).status).toBe(409);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(before);
  });

  it("applies: pending accounts with one-time codes; activation gives a password, a desk and a working login", async () => {
    const c = await setup();
    const r = await c.upload(GOOD, true);
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.created).toHaveLength(3);
    const aziza = r.body.created[0];
    const row = c.db.get<{ status: string; activation_status: string; desk: number | null; manager_id: string | null }>(
      "SELECT status, activation_status, desk, manager_id FROM users WHERE id = ?", aziza.userId)!;
    expect(row).toMatchObject({ status: "inactive", activation_status: "PENDING_ACTIVATION", desk: null });
    // the manager column links people imported together
    const dil = c.db.get<{ manager_id: string }>("SELECT manager_id FROM users WHERE username = 'dilnoza'")!;
    expect(dil.manager_id).toBe(aziza.userId);
    // no login before activation
    expect((await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "aziza.karimova", password: "Whatever-123" } })).statusCode).toBe(401);
    const act = await c.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: aziza.activationToken, password: "Aziza-pass-123" } });
    expect(act.statusCode).toBe(200);
    const after = c.db.get<{ status: string; desk: number | null }>("SELECT status, desk FROM users WHERE id = ?", aziza.userId)!;
    expect(after.status).toBe("active");
    expect(after.desk).not.toBeNull();
    expect((await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "aziza.karimova", password: "Aziza-pass-123" } })).statusCode).toBe(200);
    // the code works once
    expect((await c.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: aziza.activationToken, password: "Again-pass-123" } })).statusCode).toBe(400);
    // a second upload of the same people is refused (logins and email now taken)
    expect((await c.upload(GOOD)).body.valid).toBe(false);
  });

  it("re-issues a code for someone who has not activated; only admins / HR may import", async () => {
    const c = await setup();
    const r = await c.upload(GOOD, true);
    const bobur = r.body.created[1];
    const cookie = (await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-pass" } })).cookies[0];
    const re = await c.app.inject({ method: "POST", url: `/api/employees/${bobur.userId}/invitation`, headers: { cookie: `${cookie.name}=${cookie.value}`, origin: "http://localhost:5173" } });
    expect(re.statusCode, re.body).toBe(200);
    const fresh = JSON.parse(re.body).activationToken;
    expect((await c.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: bobur.activationToken, password: "Bobur-pass-123" } })).statusCode).toBe(400);
    expect((await c.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: fresh, password: "Bobur-pass-123" } })).statusCode).toBe(200);
    // an employee (no users:manage) cannot import
    const act = r.body.created[0];
    await c.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: act.activationToken, password: "Aziza-pass-123" } });
    const emp = (await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "aziza.karimova", password: "Aziza-pass-123" } })).cookies[0];
    const denied = await c.app.inject({
      method: "POST", url: "/api/employees/import", payload: multipart(GOOD),
      headers: { cookie: `${emp.name}=${emp.value}`, "content-type": `multipart/form-data; boundary=${B}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});
