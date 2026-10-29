// Recurrence rules for routines — a small, explicit subset of RFC 5545 RRULE, evaluated in a time zone.
//   FREQ=DAILY;BYHOUR=9;BYMINUTE=0
//   FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30
//   FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0      (BYMONTHDAY=-1 → last day of month)
//   INTERVAL=n is supported for all three.

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY";
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export interface Rule {
  freq: Freq;
  interval: number;
  byDay: number[]; // 0 = Sunday
  byMonthDay: number[];
  hour: number;
  minute: number;
}

export function parseRule(s: string): Rule {
  const parts = Object.fromEntries(
    s.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
      const [k, v] = p.split("=");
      return [k.toUpperCase(), (v ?? "").toUpperCase()];
    }),
  );
  const freq = parts.FREQ as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) throw new Error("FREQ DAILY, WEEKLY yoki MONTHLY bo'lishi kerak");
  const num = (v: string | undefined, d: number, min: number, max: number, name: string) => {
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} noto'g'ri: ${v}`);
    return n;
  };
  const byDay = parts.BYDAY
    ? parts.BYDAY.split(",").map((d: string) => {
        const i = DAYS.indexOf(d as (typeof DAYS)[number]);
        if (i < 0) throw new Error(`BYDAY noto'g'ri: ${d}`);
        return i;
      })
    : [];
  const byMonthDay = parts.BYMONTHDAY
    ? parts.BYMONTHDAY.split(",").map((d: string) => {
        const n = Number(d);
        if (!Number.isInteger(n) || n === 0 || n < -1 || n > 31) throw new Error(`BYMONTHDAY noto'g'ri: ${d}`);
        return n;
      })
    : [];
  if (freq === "WEEKLY" && !byDay.length) throw new Error("WEEKLY uchun BYDAY kerak (masalan BYDAY=MO)");
  if (freq === "MONTHLY" && !byMonthDay.length) throw new Error("MONTHLY uchun BYMONTHDAY kerak (masalan BYMONTHDAY=1)");
  return {
    freq,
    interval: num(parts.INTERVAL, 1, 1, 52, "INTERVAL"),
    byDay,
    byMonthDay,
    hour: num(parts.BYHOUR, 9, 0, 23, "BYHOUR"),
    minute: num(parts.BYMINUTE, 0, 0, 59, "BYMINUTE"),
  };
}

export function formatRule(r: Rule): string {
  const p = [`FREQ=${r.freq}`];
  if (r.interval > 1) p.push(`INTERVAL=${r.interval}`);
  if (r.byDay.length) p.push(`BYDAY=${r.byDay.map((d) => DAYS[d]).join(",")}`);
  if (r.byMonthDay.length) p.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  p.push(`BYHOUR=${r.hour}`, `BYMINUTE=${r.minute}`);
  return p.join(";");
}

// ---- time zone helpers (wall clock ↔ UTC) via Intl; correct for zones with or without DST ----
function offsetMinutes(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** UTC instant of a wall-clock time in tz. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m, d, hh, mm);
  const off = offsetMinutes(guess, tz);
  const t = guess - off * 60000;
  const off2 = offsetMinutes(t, tz);
  return new Date(off2 === off ? t : guess - off2 * 60000);
}

/** Wall-clock calendar date (y, m, d, weekday) of an instant in tz. */
export function zonedParts(at: Date, tz: string) {
  const off = offsetMinutes(at.getTime(), tz);
  const w = new Date(at.getTime() + off * 60000);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth(), d: w.getUTCDate(), dow: w.getUTCDay(), hh: w.getUTCHours(), mm: w.getUTCMinutes() };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Does local calendar date (y, m, d) match the rule, counting INTERVAL from the anchor date? */
function matchesDay(r: Rule, y: number, m: number, d: number, anchor: { y: number; m: number; d: number }): boolean {
  const day = Date.UTC(y, m, d) / 86_400_000;
  const a = Date.UTC(anchor.y, anchor.m, anchor.d) / 86_400_000;
  if (day < a) return false;
  switch (r.freq) {
    case "DAILY":
      return (day - a) % r.interval === 0;
    case "WEEKLY": {
      const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
      if (!r.byDay.includes(dow)) return false;
      // weeks counted Monday-based from the anchor week
      const mondayIdx = (x: number) => Math.floor((x + 3) / 7);
      return (mondayIdx(day) - mondayIdx(a)) % r.interval === 0;
    }
    case "MONTHLY": {
      const months = (y - anchor.y) * 12 + (m - anchor.m);
      if (months % r.interval !== 0) return false;
      const last = daysInMonth(y, m);
      // days beyond month length (31 in April) fall on the last day, like most calendars
      return r.byMonthDay.some((bd) => (bd === -1 ? d === last : Math.min(bd, last) === d));
    }
  }
}

/** First occurrence strictly after `after`. `anchor` = rule start (its date anchors INTERVAL). */
export function nextOccurrence(rule: string | Rule, after: Date, tz = "Asia/Tashkent", anchor: Date = after): Date {
  const r = typeof rule === "string" ? parseRule(rule) : rule;
  const a = zonedParts(anchor, tz);
  const start = zonedParts(after, tz);
  for (let i = 0; i < 800; i++) {
    const probe = new Date(Date.UTC(start.y, start.m, start.d + i));
    const y = probe.getUTCFullYear(), m = probe.getUTCMonth(), d = probe.getUTCDate();
    if (!matchesDay(r, y, m, d, a)) continue;
    const at = zonedToUtc(y, m, d, r.hour, r.minute, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("Keyingi sana topilmadi");
}

/** All occurrences in [from, to) — used to project routines onto the calendar. */
export function occurrences(rule: string | Rule, from: Date, to: Date, tz = "Asia/Tashkent", anchor: Date = from, max = 400): Date[] {
  const out: Date[] = [];
  let cur = new Date(from.getTime() - 1);
  for (let i = 0; i < max; i++) {
    const n = nextOccurrence(rule, cur, tz, anchor);
    if (n.getTime() >= to.getTime()) break;
    out.push(n);
    cur = n;
  }
  return out;
}

/** Human readable (Uzbek) description for the UI. */
export function describeRule(rule: string): string {
  const r = parseRule(rule);
  const time = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
  const names = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
  if (r.freq === "DAILY") return `${r.interval > 1 ? `Har ${r.interval} kunda` : "Har kuni"} ${time}`;
  if (r.freq === "WEEKLY") return `${r.interval > 1 ? `Har ${r.interval} haftada` : "Har"} ${r.byDay.map((d) => names[d]).join(", ")} ${time}`;
  return `${r.interval > 1 ? `Har ${r.interval} oyda` : "Har oy"} ${r.byMonthDay.map((d) => (d === -1 ? "oxirgi kuni" : `${d}-sanada`)).join(", ")} ${time}`;
}
