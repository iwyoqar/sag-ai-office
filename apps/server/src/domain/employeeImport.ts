// Bulk import of HQ employees from an .xlsx sheet. Header row by name (Uzbek, Russian or English), one person per
// row. A dry run validates every row; applying is all-or-nothing and only when no row has an error. Imported people
// get no password: each gets a one-time activation code (like store staff), and a desk when they activate.
import { createHash } from "node:crypto";
import { now } from "../db/db.js";
import { readFirstSheet } from "../import/xlsx.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { has } from "./access.js";
import type { Ctx } from "./context.js";
import { issueInvitation, NO_PASSWORD, uniqueUsername } from "./units.js";

const MAX_ROWS = 500;

type Field = "name" | "jobTitle" | "department" | "username" | "email" | "manager";

const norm = (s: string) => s.toLowerCase().replace(/[ʻʼ‘’`´]/g, "'").replace(/\s+/g, " ").trim();

/** Accepted header texts per field (compared after norm). */
const HEADERS: Record<Field, string[]> = {
  name: ["ism", "ism-familiya", "ism familiya", "f.i.sh", "fish", "f.i.o", "fio", "ф.и.о", "фио", "ф.и.о.", "name", "full name", "xodim"],
  jobTitle: ["lavozim", "lavozimi", "должность", "job title", "position", "title"],
  department: ["bo'lim", "bolim", "bo'limi", "отдел", "подразделение", "department"],
  username: ["login", "username", "логин"],
  email: ["email", "e-mail", "почта", "электронная почта"],
  manager: ["rahbar", "rahbar login", "rahbari", "руководитель", "manager", "manager login"],
};

export interface ImportRowDto {
  row: number;
  displayName: string;
  jobTitle: string;
  departmentId: string | null;
  departmentName: string | null;
  username: string;
  email: string | null;
  managerUsername: string | null;
  errors: string[];
  warnings: string[];
}

export interface ImportResultDto {
  sheetName: string;
  sha256: string;
  rows: ImportRowDto[];
  /** columns found in the header row (field → column letter) */
  columns: Partial<Record<Field, string>>;
  valid: boolean;
  applied: boolean;
  /** applied only: one-time activation codes, shown once */
  created: { row: number; userId: string; displayName: string; username: string; activationToken: string; expiresAt: string }[];
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu",
  я: "ya", ў: "o", қ: "q", ғ: "g", ҳ: "h",
};

/** Login from a name: latin letters, "first.last", within the 3–32 character rule of HQ logins. */
export function loginFromName(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => CYR[c] ?? c).join("");
  const parts = latin.normalize("NFKD").replace(/[^a-z0-9\s.-]/g, "").split(/[\s.-]+/).filter(Boolean);
  const base = parts.slice(0, 2).join(".").slice(0, 26);
  return base.length >= 3 ? base : `xodim${base ? `.${base}` : ""}`;
}

function headerColumns(cells: Record<string, string>) {
  const cols: Partial<Record<Field, string>> = {};
  for (const [col, text] of Object.entries(cells)) {
    const t = norm(text);
    for (const f of Object.keys(HEADERS) as Field[]) if (!cols[f] && HEADERS[f].includes(t)) cols[f] = col;
  }
  return cols;
}

/** Validates the sheet; with `apply`, creates every person in one transaction (refused if any row has an error). */
export function importEmployees(ctx: Ctx, u: AuthUser, data: Uint8Array, apply: boolean): ImportResultDto {
  if (!has(u, "users:manage") && !has(u, "employees:manage_all")) throw forbidden("Xodimlarni import qilish faqat administrator yoki HR uchun");
  let sheet: ReturnType<typeof readFirstSheet>;
  try {
    sheet = readFirstSheet(data);
  } catch {
    throw badRequest("Fayl .xlsx emas yoki o'qib bo'lmadi");
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  // header: the first row that names the person column
  const hi = sheet.rows.findIndex((r) => headerColumns(r.cells).name);
  if (hi < 0) throw badRequest(`Sarlavha qatori topilmadi: "Ism" (yoki F.I.Sh / ФИО / Name) ustuni kerak`);
  const columns = headerColumns(sheet.rows[hi].cells);
  const body = sheet.rows.slice(hi + 1);
  if (!body.length) throw badRequest("Sarlavhadan keyin xodimlar qatori yo'q");
  if (body.length > MAX_ROWS) throw badRequest(`Bir faylda ko'pi bilan ${MAX_ROWS} xodim`);

  const deps = ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM departments WHERE business_unit_id = 'hq'");
  const depOf = (v: string) => deps.find((d) => norm(d.name) === norm(v) || d.id === norm(v)) ?? null;
  const takenLogins = new Set<string>(), takenEmails = new Set<string>();
  const cell = (r: (typeof body)[number], f: Field) => (columns[f] ? r.cells[columns[f]!] ?? "" : "").trim();

  const rows: ImportRowDto[] = body.map((r) => {
    const errors: string[] = [], warnings: string[] = [];
    const displayName = cell(r, "name");
    if (!displayName) errors.push("ism bo'sh");
    const depText = cell(r, "department");
    const dep = depText ? depOf(depText) : null;
    if (depText && !dep) errors.push(`bo'lim topilmadi: "${depText}" (bor bo'limlar: ${deps.map((d) => d.name).join(", ")})`);
    if (!depText) warnings.push("bo'lim yo'q: 3D ofisda o'z stoli bo'lmaydi");
    let username = cell(r, "username").toLowerCase();
    if (username) {
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) errors.push("login 3–32 belgi: lotin harflari, raqam, . _ -");
      else if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", username) || takenLogins.has(username)) errors.push(`login band: ${username}`);
    } else if (displayName) {
      // generated: unique against the database and the earlier rows of this file
      const base = loginFromName(displayName);
      username = uniqueUsername(ctx, base);
      for (let i = 2; takenLogins.has(username); i++) username = uniqueUsername(ctx, `${base}-${i}`);
    }
    if (username) takenLogins.add(username);
    const email = cell(r, "email").toLowerCase() || null;
    if (email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("email noto'g'ri");
      else if (ctx.db.get("SELECT 1 FROM users WHERE email = ?", email) || takenEmails.has(email)) errors.push(`email band: ${email}`);
      takenEmails.add(email);
    }
    const managerUsername = cell(r, "manager").toLowerCase() || null;
    return {
      row: r.row, displayName, jobTitle: cell(r, "jobTitle"), departmentId: dep?.id ?? null, departmentName: dep?.name ?? null,
      username, email, managerUsername, errors, warnings,
    };
  });
  // managers: an active HQ person already in the system, or someone imported in this same file
  for (const r of rows) {
    if (!r.managerUsername) continue;
    const existing = ctx.db.get<{ status: string }>("SELECT status FROM users WHERE username = ? AND home_unit_id = 'hq'", r.managerUsername);
    const inFile = rows.some((o) => o !== r && o.username === r.managerUsername);
    if (r.managerUsername === r.username) r.errors.push("o'zi o'ziga rahbar bo'la olmaydi");
    else if (!existing && !inFile) r.errors.push(`rahbar topilmadi: ${r.managerUsername}`);
    else if (existing && existing.status !== "active") r.errors.push(`rahbar faol emas: ${r.managerUsername}`);
  }
  const valid = rows.every((r) => !r.errors.length);
  const result: ImportResultDto = { sheetName: sheet.sheetName, sha256, rows, columns, valid, applied: false, created: [] };
  if (!apply) return result;
  if (!valid) throw conflict("import_invalid", "Xatoli qatorlar bor: avval tuzating, hech kim qo'shilmadi");

  return ctx.db.tx(() => {
    const t = now();
    const ids = new Map<string, string>();
    for (const r of rows) {
      const id = uid("usr");
      ids.set(r.username, id);
      const head = r.departmentId
        ? ctx.db.get<{ head_user_id: string | null }>("SELECT head_user_id FROM departments WHERE id = ?", r.departmentId)?.head_user_id ?? null
        : null;
      ctx.db.run(
        `INSERT INTO users (id, username, display_name, password_hash, is_active, status, activation_status, home_unit_id, email, job_title,
           department_id, manager_id, created_by, created_at)
         VALUES (?, ?, ?, ?, 0, 'inactive', 'PENDING_ACTIVATION', 'hq', ?, ?, ?, ?, ?, ?)`,
        id, r.username, r.displayName, NO_PASSWORD, r.email, r.jobTitle, r.departmentId, head, u.id, t,
      );
      ctx.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'employee')", id);
      result.created.push({ row: r.row, userId: id, displayName: r.displayName, username: r.username, ...issueInvitation(ctx, u, "hq", id, "employee") });
    }
    // explicit managers last, so people imported together can report to each other
    for (const r of rows) {
      if (!r.managerUsername) continue;
      const m = ids.get(r.managerUsername) ?? ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = ?", r.managerUsername)!.id;
      ctx.db.run("UPDATE users SET manager_id = ? WHERE id = ?", m, ids.get(r.username));
    }
    audit(ctx.db, { type: "user", id: u.id }, "employee.import", { type: "import", id: sha256.slice(0, 16) },
      { count: rows.length, sheet: sheet.sheetName, sha256 });
    ctx.bus.emit("employee.updated", { departmentId: null }, { count: rows.length }, u.id);
    result.applied = true;
    return result;
  });
}

/** A new one-time activation code for an HQ person who has not activated yet (previous codes stop working). */
export function reissueHqInvitation(ctx: Ctx, u: AuthUser, userId: string) {
  if (!has(u, "users:manage") && !has(u, "employees:manage_all")) throw forbidden();
  const p = ctx.db.get<{ home_unit_id: string; activation_status: string }>("SELECT home_unit_id, activation_status FROM users WHERE id = ?", userId);
  if (!p || p.home_unit_id !== "hq") throw badRequest("Xodim topilmadi");
  if (p.activation_status === "ACTIVE") throw conflict("already_active", "Hisob allaqachon faol");
  return ctx.db.tx(() => {
    const inv = issueInvitation(ctx, u, "hq", userId, "employee");
    audit(ctx.db, { type: "user", id: u.id }, "employee.invitation", { type: "user", id: userId });
    return inv;
  });
}
