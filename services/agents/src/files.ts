/**
 * The files `make_file` makes (docs.g1t.sh/guides/agent-skills/): a PDF or
 * a Word document from Markdown, a spreadsheet or CSV from rows, or the
 * Markdown itself. Checked and written here, pure; tools.ts keeps the file
 * with an artifact. Nothing runs: each is written byte by byte.
 */
import { DOC_MAX_FILE_BYTES } from "../../../packages/contracts/src/docs.ts";
import { type MakeFileFormat, MAKE_FILE_FORMATS } from "../../../packages/contracts/src/skills.ts";

import { type Cell, type Sheet, workbook, markdownDocx } from "./ooxml.ts";
import { markdownPdf } from "./pdf.ts";

/** The longest Markdown a file is made from. */
export const MAX_FILE_MARKDOWN = 200_000;
export const MAX_SHEETS = 10;
export const MAX_SHEET_ROWS = 5_000;
export const MAX_SHEET_COLUMNS = 50;
export const MAX_CELL_CHARS = 2_000;

export const CONTENT_TYPES: Record<MakeFileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
};

const LABELS: Record<MakeFileFormat, string> = { pdf: "PDF", docx: "Word document", xlsx: "spreadsheet", csv: "CSV file", md: "Markdown file" };

export type MadeFile = { name: string; content_type: string; bytes: Uint8Array; format: MakeFileFormat; summary: string };

/** A file name from a title: `Q3 report` becomes `Q3 report.pdf`. */
export function fileName(title: string, format: MakeFileFormat): string {
  const base =
    String(title ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.(pdf|docx|xlsx|csv|md)$/i, "")
      .slice(0, 120) || "file";
  return `${base}.${format}`;
}

/** Sheets from the model's input: a list of { name, rows }, rows of cells. */
export function readSheets(input: unknown): { ok: true; sheets: Sheet[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || !input.length) return { ok: false, message: "Give sheets: a list of { name, rows }, the first row each sheet's header." };
  if (input.length > MAX_SHEETS) return { ok: false, message: `A spreadsheet has at most ${MAX_SHEETS} sheets.` };
  const sheets: Sheet[] = [];
  for (const [i, raw] of input.entries()) {
    const given = raw && typeof raw === "object" ? (raw as { name?: unknown; rows?: unknown }) : {};
    if (!Array.isArray(given.rows) || !given.rows.length) return { ok: false, message: `Sheet ${i + 1} has no rows.` };
    if (given.rows.length > MAX_SHEET_ROWS) return { ok: false, message: `A sheet has at most ${MAX_SHEET_ROWS} rows.` };
    const rows: Cell[][] = [];
    for (const row of given.rows) {
      const cells = Array.isArray(row) ? row : [row];
      if (cells.length > MAX_SHEET_COLUMNS) return { ok: false, message: `A sheet has at most ${MAX_SHEET_COLUMNS} columns.` };
      rows.push(
        cells.map((cell): Cell => {
          if (cell === null || cell === undefined) return null;
          if (typeof cell === "number" || typeof cell === "boolean") return cell;
          return String(typeof cell === "object" ? JSON.stringify(cell) : cell).slice(0, MAX_CELL_CHARS);
        }),
      );
    }
    sheets.push({ name: typeof given.name === "string" ? given.name : `Sheet${i + 1}`, rows });
  }
  return { ok: true, sheets };
}

/** One sheet as CSV (RFC 4180), with a byte-order mark so spreadsheet apps read it as UTF-8. */
export function csv(rows: Cell[][]): string {
  const field = (cell: Cell) => {
    const text = cell === null || cell === undefined ? "" : String(cell);
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${rows.map((row) => row.map(field).join(",")).join("\r\n")}\r\n`;
}

/** Up to `limit` rows of a sheet as a Markdown table, for the doc a file is attached to. */
export function previewTable(sheet: Sheet, limit = 20): string {
  const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
  const cell = (value: Cell) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 80);
  const [header = [], ...body] = sheet.rows;
  const line = (row: Cell[]) => `| ${Array.from({ length: columns }, (_, c) => cell(row[c] ?? null)).join(" | ")} |`;
  const shown = body.slice(0, limit);
  return [line(header), `|${" --- |".repeat(columns)}`, ...shown.map(line), ...(body.length > shown.length ? ["", `_First ${shown.length} of ${body.length} rows._`] : [])].join("\n");
}

/**
 * The file for one `make_file` call, or why not. `content` is Markdown
 * (pdf, docx, md); `sheets` are rows (xlsx, csv).
 */
export function makeFile(input: { format: unknown; title: string; content?: unknown; sheets?: unknown }, at = new Date()): { ok: true; file: MadeFile } | { ok: false; message: string } {
  const format = String(input.format ?? "").toLowerCase().replace(/^\./, "") as MakeFileFormat;
  if (!MAKE_FILE_FORMATS.includes(format)) {
    return { ok: false, message: `make_file writes ${MAKE_FILE_FORMATS.join(", ")}. Slide decks and images aren't available yet: say so, and offer a PDF or a doc instead.` };
  }
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) return { ok: false, message: "Give the file a title." };
  const name = fileName(title, format);
  let bytes: Uint8Array;
  let summary: string;
  if (format === "pdf" || format === "docx" || format === "md") {
    const markdown = typeof input.content === "string" ? input.content : "";
    if (!markdown.trim()) return { ok: false, message: `Give the ${LABELS[format]}'s content as Markdown in content.` };
    if (markdown.length > MAX_FILE_MARKDOWN) return { ok: false, message: `Content is at most ${MAX_FILE_MARKDOWN.toLocaleString("en-US")} characters: split it into more than one file.` };
    if (format === "pdf") {
      const pdf = markdownPdf(title, markdown);
      bytes = pdf.bytes;
      summary = `${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}${pdf.truncated ? ", cut at the page limit" : ""}`;
    } else if (format === "docx") {
      bytes = markdownDocx(title, markdown, at);
      summary = "Word document";
    } else {
      bytes = new TextEncoder().encode(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      summary = "Markdown";
    }
  } else {
    const read = readSheets(input.sheets);
    if (!read.ok) return read;
    if (format === "csv") {
      if (read.sheets.length > 1) return { ok: false, message: "A CSV holds one sheet: make an xlsx for more, or one CSV per sheet." };
      bytes = new TextEncoder().encode(csv(read.sheets[0]!.rows));
    } else bytes = workbook(title, read.sheets, at);
    const rows = read.sheets.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    summary = `${read.sheets.length === 1 ? "" : `${read.sheets.length} sheets, `}${rows} ${rows === 1 ? "row" : "rows"}`;
  }
  if (bytes.length > DOC_MAX_FILE_BYTES) return { ok: false, message: `That comes to more than ${DOC_MAX_FILE_BYTES / 1024 / 1024} MB: make it smaller, or split it.` };
  return { ok: true, file: { name, content_type: CONTENT_TYPES[format], bytes, format, summary } };
}

/** "34 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Bytes as base64, in chunks so a large file never overflows the call stack. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
