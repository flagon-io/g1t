import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type KindFacts,
  type RootFiles,
  detectKind,
  goFilesToRead,
  kindSetting,
  neverRuns,
  nextSetting,
  resolveKind,
  runsSetting,
} from "./kind.ts";

const root = (text: Record<string, string>, more: Partial<RootFiles> = {}): RootFiles => ({
  entries: [...Object.keys(text), ...(more.entries ?? [])],
  text,
  ...(more.src ? { src: more.src } : {}),
  ...(more.public ? { public: more.public } : {}),
});

// psr/log's composer.json, as it is at 3.0.2: no type, an autoload.
const PSR_LOG = JSON.stringify({
  name: "psr/log",
  description: "Common interface for logging libraries",
  license: "MIT",
  require: { php: ">=8.0.0" },
  autoload: { "psr-4": { "Psr\\Log\\": "src" } },
});

test("a Composer package is a library; a Composer project is an app", () => {
  assert.deepEqual(detectKind(root({ "composer.json": PSR_LOG }, { entries: ["src/", "README.md"] })), {
    kind: "library",
    detail: "composer.json has autoload and no public/index.php.",
    ecosystem: "composer",
  });
  assert.equal(detectKind(root({ "composer.json": '{"type":"library"}' })).kind, "library");
  assert.equal(detectKind(root({ "composer.json": '{"type":"symfony-bundle"}' })).detail, 'composer.json says "type": "symfony-bundle".');
  assert.equal(detectKind(root({ "composer.json": '{"type":"project","autoload":{}}' })).kind, "app");
  // Laravel and the like: no type, but a front controller to serve.
  const laravel = root({ "composer.json": '{"autoload":{"psr-4":{}}}' }, { entries: ["public/"], public: ["index.php", ".htaccess"] });
  assert.equal(detectKind(laravel).kind, "app");
});

test("package.json: an entry point without a start or dev script is a library", () => {
  assert.equal(detectKind(root({ "package.json": '{"name":"x","main":"dist/index.js","scripts":{"build":"tsc"}}' })).kind, "library");
  assert.equal(detectKind(root({ "package.json": '{"exports":{".":"./index.js"}}' })).detail, 'package.json has "exports" and no start or dev script.');
  assert.equal(detectKind(root({ "package.json": '{"main":"index.js","scripts":{"start":"node index.js"}}' })).kind, "app");
  assert.equal(detectKind(root({ "package.json": '{"main":"index.js","scripts":{"dev":"vite"}}' })).kind, "app");
  assert.equal(detectKind(root({ "package.json": '{"files":["dist"],"dependencies":{"next":"15"}}' })).detail, "package.json depends on next.");
  assert.equal(detectKind(root({ "package.json": '{"files":["dist"],"devDependencies":{"@sveltejs/kit":"2"}}' })).kind, "app");
  // A library built with Vite stays a library; a Vite site has index.html.
  assert.equal(detectKind(root({ "package.json": '{"main":"dist/x.js","devDependencies":{"vite":"6"}}' })).kind, "library");
  assert.equal(detectKind(root({ "package.json": '{"main":"x.js","devDependencies":{"vite":"6"}}' }, { entries: ["index.html"] })).kind, "app");
  // Nothing to tell from.
  assert.equal(detectKind(root({ "package.json": '{"name":"x"}' })).kind, null);
  assert.equal(detectKind(root({ "package.json": "not json" })).kind, null);
});

test("Cargo: a library and no binary is a library", () => {
  assert.equal(detectKind(root({ "Cargo.toml": "[package]\nname = \"x\"\n\n[lib]\n" }, { entries: ["src/"], src: ["lib.rs"] })).kind, "library");
  assert.equal(detectKind(root({ "Cargo.toml": "[package]\nname = \"x\"\n" }, { entries: ["src/"], src: ["lib.rs"] })).kind, "library");
  assert.equal(detectKind(root({ "Cargo.toml": "[package]\n[lib]\n" }, { entries: ["src/"], src: ["lib.rs", "main.rs"] })).kind, "app");
  assert.equal(detectKind(root({ "Cargo.toml": "[package]\n[lib]\n[[bin]]\nname = \"x\"\n" })).kind, "app");
});

test("Go: a module with no package main at its root is a library", () => {
  const lib = root({ "go.mod": "module g1t.sh/acme/log\n", "log.go": "// Package log logs.\npackage log\n" });
  assert.deepEqual(detectKind(lib), { kind: "library", detail: "go.mod, with no package main at the root.", ecosystem: "go" });
  const app = root({ "go.mod": "module x\n", "main.go": "package main\n\nfunc main() {}\n" });
  assert.deepEqual(detectKind(app), { kind: "app", detail: "main.go at the root is package main.", ecosystem: "go" });
  assert.equal(detectKind(root({ "go.mod": "module x\n" }, { entries: ["cmd/"] })).kind, null);
  assert.deepEqual(goFilesToRead(["a.go", "a_test.go", "b.go", "c.go", "d.go", "go.mod"]), ["a.go", "b.go", "c.go"]);
});

test("Python: a build backend and no app framework is a library", () => {
  const lib = '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n[project]\ndependencies = ["httpx"]\n';
  assert.equal(detectKind(root({ "pyproject.toml": lib })).kind, "library");
  const app = '[build-system]\nbuild-backend = "hatchling.build"\n[project]\ndependencies = ["django>=5", "flask-login"]\n';
  assert.equal(detectKind(root({ "pyproject.toml": app })).detail, "pyproject.toml depends on django.");
  // A plugin named after a framework is not the framework.
  assert.equal(detectKind(root({ "pyproject.toml": '[build-system]\nbuild-backend = "x"\ndependencies = ["flask-login"]\n' })).kind, "library");
});

test("the language's manifest decides before package.json, and a Workers config is always an app", () => {
  const php = root({ "composer.json": PSR_LOG, "package.json": '{"scripts":{"dev":"vite"}}' });
  assert.equal(detectKind(php).ecosystem, "composer");
  assert.equal(detectKind(php).kind, "library");
  assert.equal(detectKind(root({ "package.json": '{"main":"x.js"}' }, { entries: ["wrangler.jsonc"] })).kind, "app");
  assert.equal(detectKind(root({}, { entries: ["index.html", "style.css"] })).kind, "app");
  assert.deepEqual(detectKind(root({}, { entries: ["README.md"] })), { kind: null, detail: "No manifest at the root says what it is.", ecosystem: null });
});

const auto: KindFacts = { setting: { kind: null, runs: null }, deploymentsOn: false, linkedPackage: null, detected: null };

test("the setting wins over everything", () => {
  assert.equal(resolveKind({ ...auto, setting: { kind: "app", runs: "g1t" }, linkedPackage: "Composer package psr/log" }).kind, "app");
  assert.deepEqual(resolveKind({ ...auto, setting: { kind: "library", runs: null }, deploymentsOn: true }), {
    kind: "library",
    reason: { by: "set", detail: "Set in its settings: a library." },
    runs: null,
  });
  assert.equal(resolveKind({ ...auto, setting: { kind: "tool", runs: null } }).reason.detail, "Set in its settings: a tool.");
});

test("where it runs: set, or on g1t while Deployments are on, or nobody has said", () => {
  // An app deployed by its own CI: no nag to turn on Deployments.
  const elsewhere = resolveKind({ ...auto, setting: { kind: null, runs: "elsewhere" }, detected: { kind: "library", detail: "" } });
  assert.deepEqual([elsewhere.kind, elsewhere.runs, elsewhere.reason.by], ["app", "elsewhere", "set"]);
  assert.equal(resolveKind({ ...auto, deploymentsOn: true }).runs, "g1t");
  assert.equal(resolveKind({ ...auto, setting: { kind: "app", runs: "g1t" } }).runs, "g1t");
  // Detected an app, Deployments off: unknown, so the page asks instead of nagging.
  assert.equal(resolveKind({ ...auto, detected: { kind: "app", detail: "wrangler.jsonc at the root." } }).runs, null);
  // Docs can be a site; a library, a tool and other never run.
  assert.equal(resolveKind({ ...auto, setting: { kind: "docs", runs: null }, deploymentsOn: true }).runs, "g1t");
  for (const kind of ["library", "tool", "other"] as const) {
    assert.equal(resolveKind({ ...auto, setting: { kind, runs: "g1t" }, deploymentsOn: true }).runs, null);
  }
});

test("a change to the setting keeps it coherent", () => {
  const none = { kind: null, runs: null };
  assert.deepEqual(nextSetting(none, { runs: "elsewhere" }), { kind: null, runs: "elsewhere" });
  assert.deepEqual(nextSetting({ kind: "app", runs: "g1t" }, { kind: "library" }), { kind: "library", runs: null });
  assert.deepEqual(nextSetting({ kind: "docs", runs: "elsewhere" }, { kind: "docs" }), { kind: "docs", runs: "elsewhere" });
  assert.deepEqual(nextSetting({ kind: "tool", runs: null }, { runs: "g1t" }), { kind: "app", runs: "g1t" });
  assert.deepEqual(nextSetting({ kind: "app", runs: "g1t" }, { kind: "auto", runs: "auto" }), none);
  assert.equal(neverRuns({ kind: "other", runs: null }), true);
  assert.equal(neverRuns({ kind: "docs", runs: null }), false);
  assert.equal(neverRuns(none), false);
});

test("on auto: Deployments on, then packages, then files, then an app", () => {
  const library = { kind: "library" as const, detail: "composer.json has autoload and no public/index.php." };
  assert.equal(resolveKind({ ...auto, deploymentsOn: true, linkedPackage: "Composer package psr/log", detected: library }).reason.by, "deployments");
  assert.deepEqual(resolveKind({ ...auto, linkedPackage: "Composer package psr/log", detected: library }), {
    kind: "library",
    reason: { by: "packages", detail: "Its repository publishes the Composer package psr/log." },
    runs: null,
  });
  assert.deepEqual(resolveKind({ ...auto, detected: library }), { kind: "library", reason: { by: "files", detail: library.detail }, runs: null });
  assert.equal(resolveKind({ ...auto, detected: { kind: "app", detail: "package.json has a start script." } }).reason.by, "files");
  assert.deepEqual(resolveKind({ ...auto, deploymentsOn: null, detected: { kind: null, detail: "" } }).kind, "app");
  assert.equal(resolveKind(auto).reason.by, "default");
});

test("an unknown setting is left to detection", () => {
  assert.equal(kindSetting("tool"), "tool");
  assert.equal(kindSetting("auto"), null);
  assert.equal(kindSetting("yes"), null);
  assert.equal(runsSetting("elsewhere"), "elsewhere");
  assert.equal(runsSetting("sometimes"), null);
});

test("detection says tool, and docs, where the files do", () => {
  assert.deepEqual(detectKind(root({ "package.json": '{"name":"x","bin":{"x":"cli.js"}}' })), {
    kind: "tool",
    detail: 'package.json has "bin" and nothing to import.',
    ecosystem: "npm",
  });
  // Something to import as well as a command: a library.
  assert.equal(detectKind(root({ "package.json": '{"main":"x.js","bin":"cli.js"}' })).kind, "library");
  assert.equal(detectKind(root({ "package.json": '{"scripts":{"start":"docusaurus start"}}' }, { entries: ["docusaurus.config.ts"] })).kind, "docs");
  assert.equal(detectKind(root({}, { entries: ["mkdocs.yml", "docs/"] })).detail, "mkdocs.yml at the root builds documentation.");
  assert.equal(resolveKind({ ...auto, detected: { kind: "docs", detail: "mkdocs.yml at the root builds documentation." } }).kind, "docs");
});
