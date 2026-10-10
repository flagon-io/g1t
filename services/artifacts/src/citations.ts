/**
 * Code a page cites, and whether a change touched it. Pure.
 *
 * A citation names a repository (`owner/name`) and a path in it: a file
 * (`src/export.ts`), a folder (`src/export`, everything under it) or a
 * glob (`src/**\/*.sql`, `*` within a folder, `**` across folders, `?` one
 * character). Its kind says what at that path the page describes: the
 * path itself, a symbol, an endpoint or an environment variable, named by
 * its label. A page's citations come from its text (the editor's citation
 * chips, and links to files in a repository) and from its header.
 */
import type { DocCitation, DocCitationKind, DocDescribes } from "@g1t/contracts";

import { projectRef } from "./search.ts";

const KINDS = new Set<DocCitationKind>(["path", "symbol", "endpoint", "env"]);
const MAX_PATH = 400;
const MAX_LABEL = 200;
/** Citations a page keeps from its text, and in its header. */
export const MAX_CITATIONS = 100;
export const MAX_DESCRIBES = 20;

/** A path as kept: no leading or trailing slash, no `.`/`..` parts, no doubled slashes; null when empty or unsafe. */
export function cleanPath(path: unknown): string | null {
  const parts = String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || /[\u0000-\u001f]/.test(p))) return null;
  const out = parts.join("/");
  return out.length <= MAX_PATH ? out : null;
}

function isGlob(path: string): boolean {
  return /[*?]/.test(path);
}

/** A citation as stored, or null when it names no repository or path. */
export function cleanCitation(raw: Partial<DocCitation> | null | undefined, source: DocCitation["source"]): DocCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const repo = projectRef(String(raw.repo ?? ""));
  const path = cleanPath(raw.path);
  if (!repo || !path) return null;
  const kind = KINDS.has(raw.kind as DocCitationKind) ? (raw.kind as DocCitationKind) : "path";
  const label = kind === "path" ? null : String(raw.label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) || null;
  const ref = /^[0-9a-f]{7,64}$/i.test(String(raw.ref ?? "")) ? String(raw.ref).toLowerCase() : /^[A-Za-z0-9._/-]{1,100}$/.test(String(raw.ref ?? "")) ? String(raw.ref) : null;
  return { repo, path, kind, label, ref, source };
}

/** The header's "Describes" list as stored: valid entries, once each, at most MAX_DESCRIBES. */
export function cleanDescribes(list: unknown): DocDescribes[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: DocDescribes[] = [];
  for (const item of list) {
    const c = cleanCitation({ ...(item as object), kind: "path" }, "header");
    if (!c || seen.has(`${c.repo}\n${c.path}`)) continue;
    seen.add(`${c.repo}\n${c.path}`);
    out.push({ repo: c.repo, path: c.path });
    if (out.length >= MAX_DESCRIBES) break;
  }
  return out;
}

/** The folder a glob starts from: its parts before the first with a wildcard. */
export function globRoot(path: string): string {
  const parts = path.split("/");
  const i = parts.findIndex((p) => isGlob(p));
  return (i < 0 ? parts : parts.slice(0, i)).join("/");
}

/**
 * Where a citation links: the file (or folder) in Code at the commit it
 * was cited at, or the default branch (`HEAD`) when none is known. A
 * glob links to the folder it starts from.
 */
export function citationHref(c: Pick<DocCitation, "repo" | "path" | "ref">): string {
  const ref = encodeURIComponent(c.ref || "HEAD");
  const glob = isGlob(c.path);
  const path = (glob ? globRoot(c.path) : c.path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const kind = glob || !/\.[A-Za-z0-9]{1,10}$/.test(c.path) ? "tree" : "blob";
  return `/${c.repo}/${kind}/${ref}${path ? `/${path}` : ""}`;
}

/** A citation's text in a page's Markdown: a link to the code. */
export function citationMarkdown(c: Pick<DocCitation, "repo" | "path" | "ref" | "kind" | "label">): string {
  const shown = c.kind !== "path" && c.label ? c.label : c.path;
  const ticks = shown.includes("`") ? "``" : "`";
  return `[${ticks}${shown}${ticks}](${citationHref(c)})`;
}

/**
 * Links in Markdown to files and folders in a repository on this site:
 * `/<owner>/<repo>/blob|tree/<ref>/<path>`, absolute or on this origin.
 * The ref is one segment (a commit or a branch without a slash).
 */
export function citationsFromMarkdown(markdown: string): DocCitation[] {
  const out: DocCitation[] = [];
  const seen = new Set<string>();
  const link = /\]\(\s*<?((?:https?:\/\/[^/\s)]+)?\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)\/(?:blob|tree)\/([^/\s)#?]+)\/([^\s)#?>]+))[^)]*\)/g;
  for (const m of String(markdown ?? "").matchAll(link)) {
    if (m[1]!.startsWith("http") && !/^https?:\/\/([a-z0-9-]+\.)*g1t\.(sh|dev)(:\d+)?\//i.test(m[1]!)) continue;
    let path: string;
    let ref: string;
    try {
      path = m[5]!
        .split("/")
        .map((p) => decodeURIComponent(p))
        .join("/");
      ref = decodeURIComponent(m[4]!);
    } catch {
      continue;
    }
    const c = cleanCitation({ repo: `${m[2]}/${m[3]}`, path, ref: ref === "HEAD" ? null : ref, kind: "path" }, "body");
    if (!c || seen.has(`${c.repo}\n${c.path}`)) continue;
    seen.add(`${c.repo}\n${c.path}`);
    out.push(c);
  }
  return out;
}

/**
 * A page's citations from its text: the citation chips (`nodes`), then
 * links to code not already a chip's own. At most MAX_CITATIONS.
 */
export function bodyCitations(nodes: Partial<DocCitation>[], markdown: string): DocCitation[] {
  const out: DocCitation[] = [];
  const seen = new Set<string>();
  const key = (c: DocCitation) => `${c.repo}\n${c.path}\n${c.kind}\n${c.label ?? ""}`;
  const chips = new Set<string>();
  for (const n of nodes) {
    const c = cleanCitation(n, "body");
    if (!c || seen.has(key(c))) continue;
    seen.add(key(c));
    chips.add(citationHref(c));
    out.push(c);
  }
  for (const c of citationsFromMarkdown(markdown)) {
    // A chip's own link is the chip.
    if (chips.has(citationHref(c)) || out.some((o) => o.repo === c.repo && o.path === c.path)) continue;
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    out.push(c);
  }
  return out.slice(0, MAX_CITATIONS);
}

/** A glob as a regular expression over a whole path. */
function globExpression(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` is any folders, or none; a trailing `**` anything below.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a change to `changed` touches what `cited` names: the same file,
 * anything under a cited folder, or a path a glob matches.
 */
export function touches(cited: string, changed: string): boolean {
  if (isGlob(cited)) return globExpression(cited).test(changed);
  return changed === cited || changed.startsWith(`${cited}/`);
}

/** Of `changed` paths, those any of the citations names; at most `max`. */
export function touchedPaths(citations: Pick<DocCitation, "path">[], changed: string[], max = 20): string[] {
  const out: string[] = [];
  for (const path of changed) {
    if (citations.some((c) => touches(c.path, path))) out.push(path);
    if (out.length >= max) break;
  }
  return out;
}
