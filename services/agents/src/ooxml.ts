/**
 * Word documents and spreadsheets for `make_file` (files.ts), as Office
 * Open XML: a .docx from Markdown and an .xlsx from rows, each a zip of a
 * few XML parts. Pure and small: the zip stores its parts uncompressed,
 * which every reader takes.
 */
import { type Block, type Span, parseBlocks } from "./file-markdown.ts";

// ── Zip ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of `files` (path to bytes or text), stored without compression. */
export function zip(files: [string, Uint8Array | string][], at = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at2 = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at2);
    at2 += part.length;
  }
  return out;
}

/** Text for XML: escaped, without the control characters XML forbids. */
export function xml(text: string): string {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function coreProps(title: string, at: Date): string {
  const when = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>g1t</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`;
}

// ── Word ──────────────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const DOCX_STYLES = `${XML_HEAD}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="140" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2F5FD0"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="Table"><w:name w:val="Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function runs(spans: Span[], links: string[], base: { bold?: boolean } = {}): string {
  return spans
    .map((span) => {
      const props = [
        span.href ? '<w:rStyle w:val="Hyperlink"/>' : "",
        span.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : "",
        span.bold || base.bold ? "<w:b/>" : "",
        span.italic ? "<w:i/>" : "",
        span.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : "",
      ].join("");
      const run = `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(span.text)}</w:t></w:r>`;
      if (!span.href || !/^(https?:|mailto:)/i.test(span.href)) return run;
      links.push(span.href);
      return `<w:hyperlink r:id="rIdLink${links.length}">${run}</w:hyperlink>`;
    })
    .join("");
}

function paragraph(style: string | null, body: string, extra = ""): string {
  const props = `${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}`;
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${body}</w:p>`;
}

function wordBlock(block: Block, links: string[]): string {
  switch (block.kind) {
    case "heading":
      return paragraph(`Heading${block.level}`, runs(block.spans, links));
    case "paragraph":
      return paragraph(null, runs(block.spans, links));
    case "item": {
      const left = 360 + block.depth * 360;
      const marker = block.ordered ? `${block.number}.` : block.depth % 2 ? "–" : "•";
      return paragraph("ListParagraph", `<w:r><w:t xml:space="preserve">${xml(marker)}</w:t></w:r><w:r><w:tab/></w:r>${runs(block.spans, links)}`, `<w:tabs><w:tab w:val="left" w:pos="${left}"/></w:tabs><w:ind w:left="${left}" w:hanging="300"/>`);
    }
    case "quote":
      return paragraph("Quote", runs(block.spans, links));
    case "code":
      return paragraph(
        "Code",
        block.text
          .split("\n")
          .map((line, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`)
          .join(""),
      );
    case "rule":
      return paragraph(null, "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
    case "table": {
      const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
      const row = (cells: Span[][], header: boolean) =>
        `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: columns }, (_, c) => `<w:tc><w:tcPr>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : ""}</w:tcPr>${paragraph(null, runs(cells[c] ?? [], links, { bold: header }), '<w:spacing w:after="0"/>')}</w:tc>`).join("")}</w:tr>`;
      return `<w:tbl><w:tblPr><w:tblStyle w:val="Table"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor(9720 / columns)}"/>`).join("")}</w:tblGrid>${block.header.length ? row(block.header, true) : ""}${block.rows.map((r) => row(r, false)).join("")}</w:tbl>${paragraph(null, "")}`;
    }
  }
}

/** A Word document of `markdown`, titled `title` (as its first heading when the Markdown starts without one). */
export function markdownDocx(title: string, markdown: string, at = new Date()): Uint8Array {
  let blocks = parseBlocks(markdown);
  if (title.trim() && !(blocks[0]?.kind === "heading" && blocks[0].level === 1)) blocks = [{ kind: "heading", level: 1, spans: [{ text: title.trim() }] }, ...blocks];
  const links: string[] = [];
  const body = blocks.map((block) => wordBlock(block, links)).join("\n");
  const document = `${XML_HEAD}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1260" w:right="1260" w:bottom="1260" w:left="1260" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links
    .map((href, i) => `<Relationship Id="rIdLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(href)}" TargetMode="External"/>`)
    .join("")}</Relationships>`;
  return zip(
    [
      [
        "[Content_Types].xml",
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
      ],
      ["docProps/core.xml", coreProps(title, at)],
      ["word/document.xml", document],
      ["word/_rels/document.xml.rels", rels],
      ["word/styles.xml", DOCX_STYLES],
    ],
    at,
  );
}

// ── Excel ─────────────────────────────────────────────────────────────────

export type Cell = string | number | boolean | null;
export type Sheet = { name: string; rows: Cell[][] };

/** A column's letters: 0 is A, 26 is AA. */
export function columnName(index: number): string {
  let name = "";
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + ((i - 1) % 26)) + name;
  return name;
}

/** A cell's value as Excel keeps it: numbers (and numeric text) as numbers, the rest as text. */
export function cellValue(value: Cell): { kind: "number"; value: number } | { kind: "text"; value: string } | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : { kind: "text", value: String(value) };
  if (typeof value === "boolean") return { kind: "text", value: value ? "TRUE" : "FALSE" };
  const text = String(value);
  // Numeric text is a number, unless a leading zero says it's a code (a ZIP, an id).
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text.trim())) return { kind: "number", value: Number(text.trim()) };
  return { kind: "text", value: text };
}

/** A sheet name Excel takes: at most 31 characters, none of []:*?/\, unique in the workbook. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = (String(raw ?? "").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || `Sheet${i + 1}`).replace(/^'|'$/g, "").slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function worksheet(sheet: Sheet): string {
  const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.min(60, Math.max(8, ...sheet.rows.slice(0, 200).map((row) => String(row[c] ?? "").length + 2))));
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((raw, c) => {
          const value = cellValue(raw);
          if (!value) return "";
          const ref = `${columnName(c)}${r + 1}`;
          const style = r === 0 ? ' s="1"' : "";
          return value.kind === "number" ? `<c r="${ref}"${style}><v>${value.value}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value.value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const frozen = sheet.rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "";
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${frozen}</sheetView></sheetViews><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

const XLSX_STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** An Excel workbook of `sheets`, each one's first row its header (in bold, frozen). */
export function workbook(title: string, sheets: Sheet[], at = new Date()): Uint8Array {
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  return zip(
    [
      [
        "[Content_Types].xml",
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
      ],
      ["docProps/core.xml", coreProps(title, at)],
      [
        "xl/workbook.xml",
        `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
          .map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("")}</sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join("")}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ],
      ["xl/styles.xml", XLSX_STYLES],
      ...sheets.map((sheet, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet)]),
    ],
    at,
  );
}
