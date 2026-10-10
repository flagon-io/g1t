/**
 * The skill format (docs.g1t.sh/guides/agent-skills/, "The skill format"):
 * a skill is a folder holding `SKILL.md`, whose YAML front-matter names it
 * and says when to use it, followed by the instructions, plus optional
 * files: `scripts/`, `resources/` (or `references/` and `assets/`, as other
 * tools write them). It is the open `SKILL.md` format, so a skill written
 * elsewhere imports as it is.
 *
 * g1t reads two extra front-matter keys:
 *
 * - `tools:` the agent tools the skill uses (a list, or names separated by
 *   commas). Only tools agents have are accepted, and naming one never
 *   gives it to an agent: an agent without it is told that part doesn't
 *   work where it is.
 * - `requires_computer:` true when the skill needs the agent's own
 *   computer. A skill with files in `scripts/` needs one whatever it says.
 *
 * Other keys (`license`, `metadata`, `allowed-tools`, ...) are kept as they
 * are and change nothing.
 *
 * Pure and standalone (no value imports), so services and the site share it
 * and Node runs its tests on the file as it is.
 */
import type { AgentSkill } from "./skills";

/** The most one skill's folder holds, every file together: 1 MB. */
export const SKILL_FOLDER_MAX_BYTES = 1024 * 1024;
/** The most skills from the library one agent has, however they are attached. */
export const SKILLS_PER_AGENT_MAX = 100;
/** The most files in one skill's folder, `SKILL.md` included. */
export const SKILL_FILES_MAX = 200;
/** The longest name: lowercase letters, digits and hyphens. */
export const SKILL_NAME_MAX = 64;
/** The longest description ("when to use it"). */
export const SKILL_DESCRIPTION_MAX = 1024;
/** Where a repository keeps the skills it mirrors: `.g1t/skills/<name>/SKILL.md`. */
export const SKILLS_REPO_DIR = ".g1t/skills";

/**
 * Names the library can't use: g1t's foundational skills', so `use_skill`
 * always means one thing. The same list as `FOUNDATIONAL_SKILL_IDS`
 * (a test keeps them equal).
 */
export const RESERVED_SKILL_NAMES: readonly string[] = ["documents", "research", "data", "code", "communication", "files"];

/** The tools a skill may name in `tools:`, grouped as the editor shows them. The agents service's tool box has exactly these (a test there checks). */
export const AGENT_TOOL_GROUPS: { group: string; tools: string[] }[] = [
  { group: "Code", tools: ["list_repositories", "search_code", "read_file", "list_issues", "get_issue", "get_pull", "recent_activity", "draft_issue", "comment", "review_pull"] },
  { group: "Artifacts and files", tools: ["search_artifacts", "read_artifact", "list_spaces", "stale_artifacts", "create_artifact", "edit_artifact", "share_artifact", "make_file"] },
  { group: "Chat", tools: ["search_messages", "read_thread", "workspace_roster"] },
  { group: "Teamwork", tools: ["ask_colleague", "hand_off", "start_session", "post_update", "use_subagent", "bring_in", "use_skill"] },
  { group: "Memory", tools: ["remember", "forget"] },
  { group: "Outside g1t", tools: ["lookup_outside", "import_outside", "act_outside", "request_ability"] },
];

/** Every tool a skill may name. */
export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOL_GROUPS.flatMap((group) => group.tools);

/** One file in a skill's folder: text as it is, anything else as standard base64. */
export type SkillFile = { path: string; content: string; encoding?: "utf8" | "base64" };

/** A skill folder that passed every check. */
export type CheckedSkill = {
  name: string;
  /** When to use it, from the front-matter. */
  description: string;
  tools: string[];
  /** Said in the front-matter, or it has scripts. */
  requires_computer: boolean;
  /** The instructions: SKILL.md after its front-matter. */
  body: string;
  /** SKILL.md as written. */
  skill_md: string;
  /** Every other file, by path. */
  files: SkillFile[];
  /** The files under `scripts/`. */
  scripts: string[];
  /** Every file's bytes together. */
  bytes: number;
  /** Front-matter keys g1t doesn't read, kept as they are. */
  extra: Record<string, unknown>;
};

export type SkillCheck = { ok: true; skill: CheckedSkill } | { ok: false; message: string };

// ── Front-matter ─────────────────────────────────────────────────────────

/** SKILL.md split into its front-matter's text and the body after it. */
export function splitFrontMatter(text: string): { ok: true; yaml: string; body: string } | { ok: false; message: string } {
  const normal = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normal.startsWith("---\n")) return { ok: false, message: "SKILL.md starts with front-matter: a line of ---, then name: and description:, then another line of ---." };
  const end = normal.indexOf("\n---", 3);
  if (end < 0) return { ok: false, message: "SKILL.md's front-matter has no closing line of ---." };
  const after = normal.slice(end + 4);
  if (after && !after.startsWith("\n") && !/^-*\s*(\n|$)/.test(after)) return { ok: false, message: "SKILL.md's front-matter has no closing line of ---." };
  return { ok: true, yaml: normal.slice(4, end + 1), body: after.replace(/^-*[ \t]*\n?/, "") };
}

type Line = { indent: number; text: string; no: number };

function unquote(raw: string, no: number): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const end = closingQuote(value, '"');
      if (end < 0) throw new Error();
      return JSON.parse(value.slice(0, end + 1).replace(/\\'/g, "'"));
    } catch {
      throw new Error(`line ${no}: a double-quoted value isn't closed`);
    }
  }
  if (value.startsWith("'")) {
    const end = closingQuote(value, "'");
    if (end < 0) throw new Error(`line ${no}: a single-quoted value isn't closed`);
    return value.slice(1, end).replace(/''/g, "'");
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`line ${no}: a list in [ ] isn't closed`);
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((item) => unquote(item, no));
  }
  const plain = value.replace(/\s+#.*$/, "");
  if (plain === "" || plain === "~" || plain === "null") return null;
  if (plain === "true" || plain === "True") return true;
  if (plain === "false" || plain === "False") return false;
  if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

/** Where a quoted value starting at 0 closes, or -1. */
function closingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (quote === '"' && value[i] === "\\") {
      i++;
      continue;
    }
    if (value[i] === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** `a, "b, c", d` into its items. */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"') current += inner[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ",") {
      items.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** A block scalar (`|` or `>`) from the lines under its key. */
function blockScalar(style: string, lines: Line[]): string {
  if (!lines.length) return "";
  const base = Math.min(...lines.filter((l) => l.text.trim()).map((l) => l.indent));
  const texts = lines.map((l) => (l.text.trim() ? " ".repeat(Math.max(0, l.indent - base)) + l.text.trimEnd() : ""));
  let out: string;
  if (style.startsWith("|")) out = texts.join("\n");
  else {
    out = "";
    for (const t of texts) {
      if (!t) out += "\n";
      else out += out && !out.endsWith("\n") ? ` ${t}` : t;
    }
  }
  if (style.includes("-")) return out.replace(/\n+$/, "");
  return `${out.replace(/\n+$/, "")}\n`;
}

/**
 * The front-matter as values: the YAML that SKILL.md files use, which is
 * keys with plain, quoted or block (`|`, `>`) strings, booleans, numbers,
 * lists (`[a, b]` or `- a` lines) and one level of nested keys
 * (`metadata:`). Throws with the line that can't be read.
 */
export function parseFrontMatter(yaml: string): Record<string, unknown> {
  const lines: Line[] = yaml.split("\n").map((raw, i) => ({ indent: raw.length - raw.trimStart().length, text: raw.trimStart(), no: i + 2 }));
  return readMap(lines, 0, lines.length, 0);
}

function readMap(lines: Line[], from: number, to: number, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = from;
  while (i < to) {
    const line = lines[i]!;
    if (!line.text || line.text.startsWith("#")) {
      i++;
      continue;
    }
    if (line.indent !== indent) throw new Error(`line ${line.no}: unexpected indentation`);
    const match = line.text.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.\-]+)\s*:(?:\s+(.*)|\s*)$/);
    if (!match) throw new Error(`line ${line.no}: expected "key: value"`);
    const key = match[1]!.replace(/^["']|["']$/g, "");
    const rest = (match[2] ?? "").trim();
    // The lines that belong to this key: more indented than it, or blank.
    let j = i + 1;
    while (j < to && (!lines[j]!.text || lines[j]!.indent > indent || (lines[j]!.indent === indent && lines[j]!.text.startsWith("- ") && !rest))) j++;
    // Trailing blank lines belong to the next key.
    let end = j;
    while (end > i + 1 && !lines[end - 1]!.text) end--;
    const child = lines.slice(i + 1, end);
    if (key in out) throw new Error(`line ${line.no}: ${key} is given twice`);
    if (/^[|>][+-]?$/.test(rest)) out[key] = blockScalar(rest, child);
    else if (rest && !rest.startsWith("#")) {
      const value = unquote(rest, line.no);
      const more = child.filter((l) => l.text && !l.text.startsWith("#"));
      // A plain value folded over more lines.
      if (more.length && typeof value === "string" && !/^["'[]/.test(rest)) out[key] = [value, ...more.map((l) => l.text.trim())].join(" ");
      else if (more.length) throw new Error(`line ${more[0]!.no}: unexpected indentation`);
      else out[key] = value;
    } else {
      const content = child.filter((l) => l.text && !l.text.startsWith("#"));
      if (!content.length) out[key] = null;
      else if (content[0]!.text.startsWith("- ") || content[0]!.text === "-") {
        out[key] = content.map((l) => {
          if (!l.text.startsWith("-")) throw new Error(`line ${l.no}: expected "- item"`);
          return unquote(l.text.slice(1), l.no);
        });
      } else {
        const start = lines.indexOf(content[0]!);
        out[key] = readMap(lines, start, end, content[0]!.indent);
      }
    }
    i = j;
  }
  return out;
}

/** A value as YAML on one line: plain when that reads the same, else double-quoted. */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_][A-Za-z0-9_ ,.;()/'’&+-]*$/.test(text) && !/^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/i.test(text) && !/\s$/.test(text)) return text;
  return JSON.stringify(text);
}

function yamlValue(value: unknown, indent: string): string {
  if (Array.isArray(value)) return value.length ? `[${value.map(yamlScalar).join(", ")}]` : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `\n${entries.map(([k, v]) => `${indent}  ${k}:${keyed(v, `${indent}  `)}`).join("\n")}`;
  }
  return yamlScalar(value);
}

/** What follows `key:`: a space and the value, or the nested keys on their own lines. */
function keyed(value: unknown, indent: string): string {
  const nested = !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
  return nested ? yamlValue(value, indent) : ` ${yamlValue(value && typeof value === "object" && !Array.isArray(value) ? null : value, indent)}`;
}

/** SKILL.md for a skill written in the editor: front-matter (name, description, then g1t's keys and any kept ones), then the instructions. */
export function renderSkillMd(input: { name: string; description: string; tools?: string[]; requires_computer?: boolean; body: string; extra?: Record<string, unknown> }): string {
  const lines = ["---", `name: ${input.name}`, `description: ${yamlScalar(input.description.replace(/\s*\n\s*/g, " ").trim())}`];
  if (input.tools?.length) lines.push(`tools: ${yamlValue(input.tools, "")}`);
  if (input.requires_computer) lines.push("requires_computer: true");
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (["name", "description", "tools", "requires_computer"].includes(key)) continue;
    lines.push(`${key}:${keyed(value, "")}`);
  }
  lines.push("---", "", input.body.replace(/\r\n?/g, "\n").trim(), "");
  return lines.join("\n");
}

// ── Checks ───────────────────────────────────────────────────────────────

/** Why `name` can't name a skill, or null. */
export function skillNameProblem(name: string): string | null {
  if (!name) return "A skill needs a name.";
  if (name.length > SKILL_NAME_MAX) return `A skill's name is at most ${SKILL_NAME_MAX} characters.`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "A skill's name is lowercase letters, digits and single hyphens, like release-notes.";
  if (RESERVED_SKILL_NAMES.includes(name)) return `${name} is one of g1t's foundational skills. Choose another name.`;
  return null;
}

/** Whether `path` is a plain relative path inside the folder. */
export function skillPathProblem(path: string): string | null {
  if (!path || path.length > 255) return `${path || "A file"} isn't a path a skill can hold.`;
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) return `${path} isn't a path a skill can hold.`;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return `${path} isn't a path a skill can hold.`;
  return null;
}

/** A file's size in bytes. */
export function skillFileBytes(file: SkillFile): number {
  if (file.encoding === "base64") {
    const clean = file.content.replace(/\s+/g, "");
    return Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  }
  return new TextEncoder().encode(file.content).length;
}

/** "12 KB". */
export function skillSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listOf(value: unknown): string[] | null {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? (value as string[]) : null;
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return null;
}

/**
 * Checks a skill's folder: one `SKILL.md` at its top with a name and a
 * description, tools agents have, plain paths, at most `SKILL_FILES_MAX`
 * files and `SKILL_FOLDER_MAX_BYTES` together. `expectName` is the
 * folder's name when it must match (a repository's `.g1t/skills/<name>/`).
 */
export function checkSkillFolder(input: SkillFile[], options: { expectName?: string | null } = {}): SkillCheck {
  const bad = (message: string): SkillCheck => ({ ok: false, message });
  if (!Array.isArray(input) || !input.length) return bad("A skill is a folder with a SKILL.md in it.");
  if (input.length > SKILL_FILES_MAX) return bad(`A skill holds at most ${SKILL_FILES_MAX} files; this one has ${input.length}.`);
  const seen = new Set<string>();
  let skillMd: SkillFile | null = null;
  const files: SkillFile[] = [];
  let bytes = 0;
  for (const raw of input) {
    if (!raw || typeof raw.path !== "string" || typeof raw.content !== "string") return bad("Each file needs a path and its content.");
    const path = raw.path.replace(/^\.\//, "");
    const problem = skillPathProblem(path);
    if (problem) return bad(problem);
    if (seen.has(path.toLowerCase())) return bad(`${path} is in the folder twice.`);
    seen.add(path.toLowerCase());
    const file: SkillFile = { path, content: raw.content, encoding: raw.encoding === "base64" ? "base64" : "utf8" };
    if (file.encoding === "base64" && !/^[A-Za-z0-9+/\s]*=*\s*$/.test(file.content)) return bad(`${path} isn't valid base64.`);
    bytes += skillFileBytes(file);
    if (path.toLowerCase() === "skill.md") {
      if (file.encoding === "base64") return bad("SKILL.md is text.");
      skillMd = { ...file, path: "SKILL.md" };
    } else files.push(file);
  }
  if (bytes > SKILL_FOLDER_MAX_BYTES) return bad(`A skill's folder is at most 1 MB; this one is ${skillSize(bytes)}.`);
  if (!skillMd) {
    const nested = files.find((f) => f.path.toLowerCase().endsWith("/skill.md"));
    return bad(nested ? `SKILL.md belongs at the top of the folder, not in ${nested.path.slice(0, nested.path.lastIndexOf("/"))}.` : "A skill's folder needs a SKILL.md at its top.");
  }
  const split = splitFrontMatter(skillMd.content);
  if (!split.ok) return bad(split.message);
  let front: Record<string, unknown>;
  try {
    front = parseFrontMatter(split.yaml);
  } catch (error) {
    return bad(`SKILL.md's front-matter can't be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const name = typeof front.name === "string" ? front.name.trim() : "";
  const nameProblem = skillNameProblem(name);
  if (nameProblem) return bad(name ? nameProblem : "SKILL.md's front-matter needs a name: the skill's name, like release-notes.");
  if (options.expectName && options.expectName !== name) return bad(`The folder is ${options.expectName}, but its SKILL.md is named ${name}. They must match.`);
  const description = typeof front.description === "string" ? front.description.replace(/\s+/g, " ").trim() : "";
  if (!description) return bad("SKILL.md's front-matter needs a description: when an agent should use the skill.");
  if (description.length > SKILL_DESCRIPTION_MAX) return bad(`A skill's description is at most ${SKILL_DESCRIPTION_MAX} characters.`);
  const listed = listOf(front.tools);
  if (!listed) return bad("tools: is a list of tool names, like [read_file, make_file].");
  const tools = [...new Set(listed.map((t) => t.trim()))].filter(Boolean);
  const unknown = tools.filter((tool) => !AGENT_TOOL_NAMES.includes(tool));
  if (unknown.length) return bad(`tools: names ${unknown.join(", ")}, which ${unknown.length === 1 ? "isn't a tool" : "aren't tools"} agents have. Agents' tools are listed in the skills guide.`);
  const flag = front.requires_computer;
  if (flag !== undefined && flag !== null && typeof flag !== "boolean") return bad("requires_computer: is true or false.");
  const body = split.body.trim();
  if (!body) return bad("SKILL.md needs instructions under its front-matter.");
  const scripts = files.filter((f) => f.path.startsWith("scripts/")).map((f) => f.path);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(front)) if (!["name", "description", "tools", "requires_computer"].includes(key)) extra[key] = value;
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    skill: { name, description, tools, requires_computer: flag === true || scripts.length > 0, body, skill_md: skillMd.content, files, scripts, bytes, extra },
  };
}

// ── g1t's foundational skills, as SKILL.md ───────────────────────────────

/**
 * A foundational skill written out in the same format: its name, when to
 * use it, the tools its working parts use, then its playbook and, part by
 * part, what works today and what is coming.
 */
export function foundationalSkillMd(skill: AgentSkill): string {
  const ready = skill.abilities.filter((a) => a.status === "ready");
  const coming = skill.abilities.filter((a) => a.status === "coming");
  const tools = [...new Set(ready.flatMap((a) => a.tools))];
  const body = [
    `# ${skill.name}`,
    "",
    skill.instructions,
    "",
    "## What works today",
    "",
    ...ready.map((a) => `- **${a.label}**${a.tools.length ? ` (${a.tools.map((t) => `\`${t}\``).join(", ")})` : ""}: ${a.note}`),
    ...(coming.length ? ["", "## Not yet in g1t", "", ...coming.map((a) => `- **${a.label}**: ${a.note}`)] : []),
  ].join("\n");
  return renderSkillMd({ name: skill.id, description: skill.when, tools, body, extra: { metadata: { source: "g1t", version: skill.version } } });
}
