import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBlocks, parseSpans } from "./file-markdown.ts";
import { base64, csv, fileName, makeFile, previewTable } from "./files.ts";
import { cellValue, columnName, crc32, markdownDocx, sheetNames, workbook } from "./ooxml.ts";
import { markdownPdf, winAnsi } from "./pdf.ts";

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** A stored zip's entries, each checked against its CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, "has an end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `${name}'s CRC`);
    out.set(name, new TextDecoder().decode(data));
    at += 46 + nameLength;
  }
  return out;
}

const REPORT = `# Quarterly report

Revenue grew **12%** to *$1.2M*. See [the dashboard](https://example.com/q3) and \`acme/web\`.

## Highlights

- Shipped the merge queue
- Cut p95 latency
  1. In the API
2. Ordered too

> [!NOTE]
> Numbers are unaudited.

| Region | Revenue | Growth |
| --- | ---: | --- |
| North | 400,000 | 10% |
| South | 800,000 | 13% |

\`\`\`ts
const total = north + south;
\`\`\`

---

Done.`;

test("Markdown reads into the blocks a file needs", () => {
  const blocks = parseBlocks(REPORT);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "paragraph", "heading", "item", "item", "item", "item", "quote", "table", "code", "rule", "paragraph"],
  );
  const table = blocks.find((b) => b.kind === "table");
  assert.ok(table && table.kind === "table");
  assert.equal(table.rows.length, 2);
  const quote = blocks.find((b) => b.kind === "quote");
  assert.ok(quote && quote.kind === "quote");
  assert.match(quote.spans.map((s) => s.text).join(""), /^Note: Numbers are unaudited/);
  assert.deepEqual(parseSpans("a **b** _c_ `d` [e](https://x.y) snake_case_word"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", code: true },
    { text: " " },
    { text: "e", href: "https://x.y" },
    { text: " snake_case_word" },
  ]);
});

test("a PDF is well formed: every object where the cross-reference table says, pages counted, links annotated", () => {
  const { bytes, pages, truncated } = markdownPdf("Quarterly report", REPORT);
  const text = latin1(bytes);
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.equal(pages, 1);
  assert.equal(truncated, false);
  const xref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
  assert.ok(text.slice(xref).startsWith("xref\n"));
  const entries = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} is where the table says`));
  assert.match(text, /\/Count 1 >>/);
  assert.match(text, /\(Quarterly report\) Tj/);
  assert.match(text, /\(Region\) Tj/);
  assert.match(text, /\/URI \(https:\/\/example.com\/q3\)/);
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assert.ok(text.slice(start + Number(m[1])).startsWith("\nendstream"), "each stream is as long as it says");
  }
  // The title isn't repeated when the Markdown starts with it.
  assert.equal(text.match(/\(Quarterly report\) Tj/g)!.length, 1);
});

test("a long PDF breaks across pages and numbers them", () => {
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}: ${"words ".repeat(40)}`).join("\n\n");
  const { bytes, pages } = markdownPdf("Long", long);
  assert.ok(pages > 10);
  const text = latin1(bytes);
  assert.match(text, new RegExp(`/Count ${pages} >>`));
  assert.match(text, new RegExp(`\\(${pages} of ${pages}\\) Tj`));
});

test("PDF text is Windows-1252: curly quotes and dashes kept, accents folded, emoji dropped", () => {
  assert.deepEqual(winAnsi("“a” – b"), [0x93, 0x61, 0x94, 0x20, 0x96, 0x20, 0x62]);
  assert.deepEqual(winAnsi("é"), [0xe9]);
  assert.deepEqual(winAnsi("ő"), [0x6f]);
  assert.deepEqual(winAnsi("ok 🚀"), [0x6f, 0x6b, 0x20]);
  assert.deepEqual(winAnsi("中"), [0x3f]);
});

test("a Word document is a valid package with the text, styles and links", () => {
  const files = unzip(markdownDocx("Quarterly report", REPORT, new Date("2026-10-10T12:00:00Z")));
  assert.deepEqual([...files.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"]);
  const document = files.get("word/document.xml")!;
  assert.match(document, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Quarterly report<\/w:t>/);
  assert.match(document, /<w:b\/><\/w:rPr><w:t xml:space="preserve">12%<\/w:t>/);
  assert.match(document, /<w:hyperlink r:id="rIdLink1">/);
  assert.match(document, /<w:tbl>/);
  assert.match(files.get("word/_rels/document.xml.rels")!, /Target="https:\/\/example.com\/q3" TargetMode="External"/);
  assert.match(files.get("docProps/core.xml")!, /<dc:title>Quarterly report<\/dc:title>/);
  // Text is escaped.
  const escaped = unzip(markdownDocx("x", "a < b & c"));
  assert.match(escaped.get("word/document.xml")!, /a &lt; b &amp; c/);
});

test("a workbook keeps numbers as numbers, codes as text, and a bold frozen header", () => {
  const files = unzip(
    workbook("Sales", [
      { name: "Q3: by region", rows: [["Region", "Revenue", "Zip"], ["North", 400000, "02139"], ["South", "800000.5", null]] },
      { name: "Q3: by region", rows: [["a"]] },
    ]),
  );
  assert.match(files.get("xl/workbook.xml")!, /<sheet name="Q3 by region" sheetId="1"/);
  assert.match(files.get("xl/workbook.xml")!, /<sheet name="Q3 by region 2" sheetId="2"/);
  const sheet = files.get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Region<\/t>/);
  assert.match(sheet, /<c r="B2"><v>400000<\/v><\/c>/);
  assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">02139<\/t>/);
  assert.match(sheet, /<c r="B3"><v>800000.5<\/v><\/c>/);
  assert.match(sheet, /state="frozen"/);
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(701), "ZZ");
  assert.deepEqual(cellValue("007"), { kind: "text", value: "007" });
  assert.deepEqual(sheetNames(["", "a/b", "x".repeat(40)]), ["Sheet1", "a b", "x".repeat(31)]);
});

test("CSV quotes what it must, and starts with a byte-order mark", () => {
  assert.equal(csv([["a", "b,c"], ['say "hi"', 3], [null, "line\nbreak"]]), '﻿a,"b,c"\r\n"say ""hi""",3\r\n,"line\nbreak"\r\n');
});

test("make_file's checks: formats it can't write, missing content, a CSV of two sheets", () => {
  const slides = makeFile({ format: "pptx", title: "Deck" });
  assert.equal(slides.ok, false);
  assert.match(!slides.ok ? slides.message : "", /Slide decks and images aren't available yet/);
  assert.equal(makeFile({ format: "pdf", title: "x", content: "  " }).ok, false);
  assert.equal(makeFile({ format: "pdf", title: "", content: "x" }).ok, false);
  const two = makeFile({ format: "csv", title: "x", sheets: [{ rows: [["a"]] }, { rows: [["b"]] }] });
  assert.match(!two.ok ? two.message : "", /one sheet/);
  const pdf = makeFile({ format: ".PDF", title: "Q3/Q4 report.pdf", content: "Hello" });
  assert.ok(pdf.ok);
  assert.equal(pdf.ok && pdf.file.name, "Q3 Q4 report.pdf");
  assert.equal(pdf.ok && pdf.file.content_type, "application/pdf");
  assert.equal(pdf.ok && pdf.file.summary, "1 page");
  const sheet = makeFile({ format: "xlsx", title: "Sales", sheets: [{ name: "S", rows: [["a", "b"], [1, 2], [3, 4]] }] });
  assert.equal(sheet.ok && sheet.file.summary, "2 rows");
  assert.equal(fileName("", "md"), "file.md");
});

test("a spreadsheet's preview in its doc, and base64 for the trip to the artifacts service", () => {
  const rows = [["Name", "Total"], ...Array.from({ length: 25 }, (_, i) => [`r${i}`, i])];
  const preview = previewTable({ name: "S", rows });
  assert.match(preview, /^\| Name \| Total \|\n\| --- \| --- \|\n\| r0 \| 0 \|/);
  assert.match(preview, /_First 20 of 25 rows._$/);
  const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
  assert.equal(Buffer.from(base64(bytes), "base64").equals(Buffer.from(bytes)), true);
});
