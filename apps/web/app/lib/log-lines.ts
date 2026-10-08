/**
 * A job's log as GitHub shows one: lines, folded `##[group]`s, errors and
 * warnings marked; searching it; and the files of a run's log archive.
 */

import type { JobLogText } from "@g1t/contracts";

export type LineKind = "text" | "error" | "warning" | "notice" | "debug" | "command";
export type Line = { kind: LineKind; text: string };
export type Block =
  | { kind: "line"; line: Line; number: number }
  | { kind: "group"; title: string; lines: { line: Line; number: number }[] };

export function classify(raw: string): Line | "group-end" | { group: string } {
  if (raw.startsWith("##[group]")) return { group: raw.slice(9) };
  if (raw.startsWith("##[endgroup]")) return "group-end";
  for (const kind of ["error", "warning", "notice", "debug"] as const) {
    if (raw.startsWith(`##[${kind}]`)) return { kind, text: raw.slice(kind.length + 4) };
  }
  if (raw.startsWith("[command]")) return { kind: "command", text: raw.slice(9) };
  return { kind: "text", text: raw };
}

/** Lines into blocks: plain lines, and groups that fold. Lines are numbered from 1, group markers aside. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let group: Extract<Block, { kind: "group" }> | null = null;
  let number = 0;
  for (const raw of text.split("\n")) {
    if (raw === "" && number === 0) continue;
    const line = classify(raw);
    if (line === "group-end") {
      group = null;
      continue;
    }
    if ("group" in line) {
      group = { kind: "group", title: line.group, lines: [] };
      out.push(group);
      continue;
    }
    number += 1;
    if (group) group.lines.push({ line, number });
    else out.push({ kind: "line", line, number });
  }
  return out;
}

/** The lines of a log holding `query` (any case), numbered as `blocks` numbers them, folded groups opened. */
export function searchLog(text: string, query: string): { line: Line; number: number }[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const found: { line: Line; number: number }[] = [];
  for (const block of blocks(text)) {
    const lines = block.kind === "line" ? [{ line: block.line, number: block.number }] : block.lines;
    for (const entry of lines) {
      if (entry.line.text.toLowerCase().includes(wanted)) found.push(entry);
    }
  }
  return found;
}

/** `text` cut where `query` (any case) appears, each piece marked as a match or not. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let at = 0;
  for (let found = lower.indexOf(wanted); found !== -1; found = lower.indexOf(wanted, at)) {
    if (found > at) out.push({ text: text.slice(at, found), match: false });
    out.push({ text: text.slice(found, found + wanted.length), match: true });
    at = found + wanted.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

/** A name safe as a file name in an archive, as the API's archive names them. */
export function fileName(name: string): string {
  const cleaned = Array.from(name)
    .map((c) => (/[/\\:*?"<>|]/.test(c) || c.charCodeAt(0) < 32 ? "_" : c))
    .slice(0, 100)
    .join("")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned || "job";
}

/** A job's whole log as one text. */
export function jobText(job: JobLogText): string {
  if (job.omitted) return "This job's log was left out: the run's logs are larger than one download holds. Download it on its own.\n";
  return job.chunks.map((chunk) => chunk.text).join("");
}

/**
 * The files of a run's log archive: `{n}_{job}.txt` with each job's whole
 * log, and `{job}/{step}_{step name}.txt` for each of its steps.
 */
export function archiveFiles(jobs: JobLogText[]): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  jobs.forEach((job, index) => {
    const name = fileName(job.name);
    files.push({ path: `${index + 1}_${name}.txt`, text: jobText(job) });
    if (job.omitted) return;
    const steps = [...new Set(job.chunks.map((chunk) => chunk.step))].sort((a, b) => a - b);
    for (const step of steps) {
      const title = step === 0 ? "Set up job" : (job.steps.find((s) => s.number === step)?.name ?? `Step ${step}`);
      const text = job.chunks
        .filter((chunk) => chunk.step === step)
        .map((chunk) => chunk.text)
        .join("");
      files.push({ path: `${name}/${step}_${fileName(title)}.txt`, text });
    }
  });
  return files;
}
