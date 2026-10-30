// Minimal .xlsx reader (first sheet, cell text only). No new dependency: fflate is already used for documents.
import { strFromU8, unzipSync } from "fflate";

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");

export interface SheetRow {
  /** 1-based row number in the sheet */
  row: number;
  /** column letter → trimmed text (empty cells omitted) */
  cells: Record<string, string>;
}

export function readFirstSheet(data: Uint8Array): { sheetName: string; rows: SheetRow[] } {
  const files = unzipSync(data);
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : "");
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("Not an .xlsx workbook (xl/workbook.xml missing)");
  const sheetName = unxml(workbook.match(/<sheet [^>]*name="([^"]+)"/)?.[1] ?? "Sheet1");
  const rels = text("xl/_rels/workbook.xml.rels");
  const rid = workbook.match(/<sheet [^>]*r:id="([^"]+)"/)?.[1];
  const target = rid ? rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`))?.[1] : undefined;
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = text(sheetPath);
  if (!sheet) throw new Error(`Sheet not found: ${sheetPath}`);
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));

  const rows: SheetRow[] = [];
  for (const r of sheet.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      const raw = /t="s"/.test(c[2]) ? shared[Number(v)] : inline !== undefined ? unxml(inline) : v !== undefined ? unxml(v) : undefined;
      const val = raw?.replace(/\s+/g, " ").trim();
      if (val) cells[c[1]] = val;
    }
    if (Object.keys(cells).length) rows.push({ row: Number(r[1]), cells });
  }
  return { sheetName, rows };
}
