// node --test "scripts/deploy/*.test.mjs"   (npm run test:deploy)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { annotation, commitFrom, liveCommit, pendingFrom, versionFrom } from "./cloudflare.mjs";
import { changedNames, parseCargoLock, parseNpmLock, reaches } from "./lockfiles.mjs";
import { decide, planJson, pool } from "./plan.mjs";
import {
  ROOT,
  buildGroups,
  cargoWorkspace,
  findWranglerConfigs,
  loadStack,
  npmCiArgs,
  npmWorkspace,
  outsideImports,
  pick,
  problems,
  resolveStack,
  resolvedStack,
  touches,
  touchesImage,
} from "./stack.mjs";

const stack = resolvedStack();
const unit = (id) => stack.units.find((u) => u.id === id);

// ── The manifest ──────────────────────────────────────────────────────────

test("the manifest matches every wrangler config in the repository", () => {
  assert.deepEqual(problems(stack, findWranglerConfigs()), []);
});

test("every wrangler.jsonc is found, and only checked-in ones", () => {
  const configs = findWranglerConfigs();
  assert.ok(configs.includes("services/events/wrangler.jsonc"));
  assert.ok(configs.includes("apps/web/wrangler.jsonc"));
  assert.ok(!configs.some((c) => c.includes("/build/")), "build output is not a unit");
  assert.equal(configs.length, stack.units.length);
});

test("problems are found: an unlisted config, a later-stage binding, a wrong database, an unnamed KV", () => {
  const broken = loadStack();
  const events = broken.units.find((u) => u.id === "events");
  events.stage = "front";
  const identity = broken.units.find((u) => u.id === "identity");
  identity.d1 = { database: "g1t-identity", migrations: "migrations" };
  broken.resources = { kv: {} };
  const found = problems(broken, [...findWranglerConfigs(), "services/new/wrangler.jsonc"]);
  assert.ok(found.some((p) => p.includes("services/new/wrangler.jsonc is not in")));
  assert.ok(found.some((p) => p.includes("binds to events (front), which ships after it")));
  assert.ok(found.some((p) => p.startsWith("Unit identity: d1 is")));
  assert.ok(found.some((p) => p.includes("has no name under resources.kv")));
});

test("stages follow bindings: nothing binds to a unit that ships after it", () => {
  const order = stack.stages;
  for (const u of stack.units) {
    for (const target of u.bindsTo) {
      const other = stack.units.find((o) => o.worker === target);
      assert.ok(order.indexOf(other.stage) <= order.indexOf(u.stage), `${u.id} -> ${other.id}`);
    }
  }
});

test("Rust workers build with the shared script and the same wasm-opt level", () => {
  for (const u of stack.units.filter((u) => u.kind === "rust-worker")) {
    assert.equal(u.config.build.command, "node ../../scripts/build-rust-worker.mjs", u.id);
    const toml = readFileSync(join(ROOT, u.path, "Cargo.toml"), "utf8");
    assert.match(toml, /\[package\.metadata\.wasm-pack\.profile\.release\]\s*\nwasm-opt = \["-O1"\]/, u.id);
  }
});

// ── What each unit is built from ──────────────────────────────────────────

test("shared crates and packages are read from workspace metadata", () => {
  assert.deepEqual(unit("events").dependsOn, ["crates/contracts", "crates/kit"]);
  assert.deepEqual(unit("repos").dependsOn, ["crates/contracts", "crates/kit", "crates/scan", "crates/secrets"]);
  assert.ok(unit("actions").dependsOn.includes("crates/actions"));
  assert.ok(!unit("events").dependsOn.includes("crates/scan"));
  assert.deepEqual(unit("web").dependsOn, ["packages/contracts", "packages/theme"]);
  assert.deepEqual(unit("projects").dependsOn, ["packages/contracts"]);
  assert.deepEqual(unit("pages").dependsOn, []);
  assert.equal(unit("events").crate, "g1t-events");
  assert.equal(unit("web").pkg, "@g1t/web");
});

test("the runner's image is built from the runner crate and what it uses", () => {
  const runner = unit("runner");
  assert.deepEqual(runner.image.dirs, ["crates/actions", "crates/runner"]);
  assert.ok(runner.dependsOn.includes("crates/runner"));
  assert.ok(touchesImage(runner, ["crates/actions/src/expr.rs"]));
  assert.ok(touchesImage(runner, ["services/runner/Dockerfile"]));
  assert.ok(!touchesImage(runner, ["services/runner/src/index.ts"]));
});

test("path dependencies agree with Cargo's own resolved graph", (t) => {
  let full;
  try {
    full = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--offline"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 }));
  } catch {
    t.skip("cargo metadata could not resolve offline");
    return;
  }
  const cargo = cargoWorkspace(ROOT);
  const dirOf = new Map(full.packages.filter((p) => p.source === null).map((p) => [p.id, p.manifest_path]));
  const nodes = new Map(full.resolve.nodes.map((n) => [n.id, n]));
  for (const u of stack.units.filter((u) => u.crate)) {
    const root = full.packages.find((p) => p.name === u.crate).id;
    const seen = new Set();
    const stackIds = [root];
    while (stackIds.length) {
      const id = stackIds.pop();
      for (const dep of nodes.get(id).deps) {
        if (!dep.dep_kinds.some((k) => k.kind !== "dev")) continue;
        if (dirOf.has(dep.pkg) && !seen.has(dep.pkg)) {
          seen.add(dep.pkg);
          stackIds.push(dep.pkg);
        }
      }
    }
    const names = [...seen].map((id) => full.packages.find((p) => p.id === id).name);
    const dirs = names.map((name) => cargo.get(name).dir).sort();
    assert.deepEqual(dirs, u.dependsOn.filter((d) => d.startsWith("crates/")).sort(), u.id);
  }
});

test("every import that leaves a unit's folder is covered by its dependencies or inputs", () => {
  for (const u of stack.units) {
    for (const { file, target } of outsideImports(ROOT, u)) {
      const covered = u.dependsOn.some((dir) => target.startsWith(`${dir}/`)) || u.inputs.some((input) => target === input || target.startsWith(input.replace(/\.ts$/, "")));
      assert.ok(covered, `${file} imports ${target}, which ${u.id}'s manifest entry does not name`);
    }
  }
});

// ── What a change touches ─────────────────────────────────────────────────

const ids = (units, files) => units.filter((u) => touches(u, files)).map((u) => u.id);

test("a shared crate's change reaches every unit built from it, and no other", () => {
  assert.deepEqual(ids(stack.units, ["crates/scan/src/lib.rs"]), ["repos", "security"]);
  assert.deepEqual(ids(stack.units, ["crates/secrets/src/lib.rs"]), ["identity", "repos", "integrations", "webhooks", "actions"]);
  const kit = ids(stack.units, ["crates/kit/src/lib.rs"]);
  assert.deepEqual(kit, stack.units.filter((u) => u.kind === "rust-worker").map((u) => u.id));
  assert.deepEqual(ids(stack.units, ["crates/runner/src/main.rs"]), ["runner"]);
});

test("a shared package's change reaches what imports it", () => {
  assert.deepEqual(ids(stack.units, ["packages/theme/tokens.css"]), ["status", "web", "sudo", "docs"]);
  assert.ok(ids(stack.units, ["packages/contracts/src/index.ts"]).includes("og"));
  assert.ok(!ids(stack.units, ["packages/contracts/src/index.ts"]).includes("events"));
});

test("own folders, declared inputs and root files", () => {
  assert.deepEqual(ids(stack.units, ["services/pages/src/index.ts"]), ["pages"]);
  assert.deepEqual(ids(stack.units, ["apps/web/app/lib/roadmap.ts"]), ["og", "web"]);
  assert.deepEqual(ids(stack.units, ["docs/PLAN.md", "README.md", "deploy/stack.jsonc"]), []);
  assert.deepEqual(ids(stack.units, ["scripts/build-rust-worker.mjs"]), stack.units.filter((u) => u.kind === "rust-worker").map((u) => u.id));
  // services/events is not a prefix of services/eventsx.
  assert.equal(touches(unit("events"), ["services/eventsx/a.rs"]), null);
});

// ── Lockfiles ─────────────────────────────────────────────────────────────

const lock = (sha2) => `version = 4

[[package]]
name = "g1t-events"
version = "0.1.0"
dependencies = [
 "g1t-kit",
]

[[package]]
name = "g1t-kit"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "g1t-webhooks"
version = "0.1.0"
dependencies = [
 "g1t-kit",
 "g1t-secrets",
]

[[package]]
name = "g1t-secrets"
version = "0.1.0"
dependencies = [
 "sha2 ${sha2}",
]

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "sha2"
version = "${sha2}"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

test("a Cargo.lock change reaches only crates that use what changed", () => {
  const before = parseCargoLock(lock("0.10.8"));
  const after = parseCargoLock(lock("0.10.9"));
  const names = changedNames(before, after);
  assert.deepEqual([...names], ["sha2"]);
  assert.ok(reaches(after, ["g1t-webhooks"], names));
  assert.ok(!reaches(after, ["g1t-events"], names));
});

test("a package-lock change reaches through workspace links", () => {
  const make = (version) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { wrangler: "^4" } },
        "apps/web": { dependencies: { "@g1t/theme": "*", react: "^19" } },
        "services/pages": { dependencies: {} },
        "packages/theme": { dependencies: { fontkit: "^1" } },
        "node_modules/@g1t/theme": { resolved: "packages/theme", link: true },
        "node_modules/react": { version: "19.0.0" },
        "node_modules/fontkit": { version },
        "node_modules/wrangler": { version: "4.1.0" },
      },
    });
  const before = parseNpmLock(make("1.0.0"));
  const after = parseNpmLock(make("1.0.1"));
  const names = changedNames(before, after);
  assert.deepEqual([...names], ["fontkit"]);
  assert.ok(reaches(after, ["apps/web", ""], names));
  assert.ok(!reaches(after, ["services/pages", ""], names));
});

// ── Deciding ──────────────────────────────────────────────────────────────

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const fakeGit = (files, { has = true, locks = {} } = {}) => ({
  has: () => has,
  changed: () => files,
  show: (sha, path) => locks[`${sha}:${path}`] ?? "",
});

test("decide: changed units deploy, others wait, unknown ones deploy", () => {
  const units = ["events", "repos", "pages", "web"].map(unit);
  const live = { events: { sha: OLD }, repos: { sha: OLD }, pages: { sha: HEAD }, web: { sha: null, why: "never deployed" } };
  const decisions = decide(units, { live, head: HEAD, gitApi: fakeGit(["crates/scan/src/lib.rs"]) });
  const by = Object.fromEntries(decisions.map((d) => [d.unit.id, d]));
  assert.equal(by.events.deploy, false);
  assert.equal(by.events.reason, "nothing it is built from changed");
  assert.equal(by.repos.deploy, true);
  assert.match(by.repos.reason, /crates\/scan\/src\/lib.rs via crates\/scan/);
  assert.equal(by.pages.deploy, false);
  assert.equal(by.pages.reason, "up to date");
  assert.equal(by.web.deploy, true);
  assert.match(by.web.reason, /never deployed/);
});

test("decide: --force deploys unchanged units; a commit missing from history deploys", () => {
  const forced = decide([unit("events")], { live: { events: { sha: HEAD } }, head: HEAD, force: true, gitApi: fakeGit([]) });
  assert.equal(forced[0].deploy, true);
  const shallow = decide([unit("events")], { live: { events: { sha: OLD } }, head: HEAD, gitApi: fakeGit([], { has: false }) });
  assert.equal(shallow[0].deploy, true);
  assert.match(shallow[0].reason, /does not have/);
});

test("decide: Cargo.lock counts only where it reaches", () => {
  const locks = { [`${OLD}:Cargo.lock`]: lock("0.10.8"), [`${HEAD}:Cargo.lock`]: lock("0.10.9") };
  const units = [unit("events"), unit("webhooks")];
  const live = { events: { sha: OLD }, webhooks: { sha: OLD } };
  const decisions = decide(units, { live, head: HEAD, gitApi: fakeGit(["Cargo.lock"], { locks }) });
  assert.deepEqual(decisions.map((d) => [d.unit.id, d.deploy]), [["events", false], ["webhooks", true]]);
});

test("decide: the runner's image rebuilds only when what it is built from changed", () => {
  const live = { runner: { sha: OLD } };
  const code = decide([unit("runner")], { live, head: HEAD, gitApi: fakeGit(["services/runner/src/index.ts"]) });
  assert.deepEqual([code[0].deploy, code[0].image], [true, false]);
  const image = decide([unit("runner")], { live, head: HEAD, gitApi: fakeGit(["crates/runner/src/main.rs"]) });
  assert.deepEqual([image[0].deploy, image[0].image], [true, true]);
});

test("the plan as data: migrations, and each stage's units in jobs that share a build", () => {
  const units = ["events", "repos", "projects", "api", "web", "docs"].map(unit);
  const decisions = units.map((u) => ({ unit: u, deploy: true, reason: "x", since: null, image: false }));
  const data = planJson(stack, decisions, { events: { pending: ["0003_x.sql"] }, repos: { pending: [] } }, HEAD);
  assert.deepEqual(data.migrations, [{ unit: "events", database: "g1t-events", pending: ["0003_x.sql"] }]);
  assert.deepEqual(data.stages.core.jobs, [
    { group: "rust", units: "events,repos", rust: true },
    { group: "ts", units: "projects", rust: false },
  ]);
  assert.deepEqual(data.stages.edge.jobs, [{ group: "rust", units: "api", rust: true }]);
  assert.deepEqual(data.stages.front.jobs, [
    { group: "web", units: "web", rust: false },
    { group: "docs", units: "docs", rust: false },
  ]);
  assert.deepEqual(data.stage_order, ["core", "edge", "front"]);
  assert.deepEqual(buildGroups([]), []);
  // Ten Rust workers go to three jobs; a unit whose image rebuilds gets its own.
  const core = stack.units.filter((u) => u.stage === "core");
  const jobs = buildGroups(core, ["runner"]);
  assert.deepEqual(jobs.filter((j) => j.rust).map((j) => j.units.split(",").length), [4, 3, 3]);
  assert.ok(jobs.some((j) => j.group === "runner-image" && j.units === "runner"));
  assert.ok(!jobs.find((j) => j.group === "ts").units.includes("runner"));
});

test("units are picked by short name, folder or Worker name", () => {
  assert.deepEqual(pick(stack, ["billing,services/web".replace("services/web", "apps/web"), "g1t-api"]).map((u) => u.id), ["billing", "web", "api"]);
  assert.throws(() => pick(stack, ["nope"]), /No unit called nope/);
});

test("a CI job installs only what its units need", () => {
  const npm = npmWorkspace();
  assert.deepEqual(npmCiArgs([unit("events"), unit("repos")], npm), ["ci", "--no-audit", "--no-fund", "--workspaces=false"]);
  assert.deepEqual(npmCiArgs([unit("events"), unit("status")], npm), [
    "ci", "--no-audit", "--no-fund", "--include-workspace-root",
    "-w", "@g1t/contracts", "-w", "@g1t/status", "-w", "@g1t/theme",
  ]);
});

// ── Cloudflare's answers ──────────────────────────────────────────────────

const version = (id, number, message, triggered = "deployment") => ({
  id,
  number,
  metadata: { created_on: "2026-10-05T00:00:00Z", author_email: "a@b" },
  annotations: { "workers/triggered_by": triggered, ...(message ? { "workers/message": message } : {}) },
});

test("a deploy is annotated with its commit, and read back", () => {
  const { message, tag } = annotation(HEAD, "A subject ".repeat(20));
  assert.ok(message.length <= 100);
  assert.equal(commitFrom(message), HEAD);
  assert.equal(tag, `g1t-${HEAD.slice(0, 12)}`);
  assert.equal(commitFrom(message.replace("g1t-deploy", "g1t-deploy-dirty")), null);
  assert.equal(commitFrom("deployed by hand"), null);
});

test("the live commit: the live version's, looking through secret changes", () => {
  const versions = [version("v1", 1, annotation(OLD).message), version("v2", 2, null, "secret"), version("v3", 3, null, "version_upload")];
  const status = (id) => ({ versions: [{ version_id: id, percentage: 100 }] });
  assert.equal(liveCommit(status("v1"), versions).sha, OLD);
  assert.equal(liveCommit(status("v2"), versions).sha, OLD);
  assert.equal(liveCommit(status("v3"), versions).sha, null);
  assert.match(liveCommit(status("v9"), versions).why, /not among/);
  const split = liveCommit({ versions: [{ version_id: "v1", percentage: 10 }, { version_id: "v2", percentage: 90 }] }, versions);
  assert.equal(split.sha, OLD);
  assert.equal(split.split, true);
});

test("Wrangler's output: pending migrations and the version a deploy made", () => {
  const pending = `
 ⛅️ wrangler 4.146.0
Resource location: remote
Migrations to be applied:
┌──────────────────────┐
│ Name                 │
├──────────────────────┤
│ 0021_confidence.sql  │
├──────────────────────┤
│ 0022_more.sql        │
└──────────────────────┘`;
  assert.deepEqual(pendingFrom(pending), ["0021_confidence.sql", "0022_more.sql"]);
  assert.deepEqual(pendingFrom("Resource location: remote\n\n✅ No migrations to apply!"), []);
  assert.equal(versionFrom("Deployed g1t-events triggers\nCurrent Version ID: 2c7fc93a-82d9-4850-8a77-ba887d157a4f\n"), "2c7fc93a-82d9-4850-8a77-ba887d157a4f");
});

test("the pool runs everything, no more than its limit at once", async () => {
  let running = 0;
  let most = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(most, 3);
});

// ── Everything else that reads the list ───────────────────────────────────

test("self-hosting builds every Rust service the manifest says it runs", () => {
  const dockerfile = readFileSync(join(ROOT, "deploy/self-host/Dockerfile"), "utf8");
  const loops = [...dockerfile.matchAll(/for service in ([a-z ]+); do/g)].map((m) => m[1].trim().split(/\s+/).sort());
  const wanted = stack.units.filter((u) => u.self_host === "run" && u.kind === "rust-worker").map((u) => u.path.split("/").pop()).sort();
  assert.ok(loops.length >= 2);
  for (const loop of loops) assert.deepEqual(loop, wanted);
});

test("docs/SELF_HOSTING.md's table names every unit", () => {
  const doc = readFileSync(join(ROOT, "docs/SELF_HOSTING.md"), "utf8");
  for (const u of stack.units) assert.ok(doc.includes(`| \`${u.path}\` |`), `${u.path} is missing from docs/SELF_HOSTING.md`);
});

test("resolveStack works on a manifest with no workspace crates or packages", () => {
  const bare = resolveStack(loadStack(), { cargo: new Map(), npm: new Map() });
  assert.deepEqual(bare.units.find((u) => u.id === "events").dependsOn, []);
});
