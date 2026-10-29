// Text extraction for uploaded company documents. Pure JS, no native deps:
// PDF via unpdf (pdf.js), DOCX/XLSX read straight from their ZIP/XML, CSV/TXT/Markdown as UTF-8.
import { unzipSync, type Unzipped } from "fflate";
import { badRequest } from "../lib/errors.js";

export const SUPPORTED = ["pdf", "docx", "xlsx", "csv", "txt", "md"] as const;
export type DocKind = (typeof SUPPORTED)[number];

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;

export function kindOf(filename: string): DocKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "markdown") return "md";
  if ((SUPPORTED as readonly string[]).includes(ext)) return ext as DocKind;
  throw badRequest(`Fayl turi qo'llab-quvvatlanmaydi (.${ext}). Ruxsat: ${SUPPORTED.join(", ")}`);
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

export async function extractText(buf: Uint8Array, filename: string): Promise<{ kind: DocKind; text: string }> {
  const kind = kindOf(filename);
  if (buf.length > MAX_UPLOAD_BYTES) throw badRequest("Fayl 15 MB dan katta");
  // The content must match the extension (no renamed executables / spoofed files).
  if (kind === "pdf" && !isPdf(buf)) throw badRequest("Fayl PDF emas (ichki format mos kelmadi)");
  if ((kind === "docx" || kind === "xlsx") && !isZip(buf)) throw badRequest(`Fayl ${kind.toUpperCase()} emas (ichki format mos kelmadi)`);
  let text: string;
  switch (kind) {
    case "pdf": text = await pdfText(buf); break;
    case "docx": text = docxText(unzip(buf, (n) => n === "word/document.xml")); break;
    case "xlsx": text = xlsxText(unzip(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n))); break;
    default: text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  }
  text = normalise(text);
  if (!text.trim()) throw badRequest("Fayldan matn olinmadi (bo'sh yoki skanerlangan rasm bo'lishi mumkin)");
  return { kind, text };
}

/** Unzip only the entries we need, refusing zip bombs. */
function unzip(buf: Uint8Array, want: (name: string) => boolean): Unzipped {
  let total = 0;
  return unzipSync(buf, {
    filter: (f) => {
      if (!want(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw badRequest("Arxiv ichidagi ma'lumot juda katta");
      return true;
    },
  });
}

async function pdfText(buf: Uint8Array): Promise<string> {
  const { extractText: pdfExtract, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await pdfExtract(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t, i) => `\n[Sahifa ${i + 1}]\n${t}`).join("\n");
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const utf8 = (u?: Uint8Array) => (u ? new TextDecoder("utf-8").decode(u) : "");

function docxText(files: Unzipped): string {
  const xml = utf8(files["word/document.xml"]);
  if (!xml) throw badRequest("DOCX ichida hujjat matni topilmadi");
  // Walk each paragraph's text runs, tabs and line breaks in document order.
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0].startsWith("<w:tab") ? "\t" : m[0].startsWith("<w:br") ? "\n" : xmlText(m[1])))
        .join(""),
    )
    .join("\n");
}

function xlsxText(files: Unzipped): string {
  const shared = [...utf8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const names = [...utf8(files["xl/workbook.xml"]).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => xmlText(m[1]));
  const sheets = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10));
  return sheets
    .map((n, i) => {
      const rows = [...utf8(files[n]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const attrs = c[1];
            const body = c[2] ?? "";
            const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
            if (/t="s"/.test(attrs) && v !== undefined) return shared[+v] ?? "";
            if (/t="inlineStr"/.test(attrs)) return xmlText([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
            return v !== undefined ? xmlText(v) : "";
          })
          .join(" | "),
      );
      return `## ${names[i] ?? `Varaq ${i + 1}`}\n${rows.filter((r) => r.replace(/[|\s]/g, "")).join("\n")}`;
    })
    .join("\n\n");
}

function normalise(t: string) {
  return t.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\u0000/g, "").trim();
}

/** Paragraph-aware chunks of ~1200 chars with a small overlap, so retrieval returns self-contained passages. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const paras = text.split(/\n{2,}/).flatMap((p) => (p.length <= size ? [p] : splitLong(p, size)));
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap)) + "\n\n" + p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function splitLong(p: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of p.split(/(?<=[.!?;])\s+|\n/)) {
    if (cur && cur.length + s.length + 1 > size) {
      out.push(cur);
      cur = "";
    }
    if (s.length > size) {
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      continue;
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}
