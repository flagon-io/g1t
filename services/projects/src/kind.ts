/**
 * What a project is (an app, a library, a tool, docs or other) and where
 * it runs (on g1t, elsewhere, or nowhere). A person can say either in its
 * settings; left to detection, it is worked out here from what the project
 * has: Deployments being on, packages its repository publishes, and the
 * files at its root. The functions are pure so the rules can be tested on
 * their own; the service reads the files and keeps the detection by commit.
 */

import type { KindReason, ProjectEcosystem, ProjectKind, ProjectRuns, ProjectSetting } from "@g1t/contracts";

/** As contracts' PROJECT_KINDS; repeated so this module's tests run without the package. */
const PROJECT_KINDS: readonly ProjectKind[] = ["app", "library", "tool", "docs", "other"];

/** The manifests whose contents detection reads, when they are at the root. */
export const MANIFESTS = ["composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "package.json"] as const;
/** At most this many root `.go` files are read to find `package main`. */
export const GO_FILES_READ = 3;

/** What detection is given: the project's root, and what was read from it. */
export type RootFiles = {
  /** Names at the project's root; directories end in `/`. */
  entries: string[];
  /** Contents of the manifests and root `.go` files read, by name. */
  text: Record<string, string>;
  /** Names in `src/`, when the root has a Cargo.toml. */
  src?: string[];
  /** Names in `public/`, when the root has a composer.json. */
  public?: string[];
};

/** What the files say: a kind with why, or null when nothing says either way. */
export type Detection = { kind: ProjectKind | null; detail: string; ecosystem: ProjectEcosystem | null };

/** Root `.go` files detection reads, tests left out. */
export function goFilesToRead(entries: string[]): string[] {
  return entries.filter((name) => name.endsWith(".go") && !name.endsWith("_test.go")).slice(0, GO_FILES_READ);
}

const has = (files: RootFiles, name: string) => files.entries.includes(name);

/** Frameworks that make a package.json an app. Hosting a server alone does not: a start script does. */
const JS_APP_FRAMEWORKS = ["next", "astro", "nuxt", "@remix-run/dev", "@remix-run/node", "@react-router/dev", "@sveltejs/kit", "gatsby", "@angular/core", "expo", "react-scripts"];
/** Documentation generators' configs: a root with one is documentation. */
const DOCS_CONFIGS = ["mkdocs.yml", "mkdocs.yaml", "book.toml", "docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "antora.yml"];
/** Python frameworks that make a pyproject an app. */
const PY_APP_FRAMEWORKS = ["django", "flask", "fastapi", "streamlit", "gradio", "starlette", "uvicorn"];

function composer(files: RootFiles, text: string): Detection {
  const ecosystem = "composer";
  let json: { type?: unknown; autoload?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: null, detail: "composer.json could not be read.", ecosystem };
  }
  const type = typeof json.type === "string" ? json.type : null;
  if (type === "project") return { kind: "app", detail: 'composer.json says "type": "project".', ecosystem };
  if (type) return { kind: "library", detail: `composer.json says "type": "${type}".`, ecosystem };
  const servesIndex = files.public?.includes("index.php") || has(files, "index.php");
  if (json.autoload && !servesIndex) {
    return { kind: "library", detail: "composer.json has autoload and no public/index.php.", ecosystem };
  }
  if (servesIndex) return { kind: "app", detail: "It has a composer.json and an index.php to serve.", ecosystem };
  return { kind: null, detail: "composer.json has no type or autoload.", ecosystem };
}

function cargo(files: RootFiles, text: string): Detection {
  const ecosystem = "cargo";
  const lib = /^\s*\[lib\]/m.test(text) || !!files.src?.includes("lib.rs");
  const bin = /^\s*\[\[bin\]\]/m.test(text) || !!files.src?.includes("main.rs");
  if (bin) return { kind: "app", detail: "Cargo.toml builds a binary.", ecosystem };
  if (lib) return { kind: "library", detail: "Cargo.toml builds a library and no binary.", ecosystem };
  return { kind: null, detail: "Cargo.toml builds neither a library nor a binary here.", ecosystem };
}

function go(files: RootFiles): Detection {
  const ecosystem = "go";
  const sources = goFilesToRead(files.entries);
  const main = sources.find((name) => /^\s*package\s+main\b/m.test(files.text[name] ?? ""));
  if (main) return { kind: "app", detail: `${main} at the root is package main.`, ecosystem };
  if (sources.length > 0) return { kind: "library", detail: "go.mod, with no package main at the root.", ecosystem };
  // A module whose code is all in directories: commands live in cmd/.
  if (has(files, "cmd/")) return { kind: null, detail: "go.mod, with commands in cmd/.", ecosystem };
  return { kind: "library", detail: "go.mod, with no package main at the root.", ecosystem };
}

function python(text: string): Detection {
  const ecosystem = "python";
  const backend = /^\s*build-backend\s*=/m.test(text) || /^\s*\[tool\.poetry\]/m.test(text);
  const framework = PY_APP_FRAMEWORKS.find((name) => new RegExp(`["'\\s]${name}(?![\\w-])`, "i").test(text));
  if (framework) return { kind: "app", detail: `pyproject.toml depends on ${framework}.`, ecosystem };
  if (backend) return { kind: "library", detail: "pyproject.toml has a build backend and no app framework.", ecosystem };
  return { kind: null, detail: "pyproject.toml has no build backend.", ecosystem };
}

function npm(files: RootFiles, text: string): Detection {
  const ecosystem = "npm";
  let json: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    main?: unknown;
    module?: unknown;
    exports?: unknown;
    files?: unknown;
    bin?: unknown;
  };
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: null, detail: "package.json could not be read.", ecosystem };
  }
  const script = ["start", "dev"].find((name) => typeof json.scripts?.[name] === "string");
  if (script) return { kind: "app", detail: `package.json has a ${script} script.`, ecosystem };
  const deps = { ...json.devDependencies, ...json.dependencies };
  const framework = JS_APP_FRAMEWORKS.find((name) => name in deps);
  if (framework) return { kind: "app", detail: `package.json depends on ${framework}.`, ecosystem };
  // Vite builds libraries too; with an index.html at the root it is a site.
  if ("vite" in deps && has(files, "index.html")) return { kind: "app", detail: "A Vite site, with index.html at the root.", ecosystem };
  // A command to install and nothing to import: a tool.
  if (json.bin != null && json.main == null && json.module == null && json.exports == null) {
    return { kind: "tool", detail: 'package.json has "bin" and nothing to import.', ecosystem };
  }
  const entry = ["exports", "main", "module", "files", "bin"].find((key) => json[key as keyof typeof json] != null);
  if (entry) return { kind: "library", detail: `package.json has "${entry}" and no start or dev script.`, ecosystem };
  return { kind: null, detail: "package.json has no entry point or start script.", ecosystem };
}

/**
 * What a project's root says it is. A Workers config or a root index.html
 * is something to serve. Otherwise the first manifest present that says
 * either way decides, the language's own before package.json, which many
 * projects carry only for tooling.
 */
export function detectKind(files: RootFiles): Detection {
  const workers = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].find((name) => has(files, name));
  if (workers) return { kind: "app", detail: `${workers} at the root.`, ecosystem: null };
  const docs = DOCS_CONFIGS.find((name) => has(files, name));
  if (docs) return { kind: "docs", detail: `${docs} at the root builds documentation.`, ecosystem: null };
  let first: Detection | null = null;
  for (const name of MANIFESTS) {
    if (!has(files, name)) continue;
    const text = files.text[name] ?? "";
    const found =
      name === "composer.json"
        ? composer(files, text)
        : name === "Cargo.toml"
          ? cargo(files, text)
          : name === "go.mod"
            ? go(files)
            : name === "pyproject.toml"
              ? python(text)
              : npm(files, text);
    if (found.kind) return found;
    first ??= found;
  }
  if (has(files, "index.html")) return { kind: "app", detail: "index.html at the root.", ecosystem: first?.ecosystem ?? null };
  return first ?? { kind: null, detail: "No manifest at the root says what it is.", ecosystem: null };
}

/** What resolution is given, from the project's row. */
export type KindFacts = {
  /** What a person set; null parts are left to detection. */
  setting: ProjectSetting;
  /** Whether Deployments are on for it; null while unknown. */
  deploymentsOn: boolean | null;
  /** A package its repository publishes, other than a container image, as `Composer package psr/log`; null for none. */
  linkedPackage: string | null;
  /** What its files say; null before they have been read. */
  detected: { kind: ProjectKind | null; detail: string } | null;
};

/** How a kind is named in a sentence: `Set in its settings: a library.` */
export const KIND_PHRASE: Record<ProjectKind, string> = {
  app: "an app",
  library: "a library",
  tool: "a tool",
  docs: "documentation",
  other: "not an app, a library, a tool or docs",
};

/** Kinds that can run somewhere: an app, and docs published as a site. */
export const RUNNABLE: readonly ProjectKind[] = ["app", "docs"];

/**
 * What a project is, and where it runs. The setting wins, and where it
 * runs being set makes it an app. Left to detection: Deployments being on
 * makes it an app; then a package its repository publishes, or files that
 * say so, decide; anything else is an app, so nothing that deploys loses
 * its production card to a guess.
 *
 * Only an app or docs runs anywhere: where it is set to, or on g1t while
 * Deployments are on, and otherwise nobody has said (null).
 */
export function resolveKind(facts: KindFacts): { kind: ProjectKind; reason: KindReason; runs: ProjectRuns | null } {
  const { kind, reason } = kindOf(facts);
  const runs = RUNNABLE.includes(kind) ? (facts.setting.runs ?? (facts.deploymentsOn ? "g1t" : null)) : null;
  return { kind, reason, runs };
}

function kindOf(facts: KindFacts): { kind: ProjectKind; reason: KindReason } {
  const { setting } = facts;
  if (setting.kind) return { kind: setting.kind, reason: { by: "set", detail: `Set in its settings: ${KIND_PHRASE[setting.kind]}.` } };
  if (setting.runs === "g1t") return { kind: "app", reason: { by: "set", detail: "Set in its settings: it deploys on g1t." } };
  if (setting.runs === "elsewhere") return { kind: "app", reason: { by: "set", detail: "Set in its settings: it is deployed elsewhere." } };
  return detectedKind(facts);
}

/** What detection alone decides, whatever the setting is. */
export function detectedKind(facts: Omit<KindFacts, "setting">): { kind: ProjectKind; reason: KindReason } {
  if (facts.deploymentsOn) return { kind: "app", reason: { by: "deployments", detail: "Deployments are on for it." } };
  if (facts.linkedPackage) {
    return { kind: "library", reason: { by: "packages", detail: `Its repository publishes the ${facts.linkedPackage}.` } };
  }
  if (facts.detected?.kind) return { kind: facts.detected.kind, reason: { by: "files", detail: facts.detected.detail } };
  return { kind: "app", reason: { by: "default", detail: "Nothing in it says what it is, so it is taken to be an app." } };
}

/** A stored or submitted kind; null (left to detection) for anything else. */
export function kindSetting(value: unknown): ProjectKind | null {
  return PROJECT_KINDS.includes(value as ProjectKind) ? (value as ProjectKind) : null;
}

/** A stored or submitted place it runs; null (left to Deployments) for anything else. */
export function runsSetting(value: unknown): ProjectRuns | null {
  return value === "g1t" || value === "elsewhere" ? value : null;
}

/**
 * The setting after a change, where `auto` leaves a part to detection. A
 * kind that never runs clears where it runs; where it runs being set on
 * something that never runs makes it an app.
 */
export function nextSetting(current: ProjectSetting, change: { kind?: ProjectKind | "auto"; runs?: ProjectRuns | "auto" }): ProjectSetting {
  let kind = change.kind === undefined ? current.kind : kindSetting(change.kind);
  let runs = change.runs === undefined ? current.runs : runsSetting(change.runs);
  if (change.kind !== undefined && kind && !RUNNABLE.includes(kind) && change.runs === undefined) runs = null;
  if (runs && kind && !RUNNABLE.includes(kind)) kind = "app";
  return { kind, runs };
}

/** Whether a setting stops the project running anywhere: Deployments are turned off first. */
export function neverRuns(setting: ProjectSetting): boolean {
  return setting.kind != null && !RUNNABLE.includes(setting.kind);
}
