/**
 * Whether a project is an app, which deploys, or a library (or a tool),
 * which is published and installed. A person can say so in its settings;
 * left on `auto`, it is worked out here from what the project has: Deployments
 * being on, packages its repository publishes, and the manifests at its
 * root. Both functions are pure so the rules can be tested on their own;
 * the service reads the files and keeps the detection by commit.
 */

import type { DeploysSetting, KindReason, ProjectEcosystem, ProjectKind } from "@g1t/contracts";

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
  deploys: DeploysSetting;
  /** Whether Deployments are on for it; null while unknown. */
  deploymentsOn: boolean | null;
  /** A package its repository publishes, other than a container image, as `Composer package psr/log`; null for none. */
  linkedPackage: string | null;
  /** What its files say; null before they have been read. */
  detected: { kind: ProjectKind | null; detail: string } | null;
};

/**
 * The kind a project is. The setting wins. On `auto`: Deployments being on
 * makes it an app; then a package its repository publishes, or files that
 * say library, make it a library; anything else is an app, so nothing that
 * deploys loses its production card to a guess.
 */
export function resolveKind(facts: KindFacts): { kind: ProjectKind; reason: KindReason } {
  if (facts.deploys === "yes") return { kind: "app", reason: { by: "set", detail: "Set in its settings: it deploys." } };
  if (facts.deploys === "no") return { kind: "library", reason: { by: "set", detail: "Set in its settings: it doesn't deploy." } };
  if (facts.deploymentsOn) return { kind: "app", reason: { by: "deployments", detail: "Deployments are on for it." } };
  if (facts.linkedPackage) {
    return { kind: "library", reason: { by: "packages", detail: `Its repository publishes the ${facts.linkedPackage}.` } };
  }
  if (facts.detected?.kind === "library") return { kind: "library", reason: { by: "files", detail: facts.detected.detail } };
  if (facts.detected?.kind === "app") return { kind: "app", reason: { by: "files", detail: facts.detected.detail } };
  return { kind: "app", reason: { by: "default", detail: "Nothing in it says it is a library, so it is taken to deploy." } };
}

const SETTINGS: readonly DeploysSetting[] = ["auto", "yes", "no"];

/** A stored or submitted setting, `auto` for anything else. */
export function deploysSetting(value: unknown): DeploysSetting {
  return SETTINGS.includes(value as DeploysSetting) ? (value as DeploysSetting) : "auto";
}
