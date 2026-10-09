/**
 * What a project's files say about it, read without running anything: the
 * languages and packages in its manifests, the APIs it exposes, its docs,
 * whether its workflows run tests, who owns it, and short facts and
 * conventions worth remembering. Pure: given a file's path and text, the
 * same facts every time, so a file whose blob has not changed is never read
 * again.
 */

import { parse as parseYaml } from "yaml";

import { aspirational, bulletsOf, classify, bulletSection, MAX_DOC_HINT_CHARS, planLike, planSection, plain, SETUP_HEADING, wholeSentences, type MemoryDocsConfig } from "./harvest.ts";

export type Ecosystem = "npm" | "cargo" | "go" | "pypi";

export type PackageFact = {
  ecosystem: Ecosystem;
  name: string;
  version: string | null;
  /** Its dependencies' names, at most `MAX_DEPENDENCIES`. */
  dependencies: string[];
  /** For npm: the scripts people run. */
  scripts?: Record<string, string>;
  /** For a monorepo's root: where its packages are. */
  members?: string[];
};

export type ApiFact = {
  /** `openapi` for a described HTTP API, `worker` for a Worker's routes. */
  kind: "openapi" | "worker";
  name: string;
  summary: string | null;
  /** `GET /users`, or a route pattern such as `api.example.com/*`. */
  routes: string[];
};

export type DocFact = {
  path: string;
  title: string;
  summary: string | null;
  /** The doc in pieces of at most `CHUNK_CHARS`, each starting with its heading. */
  chunks: string[];
  /** README, AGENTS.md (or CLAUDE.md), CONTRIBUTING, or another doc. */
  role: "readme" | "agents" | "contributing" | "doc";
};

/** Something worth remembering, as a memory candidate. */
export type Hint = {
  kind: "fact" | "convention" | "decision" | "gotcha";
  text: string;
  /** 0 to 1. A doc's hint at or above 0.85 is kept without review. */
  confidence: number;
  evidence: string;
};

export type FileFacts = {
  languages: string[];
  packages: PackageFact[];
  apis: ApiFact[];
  doc: DocFact | null;
  /** A workflow that runs tests. */
  tests: boolean;
  /** Usernames this file names as owners. */
  owners: string[];
  hints: Hint[];
  /** For `.g1t/project.yml`: which docs memory is suggested from. */
  memory?: MemoryDocsConfig | null;
  /** The `EXTRACT_VERSION` that read it; facts from an older one are read again. */
  version?: number;
};

/** What extraction knows besides the file itself. */
export type ExtractContext = {
  /** The project's name, for writing hints. */
  project: string;
  /** The names of the files beside the manifest: lockfiles, tsconfig.json. */
  siblings: string[];
};

/** Bumped when what is read from a file changes, so stored facts are read again. */
export const EXTRACT_VERSION = 2;
export const MAX_DEPENDENCIES = 60;
export const CHUNK_CHARS = 1500;
export const MAX_CHUNKS = 12;
const MAX_ROUTES = 40;
const MAX_HINTS_PER_FILE = 12;
const MAX_HINT_CHARS = MAX_DOC_HINT_CHARS;

const EMPTY: FileFacts = { languages: [], packages: [], apis: [], doc: null, tests: false, owners: [], hints: [] };

const DOC_NAME = /^(readme|agents|claude|contributing)(\.(md|markdown|txt))?$/i;
const OPENAPI_NAME = /^(openapi|swagger)\.(json|ya?ml)$/i;
const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
  "CODEOWNERS",
]);

/** The base name of a path. */
function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Whether a file at `path` (relative to the project's root) is one this
 * reads: a manifest, an API description, a doc, a workflow or ownership.
 */
export function interesting(path: string): boolean {
  const name = base(path);
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (dir === "" && (MANIFEST_NAMES.has(name) || DOC_NAME.test(name) || OPENAPI_NAME.test(name))) return true;
  if ((dir === "docs" || dir === "doc" || dir === "runbooks" || dir === "docs/runbooks") && /\.(md|markdown)$/i.test(name)) return true;
  if ((dir === ".g1t/workflows" || dir === ".github/workflows") && /\.ya?ml$/i.test(name)) return true;
  if (path === ".g1t/project.yml" || path === ".github/CODEOWNERS" || path === "docs/CODEOWNERS") return true;
  if (dir === "" && OPENAPI_NAME.test(name)) return true;
  return false;
}

/** One line, at most `max` characters. */
export function clip(text: string, max = MAX_HINT_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** JSON with comments and trailing commas, as wrangler.jsonc and tsconfig.json allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

type Toml = Record<string, Record<string, unknown>>;

/**
 * The little of TOML that manifests use: `[sections]`, `key = "string"`,
 * numbers, booleans, one-line and multi-line string arrays, and inline
 * tables kept as text. Keys outside a section are under "".
 */
export function parseToml(text: string): Toml {
  const out: Toml = { "": {} };
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim().replace(/"/g, "");
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/"/g, "");
    let value = line.slice(eq + 1).trim();
    // A multi-line array: gather until its closing bracket.
    if (value.startsWith("[") && !value.includes("]")) {
      while (i + 1 < lines.length && !value.includes("]")) value += " " + lines[++i].replace(/#.*$/, "").trim();
    }
    out[section] ??= {};
    out[section][key] = tomlValue(value);
  }
  return out;
}

function tomlValue(value: string): unknown {
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(1, value.lastIndexOf(value[0]));
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith("[")) {
    return [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function keys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

/** The package manager a JavaScript project's lockfile says it uses. */
export function packageManager(siblings: string[]): "pnpm" | "yarn" | "bun" | "npm" | null {
  const has = (name: string) => siblings.includes(name);
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("package-lock.json")) return "npm";
  return null;
}

function npm(path: string, text: string, ctx: ExtractContext): FileFacts {
  const json = JSON.parse(text) as Record<string, unknown>;
  const scripts = (json.scripts && typeof json.scripts === "object" ? json.scripts : {}) as Record<string, string>;
  const deps = [...keys(json.dependencies), ...keys(json.devDependencies)];
  const typescript = deps.includes("typescript") || ctx.siblings.includes("tsconfig.json");
  const workspaces = Array.isArray(json.workspaces)
    ? (json.workspaces as unknown[]).filter((w): w is string => typeof w === "string")
    : Array.isArray((json.workspaces as { packages?: unknown })?.packages)
      ? ((json.workspaces as { packages: unknown[] }).packages.filter((w): w is string => typeof w === "string"))
      : [];
  const pm = packageManager(ctx.siblings);
  const run = (script: string) => (script === "test" ? `${pm ?? "npm"} test` : `${pm ?? "npm"} run ${script}`);
  const hints: Hint[] = [];
  if (pm) {
    const others = ["npm", "pnpm", "yarn", "bun"].filter((other) => other !== pm).join(" or ");
    hints.push({
      kind: "convention",
      text: `${ctx.project} uses ${pm} (its lockfile is committed): install with \`${pm} install\`, not ${others}.`,
      confidence: 0.9,
      evidence: `${path} beside its ${pm} lockfile`,
    });
  }
  for (const script of ["test", "typecheck", "lint", "build"]) {
    const command = str(scripts[script]);
    if (!command) continue;
    hints.push({
      kind: "fact",
      text: clip(`In ${ctx.project}, \`${run(script)}\` runs ${script === "test" ? "the tests" : `the ${script}`}: \`${command}\`.`),
      confidence: 0.9,
      evidence: `${path} scripts.${script}`,
    });
  }
  if (workspaces.length > 0) {
    hints.push({
      kind: "fact",
      text: clip(`${ctx.project} is a monorepo; its packages are in ${workspaces.join(", ")}.`),
      confidence: 0.9,
      evidence: `${path} workspaces`,
    });
  }
  const name = str(json.name);
  return {
    ...EMPTY,
    languages: typescript ? ["TypeScript"] : ["JavaScript"],
    packages: name
      ? [
          {
            ecosystem: "npm",
            name,
            version: str(json.version),
            dependencies: deps.slice(0, MAX_DEPENDENCIES),
            scripts: Object.fromEntries(Object.entries(scripts).filter(([, v]) => typeof v === "string").slice(0, 20)),
            ...(workspaces.length ? { members: workspaces } : {}),
          },
        ]
      : [],
    hints,
  };
}

function cargo(path: string, text: string, ctx: ExtractContext): FileFacts {
  const toml = parseToml(text);
  const name = str(toml.package?.name);
  const members = Array.isArray(toml.workspace?.members) ? (toml.workspace.members as string[]) : [];
  const deps = [...keys(toml.dependencies), ...keys(toml["dev-dependencies"]), ...keys(toml["workspace.dependencies"])];
  // Where its crates live (apps/*, crates/*), not each one: the list
  // changes with every crate added, and the fact does not.
  const places = [...new Set(members.map((member) => (member.includes("/") ? `${member.slice(0, member.indexOf("/"))}/*` : member)))];
  const hints: Hint[] = [
    {
      kind: "fact",
      text: clip(
        members.length
          ? `${ctx.project} is a Cargo workspace (${places.join(", ")}); \`cargo test\` runs its tests.`
          : `${ctx.project} is written in Rust; \`cargo test\` runs its tests.`,
      ),
      confidence: 0.9,
      evidence: path,
    },
  ];
  return {
    ...EMPTY,
    languages: ["Rust"],
    packages: name
      ? [{ ecosystem: "cargo", name, version: str(toml.package?.version), dependencies: [...new Set(deps)].slice(0, MAX_DEPENDENCIES) }]
      : members.length
        ? [{ ecosystem: "cargo", name: `${ctx.project} (workspace)`, version: null, dependencies: [...new Set(deps)].slice(0, MAX_DEPENDENCIES), members }]
        : [],
    hints,
  };
}

function goMod(path: string, text: string, ctx: ExtractContext): FileFacts {
  const module = /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
  const version = /^go\s+(\S+)/m.exec(text)?.[1] ?? null;
  const requires = [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/\S+)\s+v[\w.+-]+/gm)].map((m) => m[1]);
  return {
    ...EMPTY,
    languages: ["Go"],
    packages: module ? [{ ecosystem: "go", name: module, version, dependencies: requires.slice(0, MAX_DEPENDENCIES) }] : [],
    hints: [
      {
        kind: "fact",
        text: clip(`${ctx.project} is a Go module${module ? ` (${module}${version ? `, go ${version}` : ""})` : ""}; \`go test ./...\` runs its tests.`),
        confidence: 0.9,
        evidence: path,
      },
    ],
  };
}

function python(path: string, text: string, ctx: ExtractContext): FileFacts {
  let name: string | null = null;
  let version: string | null = null;
  let deps: string[] = [];
  if (base(path) === "pyproject.toml") {
    const toml = parseToml(text);
    name = str(toml.project?.name) ?? str(toml["tool.poetry"]?.name);
    version = str(toml.project?.version) ?? str(toml["tool.poetry"]?.version);
    deps = [
      ...(Array.isArray(toml.project?.dependencies) ? (toml.project.dependencies as string[]) : []),
      ...keys(toml["tool.poetry.dependencies"]),
    ];
  } else {
    deps = text.split(/\r?\n/).map((line) => line.replace(/#.*$/, "").trim()).filter((line) => line && !line.startsWith("-"));
  }
  deps = deps.map((dep) => dep.split(/[<>=!~;\[\s]/)[0]).filter(Boolean);
  const hints: Hint[] = deps.includes("pytest")
    ? [{ kind: "fact", text: `In ${ctx.project}, \`pytest\` runs the tests.`, confidence: 0.85, evidence: path }]
    : [];
  return {
    ...EMPTY,
    languages: ["Python"],
    packages: name ? [{ ecosystem: "pypi", name, version, dependencies: deps.slice(0, MAX_DEPENDENCIES) }] : [],
    hints,
  };
}

function wrangler(path: string, text: string): FileFacts {
  let config: Record<string, unknown> = {};
  if (path.endsWith(".toml")) {
    const toml = parseToml(text);
    config = { ...toml[""], routes: Array.isArray(toml[""].routes) ? toml[""].routes : [] };
    if (toml.routes) config.routes = [toml.routes.pattern];
  } else {
    config = parseJsonc(text) as Record<string, unknown>;
  }
  const routes: string[] = [];
  const add = (value: unknown) => {
    const pattern = typeof value === "string" ? value : str((value as { pattern?: unknown })?.pattern);
    if (pattern) routes.push(pattern);
  };
  if (Array.isArray(config.routes)) config.routes.forEach(add);
  add(config.route);
  const name = str(config.name);
  if (!name) return EMPTY;
  return {
    ...EMPTY,
    apis: [
      {
        kind: "worker",
        name,
        summary: routes.length ? `Served at ${routes.slice(0, 5).join(", ")}` : "A Worker reached through service bindings",
        routes: routes.slice(0, MAX_ROUTES),
      },
    ],
  };
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function openapi(path: string, text: string): FileFacts {
  const spec = (/\.json$/i.test(path) ? JSON.parse(text) : parseYaml(text)) as {
    info?: { title?: unknown; description?: unknown; version?: unknown };
    paths?: Record<string, Record<string, unknown>>;
  };
  const routes: string[] = [];
  for (const [route, operations] of Object.entries(spec?.paths ?? {})) {
    for (const method of Object.keys(operations ?? {})) {
      if (METHODS.includes(method)) routes.push(`${method.toUpperCase()} ${route}`);
    }
  }
  const title = str(spec?.info?.title) ?? base(path);
  return {
    ...EMPTY,
    apis: [
      {
        kind: "openapi",
        name: title,
        summary: clip(str(spec?.info?.description) ?? `${routes.length} operations${str(spec?.info?.version) ? `, version ${spec.info!.version}` : ""}`),
        routes: routes.slice(0, MAX_ROUTES),
      },
    ],
  };
}

/** A doc split at its headings into pieces of at most `CHUNK_CHARS`. */
export function chunk(text: string, title: string): string[] {
  const sections: string[] = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,3}\s/.test(line) && current.trim()) {
      sections.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) sections.push(current.trim());
  const pieces: string[] = [];
  for (const section of sections) {
    const heading = /^#{1,3}\s+(.*)$/m.exec(section)?.[1]?.trim() ?? title;
    for (let at = 0; at < section.length && pieces.length < MAX_CHUNKS; at += CHUNK_CHARS) {
      const body = section.slice(at, at + CHUNK_CHARS);
      pieces.push(at === 0 ? body : `${heading} (continued)\n${body}`);
    }
  }
  return pieces.slice(0, MAX_CHUNKS);
}

const COMMAND = /^\s*(?:\$\s*)?((?:npm|pnpm|yarn|bun|npx|cargo|go|make|pytest|python3?|poetry|uv|docker|wrangler|just|mix|bundle|rake|gradle|\.\/gradlew|mvn|dotnet)\b[^\n]{0,160})$/;

/**
 * What a doc says worth remembering: the commands in its setup sections,
 * and the bullets of its conventions and setup sections, each whole (see
 * `./harvest`). A doc that reads as a plan, a report or feedback says
 * nothing; nor does a plan section in any doc, or a line that says what
 * someone wants rather than how things are.
 */
function docHints(path: string, text: string, role: DocFact["role"], ctx: ExtractContext): Hint[] {
  const agents = role === "agents";
  if (!agents && planLike(text)) return [];
  const hints: Hint[] = [];
  const where = (heading: string) => `${path}${heading ? ` (${heading})` : ""}`;

  // Commands in code blocks under a setup heading (any, in AGENTS.md).
  let heading = "";
  let skipping = 0;
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h && !fenced) {
      const level = h[1].length;
      if (skipping && level <= skipping) skipping = 0;
      heading = h[2].trim();
      if (!skipping && planSection(heading)) skipping = level;
      continue;
    }
    if (!fenced || skipping) continue;
    const command = COMMAND.exec(line)?.[1];
    if (command && (agents || SETUP_HEADING.test(heading))) {
      const what = heading ? plain(heading).replace(/[:.]$/, "").toLowerCase() : "work on it";
      const said = wholeSentences(`In ${ctx.project}, for ${what}: \`${command.trim()}\`.`, MAX_HINT_CHARS);
      if (said) hints.push({ kind: "fact", text: said, confidence: agents ? 0.9 : 0.7, evidence: where(heading) });
    }
  }

  // Bullets, whole, from the sections that say how things are done.
  for (const bullet of bulletsOf(text)) {
    if (!bulletSection(bullet.heading, role)) continue;
    // A bullet that is only a link is a table of contents.
    if (/^\[[^\]]*\]\([^)]*\)\.?$/.test(bullet.text)) continue;
    if (aspirational(bullet.text, role)) continue;
    const words = plain(bullet.text);
    // Too short to mean anything, or a lead-in to a list of its own.
    if (words.length < 20 || /:$/.test(words)) continue;
    const said = wholeSentences(words, MAX_HINT_CHARS);
    if (!said) continue;
    hints.push({ ...classify(said, bullet.heading, role), text: said, evidence: where(bullet.heading) });
  }
  // The same line under two headings is one hint.
  const seen = new Set<string>();
  return hints
    .filter((hint) => {
      const key = hint.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return !seen.has(key) && seen.add(key);
    })
    .slice(0, MAX_HINTS_PER_FILE);
}

function doc(path: string, text: string, ctx: ExtractContext): FileFacts {
  const name = base(path);
  const role: DocFact["role"] = /^readme/i.test(name)
    ? "readme"
    : /^(agents|claude)/i.test(name)
      ? "agents"
      : /^contributing/i.test(name)
        ? "contributing"
        : "doc";
  const title = /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? name.replace(/\.(md|markdown|txt)$/i, "");
  const paragraph = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("```") && !block.startsWith("<") && !block.startsWith("!["));
  return {
    ...EMPTY,
    doc: { path, title: clip(title, 120), summary: paragraph ? clip(paragraph) : null, chunks: chunk(text, title), role },
    hints: docHints(path, text, role, ctx),
  };
}

/** Strings, from a YAML value that is a string or a list of them. */
function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()).slice(0, 50);
}

function owners(path: string, text: string): FileFacts {
  const names = new Set<string>();
  let memory: MemoryDocsConfig | null = null;
  if (path.endsWith("project.yml")) {
    const parsed = parseYaml(text) as { owners?: unknown; memory?: { docs?: unknown; skip?: unknown } } | null;
    if (parsed?.memory && typeof parsed.memory === "object") memory = { docs: strings(parsed.memory.docs), skip: strings(parsed.memory.skip) };
    const list = Array.isArray(parsed?.owners) ? parsed.owners : typeof parsed?.owners === "string" ? [parsed.owners] : [];
    for (const owner of list) if (typeof owner === "string") names.add(owner.replace(/^@/, "").trim());
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      for (const match of line.matchAll(/@([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s|$)/g)) names.add(match[1]);
    }
  }
  return { ...EMPTY, owners: [...names].filter(Boolean).slice(0, 20), ...(memory ? { memory } : {}) };
}

const TESTS = /\b(test|tests|pytest|vitest|jest|mocha|cargo test|go test|npm test|playwright|cypress)\b/i;

/** The facts in one file. A file that cannot be parsed says nothing. */
export function extract(path: string, text: string, ctx: ExtractContext): FileFacts {
  return { ...read(path, text, ctx), version: EXTRACT_VERSION };
}

function read(path: string, text: string, ctx: ExtractContext): FileFacts {
  const name = base(path);
  try {
    if (path.startsWith(".g1t/workflows/") || path.startsWith(".github/workflows/")) {
      return { ...EMPTY, tests: TESTS.test(text) };
    }
    if (path === ".g1t/project.yml" || name === "CODEOWNERS") return owners(path, text);
    if (name === "package.json") return npm(path, text, ctx);
    if (name === "Cargo.toml") return cargo(path, text, ctx);
    if (name === "go.mod") return goMod(path, text, ctx);
    if (name === "pyproject.toml" || name === "requirements.txt") return python(path, text, ctx);
    if (/^wrangler\.(jsonc|json|toml)$/.test(name)) return wrangler(path, text);
    if (OPENAPI_NAME.test(name)) return openapi(path, text);
    if (/\.(md|markdown|txt)$/i.test(name) || DOC_NAME.test(name)) return doc(path, text, ctx);
  } catch {
    return EMPTY;
  }
  return EMPTY;
}
