import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { adminClient, makeApp } from "./helpers.js";
import { chunkText, extractText } from "../src/knowledge/extract.js";
import { ftsQuery, ingestDocument, listDocuments, removeDocument, searchKnowledge } from "../src/knowledge/service.js";
import { addMemory, approvedMemory, decideApproval, decideMemory, listApprovals, listInstructions, saveInstruction } from "../src/domain/brain.js";
import { createTask, getTask } from "../src/domain/tasks.js";
import { AgentRunner } from "../src/agents/runner.js";
import { MockLlm } from "../src/llm/mock.js";
import { SYSTEM } from "../src/lib/audit.js";
import { embedPending, embedderOf, retrieve, type Embedder } from "../src/knowledge/semantic.js";
import { knowledgeStatus } from "../src/knowledge/service.js";

const admin = { type: "user" as const, id: null };
const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal valid one-page PDF with a text object (offsets computed so pdf.js accepts it). */
function makePdf(text: string): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc(out);
}

describe("knowledge extraction", () => {
  it("reads TXT/MD/CSV, DOCX, XLSX and PDF", async () => {
    expect((await extractText(enc("﻿Salom dunyo"), "a.txt")).text).toBe("Salom dunyo");
    expect((await extractText(enc("# Narxlar\n- gilam 120$"), "b.md")).text).toContain("gilam 120$");
    expect((await extractText(enc("mahsulot,narx\nGilam A,120"), "c.csv")).text).toContain("Gilam A,120");

    const docx = zipSync({
      "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Qaytarish</w:t></w:r><w:r><w:t xml:space="preserve"> siyosati</w:t></w:r></w:p><w:p><w:r><w:t>14 kun &amp; chek</w:t></w:r></w:p></w:body></w:document>'),
    });
    expect((await extractText(docx, "policy.docx")).text).toBe("Qaytarish siyosati\n14 kun & chek");

    const xlsx = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Narxlar" sheetId="1"/></sheets></workbook>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Mahsulot</t></si><si><t>Gilam Lux</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Narx</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>149</v></c></row></sheetData></worksheet>'),
    });
    const x = (await extractText(xlsx, "prices.xlsx")).text;
    expect(x).toContain("## Narxlar");
    expect(x).toContain("Gilam Lux | 149");

    const pdf = (await extractText(makePdf("Kompaniya SAG gilamlari"), "about.pdf")).text;
    expect(pdf).toContain("Kompaniya SAG gilamlari");
  });

  it("rejects unsupported, spoofed and empty files", async () => {
    await expect(extractText(enc("MZ..."), "x.exe")).rejects.toThrow(/qo'llab-quvvatlanmaydi/);
    await expect(extractText(enc("not a pdf"), "fake.pdf")).rejects.toThrow(/PDF emas/);
    await expect(extractText(enc("hello"), "fake.docx")).rejects.toThrow(/DOCX emas/);
    await expect(extractText(enc("   \n "), "empty.txt")).rejects.toThrow(/matn olinmadi/);
  });

  it("chunks long text into overlapping passages", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraf ${i}. ${"so'z ".repeat(30)}`).join("\n\n");
    const chunks = chunkText(text, 800, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 900)).toBe(true);
  });

  it("builds a safe FTS query from free text", () => {
    expect(ftsQuery('Gilam narxi "OR" NEAR(x)')).toBe('"gilam" OR "narxi" OR "near"');
    expect(ftsQuery("a b")).toBeNull();
  });
});

describe("knowledge base", () => {
  it("indexes, dedupes, versions and removes documents", async () => {
    const { deps } = await makeApp();
    const a = await ingestDocument(deps, { filename: "narxlar.md", data: enc("Gilam Lux narxi 149 dollar."), departmentId: null }, admin);
    expect(a).toMatchObject({ title: "narxlar", version: 1, status: "indexed" });
    const dup = await ingestDocument(deps, { filename: "narxlar.md", data: enc("Gilam Lux narxi 149 dollar."), departmentId: null }, admin);
    expect(dup.duplicate).toBe(true);
    const v2 = await ingestDocument(deps, { filename: "narxlar.md", data: enc("Gilam Lux narxi 159 dollar."), departmentId: null }, admin);
    expect(v2.version).toBe(2);
    expect(listDocuments(deps)).toHaveLength(1);
    const hits = searchKnowledge(deps, "Gilam Lux narxi");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("159"); // old version no longer searchable
    removeDocument(deps, v2.id, admin);
    expect(searchKnowledge(deps, "Gilam Lux")).toHaveLength(0);
    expect(deps.db.get<{ n: number }>("SELECT COUNT(*) n FROM knowledge_documents")!.n).toBe(2); // history kept
  });

  it("limits retrieval to company-wide + own department documents", async () => {
    const { deps } = await makeApp();
    await ingestDocument(deps, { filename: "maosh.txt", data: enc("Maosh jadvali: maxfiy byudjet"), departmentId: "finance" }, admin);
    await ingestDocument(deps, { filename: "brand.txt", data: enc("Brend uslubi: byudjet tejamkor ohang"), departmentId: null }, admin);
    expect(searchKnowledge(deps, "byudjet", { departmentId: "marketing" }).map((h) => h.title)).toEqual(["brand"]);
    expect(searchKnowledge(deps, "byudjet", { departmentId: "finance" })).toHaveLength(2);
  });

  it("semantic search: embeds chunks, fuses with BM25, respects scope, falls back on failure", async () => {
    const { deps } = await makeApp();
    const embedder = embedderOf(new MockLlm())!;
    await ingestDocument(deps, { filename: "maosh.txt", data: enc("Maosh jadvali: maxfiy byudjet hisoboti"), departmentId: "finance" }, admin);
    await ingestDocument(deps, { filename: "brand.txt", data: enc("Brend uslubi: tejamkor samimiy ohang"), departmentId: null }, admin);
    expect(knowledgeStatus(deps, embedder.model).semantic).toMatchObject({ available: true, embedded: 0, pending: 2 });
    expect(await embedPending(deps, embedder)).toBe(2);
    expect(await embedPending(deps, embedder)).toBe(0); // idempotent
    expect(knowledgeStatus(deps, embedder.model).semantic).toMatchObject({ embedded: 2, pending: 0 });

    // "uslubi ohang" has no exact FTS overlap with "samimiy" but shares words semantically (mock = bag of words)
    const r = await retrieve(deps, embedder, "brend ohang uslubi", { departmentId: "marketing" });
    expect(r.mode).toBe("hybrid");
    expect(r.hits.map((h) => h.title)).toEqual(["brand"]); // finance doc never leaks to marketing
    const fin = await retrieve(deps, embedder, "maxfiy byudjet", { departmentId: "finance" });
    expect(fin.hits[0].title).toBe("maosh");

    const broken: Embedder = { model: embedder.model, embed: async () => { throw new Error("429"); } };
    const errors: unknown[] = [];
    const fb = await retrieve(deps, broken, "tejamkor ohang", { departmentId: null, onError: (e) => errors.push(e) });
    expect(fb.mode).toBe("fulltext");
    expect(fb.hits.map((h) => h.title)).toEqual(["brand"]);
    expect(errors).toHaveLength(1);
    expect(knowledgeStatus(deps, null).semantic.available).toBe(false);
  });

  it("upload API: multipart, permissions, clear errors", async () => {
    const { app, deps } = await makeApp();
    const api = await adminClient(app);
    const cookie = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-admin-pass" } })).cookies[0];
    const boundary = "----sagtest";
    const body = (name: string, content: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="departmentId"\r\n\r\nmarketing\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    const up = await app.inject({
      method: "POST", url: "/api/knowledge", payload: body("kontent.txt", "Instagram uchun haftada 4 post"),
      headers: { cookie: `${cookie.name}=${cookie.value}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode).toBe(201);
    expect(JSON.parse(up.body).document).toMatchObject({ departmentId: "marketing", title: "kontent" });
    const bad = await app.inject({
      method: "POST", url: "/api/knowledge", payload: body("virus.exe", "MZ"),
      headers: { cookie: `${cookie.name}=${cookie.value}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(bad.statusCode).toBe(400);
    expect((await api.get("/api/knowledge")).body.status).toMatchObject({ documents: 1, semantic: { available: false } });
    expect((await api.get("/api/knowledge/search?q=Instagram%20post&departmentId=finance")).body.hits).toHaveLength(0);
    expect(deps.db.get("SELECT 1 FROM audit_logs WHERE action = 'knowledge.ingest'")).toBeTruthy();
  });
});

describe("instructions, memory, approvals", () => {
  it("versions instructions and keeps history", async () => {
    const { deps } = await makeApp();
    saveInstruction(deps, { scope: "GLOBAL", scopeId: null, title: "Kompaniya haqida", content: "v1" }, admin);
    saveInstruction(deps, { scope: "GLOBAL", scopeId: null, title: "Kompaniya haqida", content: "v2" }, admin);
    const active = listInstructions(deps, "GLOBAL", null).filter((i) => i.title === "Kompaniya haqida");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ version: 2, content: "v2" });
    expect(listInstructions(deps, "GLOBAL", null, true).filter((i) => i.title === "Kompaniya haqida")).toHaveLength(2);
    expect(() => saveInstruction(deps, { scope: "DEPARTMENT", scopeId: "nope", title: "x", content: "y" }, admin)).toThrow();
  });

  it("only approved memory reaches agents", async () => {
    const { deps } = await makeApp();
    const m = addMemory(deps, { kind: "lesson", content: "Narxlarni doim so'mda yoz", departmentId: null }, { type: "agent", id: "it-aziz" });
    expect(m.status).toBe("PENDING");
    expect(approvedMemory(deps, "marketing")).toHaveLength(0);
    decideMemory(deps, m.id, "APPROVED", admin);
    expect(approvedMemory(deps, "marketing").map((x) => x.content)).toEqual(["Narxlarni doim so'mda yoz"]);
    expect(() => decideMemory(deps, m.id, "REJECTED", admin)).toThrow(/allaqachon/);
  });

  it("result approval: approve → DONE; reject → rework with feedback + correction proposed", async () => {
    const { deps } = await makeApp();
    await ingestDocument(deps, { filename: "brand.md", data: enc("SAG brend ohangi: samimiy, ishonchli. Gilam kolleksiyasi Lux."), departmentId: null }, admin);
    const llm = new MockLlm("Kontent rejasi tayyor");
    const r = new AgentRunner(deps, llm, { inputPerM: 0, outputPerM: 0 }, { concurrency: 2, pollMs: 50, taskTimeoutMs: 5000, retryDelayMs: 1, settleMs: 5 });
    const t = createTask(deps, { title: "Gilam kolleksiyasi uchun brend ohangida post", agentId: "marketing-asal", requiresApproval: true }, SYSTEM);
    await Promise.all(r.tick());
    // grounded in the uploaded document, cited at the end
    expect(llm.calls[0].messages[0].text).toContain('<document source="brand">');
    expect(getTask(deps, t.id).status).toBe("WAITING_APPROVAL");
    const [apr] = listApprovals(deps);
    expect(apr).toMatchObject({ taskId: t.id, status: "PENDING" });

    expect(() => decideApproval(deps, apr.id, "reject", "", admin, "web")).toThrow(/sababini/);
    const back = decideApproval(deps, apr.id, "reject", "Ko'proq emoji ishlat", admin, "web");
    expect(back.status).toBe("QUEUED");
    expect(back.description).toContain("Ko'proq emoji ishlat");
    expect(deps.db.get("SELECT 1 FROM company_memory WHERE kind = 'correction' AND status = 'PENDING'")).toBeTruthy();

    await Promise.all(r.tick());
    const [apr2] = listApprovals(deps);
    expect(decideApproval(deps, apr2.id, "approve", undefined, admin, "web").status).toBe("DONE");
    const d = deps.db.get<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ? ORDER BY created_at DESC", t.id)!;
    expect(d.content).toContain("Manbalar (kompaniya hujjatlari):** brand");
    // the finished result is proposed to company memory, not trusted automatically
    expect(deps.db.get("SELECT status FROM company_memory WHERE kind = 'result' AND task_id = ?", t.id)).toMatchObject({ status: "PENDING" });
    await r.stop();
  });

  it("brain API enforces brain:manage", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/instructions", { scope: "GLOBAL", title: "Kompaniya haqida", content: "SAG — gilam ishlab chiqaruvchi" })).status).toBe(201);
    expect((await api.post("/api/memory", { kind: "rule", content: "Har hisobotda manba ko'rsat" })).body.memory.status).toBe("APPROVED");
    expect((await api.put("/api/connectors/telegram/departments", { departmentIds: ["reception", "director"] })).status).toBe(200);
    expect((await api.get("/api/telegram")).body.status.configured).toBe(false);
  });
});
