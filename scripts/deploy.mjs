#!/usr/bin/env node
// Deploys g1t to Cloudflare from deploy/stack.jsonc: only what changed since
// each Worker's live commit, migrations first, then stage by stage.
// docs/DEPLOYING.md is the guide.
//
//   node scripts/deploy.mjs plan                  what would deploy, and why (read-only)
//   node scripts/deploy.mjs deploy                migrations, then every changed unit
//   node scripts/deploy.mjs deploy --only web,api just these (if changed; --force: anyway)
//   node scripts/deploy.mjs build --only events   build as a deploy would, upload nothing
//   node scripts/deploy.mjs migrate               pending D1 migrations only
//   node scripts/deploy.mjs manifest [--check]    the resolved manifest, or its problems
//   node scripts/deploy.mjs doctor                which units lack their secrets
//   node scripts/deploy.mjs install --only a,b    npm ci of just what those units need (CI)
//
// Flags: --all (every unit, changed or not), --only a,b, --skip a,b,
// --force, --concurrency N (default 4), --stage core (one stage),
// --json (plan), --out FILE (plan), --no-migrations, --allow-dirty,
// --rebuild-image, --since REV (Workers with no recorded commit are taken
// to run REV).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkerBuild } from "./build-rust-worker.mjs";
import {
  annotation,
  applyMigrations,
  dockerAvailable,
  exec,
  jsonFrom,
  lastLines,
  pendingMigrations,
  readLive,
  versionFrom,
  wrangler,
  wranglerEnv,
} from "./deploy/cloudflare.mjs";
import { decide, git, planJson, pool, table } from "./deploy/plan.mjs";
import { ROOT, byStage, codeStages, findWranglerConfigs, npmCiArgs, npmWorkspace, pick, problems, resolvedStack } from "./deploy/stack.mjs";

const USAGE = "usage: node scripts/deploy.mjs plan|deploy|build|migrate|manifest|doctor [--all] [--only a,b] [--skip a,b] [--force] [--concurrency N] [--stage S] [--json]";

function parseArgs(argv) {
  const opts = { command: argv[0], only: [], skip: [], concurrency: 4, force: false, all: false, json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--only") opts.only.push(value());
    else if (flag === "--skip") opts.skip.push(value());
    else if (flag === "--concurrency") opts.concurrency = Number(value());
    else if (flag === "--stage") opts.stage = value();
    else if (flag === "--all") opts.all = true;
    else if (flag === "--force") opts.force = true;
    else if (flag === "--json") opts.json = true;
    else if (flag === "--check") opts.check = true;
    else if (flag === "--no-migrations") opts.noMigrations = true;
    else if (flag === "--allow-dirty") opts.allowDirty = true;
    else if (flag === "--rebuild-image") opts.rebuildImage = true;
    else if (flag === "--out") opts.out = value();
    else if (flag === "--since") opts.since = value();
    else if (flag === "--github-output") opts.githubOutput = true;
    else throw new Error(`unknown flag ${arg}\n${USAGE}`);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error("--concurrency is a whole number, 1 or more");
  return opts;
}

/** The units a command works on: --only (or all), less --skip, in --stage. */
function selected(stack, opts) {
  let units = opts.only.length ? pick(stack, opts.only) : [...stack.units];
  const skipped = pick(stack, opts.skip);
  units = units.filter((u) => !skipped.includes(u));
  if (opts.stage) {
    if (!codeStages(stack).includes(opts.stage)) throw new Error(`--stage is one of ${codeStages(stack).join(", ")}`);
    units = units.filter((u) => u.stage === opts.stage);
  }
  // Manifest order, whatever order they were named in.
  return stack.units.filter((u) => units.includes(u));
}

const log = (...args) => console.error(...args);

/**
 * The plan for a workflow (.g1t/workflows/deploy.yml): job outputs in
 * $GITHUB_OUTPUT, and the plan as a table in $GITHUB_STEP_SUMMARY.
 */
function writeGithubOutputs(data, p) {
  const lines = [
    `commit=${data.commit}`,
    `migrate=${data.migrations.length > 0}`,
    `migrate_units=${data.migrations.map((m) => m.unit).join(",")}`,
    `deploying=${data.units.filter((u) => u.deploy).map((u) => u.unit).join(",")}`,
  ];
  for (const [stage, { jobs }] of Object.entries(data.stages)) {
    // A matrix needs one entry; an empty stage's job is skipped by its `if`.
    const include = jobs.length ? jobs : [{ group: "none", units: "" }];
    lines.push(`has_${stage}=${jobs.length > 0}`, `${stage}=${JSON.stringify({ include })}`);
  }
  if (data.migration_errors.length) throw new Error(`Could not read pending migrations: ${data.migration_errors.map((e) => e.unit).join(", ")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = p.decisions.map((d) => `| ${d.unit.id} | ${d.unit.stage} | ${d.deploy ? "deploy" : ""} | ${d.since ? d.since.slice(0, 12) : "?"} | ${d.reason.replaceAll("|", "\\|")} |`);
    const pending = data.migrations.map((m) => `- ${m.database}: ${m.pending.join(", ")}`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`## Deploy plan for ${data.commit.slice(0, 12)}`, "", "| unit | stage | action | live | why |", "| --- | --- | --- | --- | --- |", ...rows, "", pending.length ? "### Pending migrations" : "", ...pending, ""].join("\n"),
    );
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Reads what each unit runs and what its database is waiting for. */
async function survey(units, opts) {
  const live = {};
  const migrations = {};
  const tasks = [
    ...(opts.noLive ? [] : units).map((unit) => async () => {
      live[unit.id] = await readLive(unit);
    }),
    ...(opts.noMigrations ? [] : units.filter((u) => u.d1)).map((unit) => async () => {
      migrations[unit.id] = await pendingMigrations(unit);
    }),
  ];
  await pool(tasks, Math.max(8, opts.concurrency * 2), (task) => task());
  return { live, migrations };
}

async function plan(stack, opts) {
  const units = selected(stack, opts);
  const head = git.head();
  const { live, migrations } = await survey(units, opts);
  // --since: what a Worker with no recorded commit is taken to run (once,
  // to adopt Workers deployed before this tool), for example --since HEAD~3.
  if (opts.since) {
    const since = git.resolve(opts.since);
    for (const unit of units) {
      const found = live[unit.id];
      if (found && !found.sha && !found.missing && !found.error) live[unit.id] = { ...found, sha: since, assumed: true };
    }
  }
  const decisions = decide(units, { live, head, force: opts.force || opts.all });
  return { head, units, live, migrations, decisions };
}

function buildPlan(stack, opts) {
  const units = selected(stack, opts);
  return {
    head: git.head(),
    units,
    live: {},
    migrations: {},
    decisions: units.map((unit) => ({ unit, deploy: true, reason: "build", since: null, files: [], image: false })),
  };
}

function printPlan(stack, { head, decisions, migrations, live }) {
  console.log(`Deploying ${head.slice(0, 12)} (${git.subject()})\n`);
  const rows = decisions.map((d) => [
    d.unit.id,
    d.unit.stage,
    d.deploy ? "deploy" : "-",
    d.since ? d.since.slice(0, 12) + (live[d.unit.id]?.assumed ? "*" : "") : "?",
    d.unit.d1 ? (migrations[d.unit.id]?.error ? "error" : String(migrations[d.unit.id]?.pending?.length ?? "-")) : "",
    d.reason + (d.image ? "; image rebuilds" : ""),
  ]);
  console.log(table(rows, ["unit", "stage", "action", "live", "migrations", "why"]));
  if (decisions.some((d) => live[d.unit.id]?.assumed)) console.log("* taken from --since: no commit was recorded for it");
  const pending = Object.entries(migrations).filter(([, m]) => m.pending?.length);
  if (pending.length) {
    console.log("\nPending migrations:");
    for (const [id, m] of pending) console.log(`  ${stack.units.find((u) => u.id === id).d1.database}: ${m.pending.join(", ")}`);
  }
  for (const [id, m] of Object.entries(migrations).filter(([, m]) => m.error)) {
    console.log(`\nCould not list ${id}'s migrations:\n${m.error}`);
  }
  const deploying = decisions.filter((d) => d.deploy).map((d) => d.unit);
  console.log(
    deploying.length
      ? `\n${deploying.length} to deploy: ${byStage(stack, deploying).map((g) => `${g.stage} (${g.units.map((u) => u.id).join(", ")})`).join(" -> ")}`
      : "\nNothing to deploy.",
  );
}

/** Output of one unit, prefixed, to the terminal and a log file. */
function unitLogger(id) {
  const dir = join(tmpdir(), "g1t-deploy");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.log`);
  const lines = [];
  return {
    file,
    line: (text) => {
      lines.push(text);
      if (text.trim()) log(`[${id}] ${text}`);
    },
    save: () => writeFileSync(file, `${lines.join("\n")}\n`),
  };
}

/** Builds (and unless `dryRun`, deploys) one unit. */
async function ship(unit, decision, { head, subject, dirty, dryRun, docker, rebuildImage }) {
  const started = Date.now();
  const out = unitLogger(unit.id);
  const cwd = join(ROOT, unit.path);
  const result = { unit: unit.id, stage: unit.stage, ok: false, version: null, ms: 0, note: "" };
  try {
    if (unit.kind === "react-router" || unit.kind === "astro") {
      const built = await exec("npm", ["run", "build"], { cwd, onLine: out.line, shell: true, env: wranglerEnv() });
      if (built.code !== 0) throw new Error(`npm run build failed:\n${lastLines(built.out)}`);
    }
    const args = ["deploy"];
    if (dryRun) {
      args.push("--dry-run", "--outdir", join(tmpdir(), "g1t-deploy", "dist", unit.id));
    } else {
      const { message, tag } = annotation(head, subject);
      args.push("--message", dirty ? message.replace(/^g1t-deploy/, "g1t-deploy-dirty") : message, "--tag", tag);
    }
    if (unit.image) {
      const build = rebuildImage || decision.image;
      if (!build) {
        args.push("--containers-rollout", "none");
        result.note = "image unchanged: not rebuilt";
      } else if (!docker) {
        throw new Error(
          "its Containers image changed, and Docker is not available here. Deploy it from a machine with Docker: node scripts/deploy.mjs deploy --only " +
            unit.id,
        );
      } else {
        result.note = "image rebuilt";
      }
    }
    const deployed = await wrangler(args, { cwd, onLine: out.line });
    if (deployed.code !== 0) throw new Error(`wrangler deploy failed:\n${lastLines(deployed.out)}`);
    result.version = dryRun ? "(dry run)" : versionFrom(deployed.out);
    result.ok = true;
  } catch (error) {
    result.note = String(error.message ?? error);
  }
  result.ms = Date.now() - started;
  out.save();
  if (!result.ok) result.note += `\n  full log: ${out.file}`;
  return result;
}

async function migrate(stack, units, migrations, opts) {
  const due = units.filter((u) => migrations[u.id]?.pending?.length);
  const broken = units.filter((u) => migrations[u.id]?.error);
  if (broken.length) {
    throw new Error(`Could not read pending migrations for ${broken.map((u) => u.id).join(", ")}; nothing was deployed.`);
  }
  if (!due.length) return [];
  log(`== migrations: ${due.map((u) => `${u.d1.database} (${migrations[u.id].pending.length})`).join(", ")}`);
  const results = await pool(due, opts.concurrency, async (unit) => {
    const started = Date.now();
    const out = unitLogger(`${unit.id}-migrations`);
    const applied = await applyMigrations(unit, out.line);
    out.save();
    return {
      unit: `${unit.id} (D1 ${unit.d1.database})`,
      stage: "migrations",
      ok: applied.code === 0,
      version: `${migrations[unit.id].pending.length} applied`,
      ms: Date.now() - started,
      note: applied.code === 0 ? "" : `${lastLines(applied.out)}\n  full log: ${out.file}`,
    };
  });
  return results;
}

function summary(results) {
  const rows = results.map((r) => [r.unit, r.stage, r.ok ? "ok" : r.skipped ? "not started" : "FAILED", r.version ?? "", r.ms ? seconds(r.ms) : "", r.note.split("\n")[0]]);
  console.log(`\n${table(rows, ["unit", "stage", "result", "version", "time", "note"])}`);
  for (const r of results.filter((r) => !r.ok && !r.skipped)) console.log(`\n${r.unit}: ${r.note}`);
}

async function deploy(stack, opts, { dryRun = false } = {}) {
  const started = Date.now();
  // A build reads nothing from Cloudflare: it builds what it is given.
  const p = dryRun ? buildPlan(stack, opts) : await plan(stack, opts);
  if (!dryRun) printPlan(stack, p);
  const deploying = p.decisions.filter((d) => d.deploy);
  const touched = deploying.map((d) => d.unit);
  const head = p.head;

  // A deploy names the commit it came from, so a dirty tree would be
  // recorded as something it is not.
  const dirtyFiles = git.dirty();
  const dirty = deploying.some((d) => dirtyFiles.some((file) => file.startsWith(`${d.unit.path}/`) || d.unit.dependsOn.some((dir) => file.startsWith(`${dir}/`)) || d.unit.inputs.includes(file)));
  if (dirty && !dryRun && !opts.allowDirty) {
    throw new Error("Uncommitted changes touch what would deploy. Commit them, or pass --allow-dirty (the deploy then records no commit, and the next plan deploys it again).");
  }

  const results = [];
  if (!dryRun && !opts.noMigrations) {
    const migrated = await migrate(stack, p.units, p.migrations, opts);
    results.push(...migrated);
    if (migrated.some((r) => !r.ok)) {
      summary(results);
      return false;
    }
  }
  if (!touched.length) {
    if (results.length) summary(results);
    return true;
  }

  if (touched.some((u) => u.kind === "rust-worker")) ensureWorkerBuild();
  const docker = touched.some((u) => u.image) ? await dockerAvailable() : false;
  const context = { head, subject: git.subject(), dirty, dryRun, docker, rebuildImage: opts.rebuildImage };

  let failed = false;
  for (const { stage, units } of byStage(stack, touched)) {
    if (failed) {
      for (const unit of units) results.push({ unit: unit.id, stage, ok: false, skipped: true, ms: 0, note: "an earlier stage failed" });
      continue;
    }
    log(`== ${stage}: ${units.map((u) => u.id).join(", ")}`);
    const shipped = await pool(units, opts.concurrency, (unit) => ship(unit, deploying.find((d) => d.unit === unit), context));
    results.push(...shipped);
    failed = shipped.some((r) => !r.ok);
  }
  summary(results);
  console.log(`\n${failed ? "Failed" : dryRun ? "Built" : "Deployed"} in ${seconds(Date.now() - started)}.`);
  return !failed;
}

async function doctor(stack, opts) {
  const units = selected(stack, opts);
  const rows = await pool(units, 8, async (unit) => {
    if (!unit.secrets.length) return [unit.id, "", "", ""];
    const found = await wrangler(["secret", "list", "--name", unit.worker, "--format", "json"], { cwd: join(ROOT, unit.path) });
    if (found.code !== 0) return [unit.id, unit.secrets.join(" "), "?", "could not read"];
    const have = new Set(jsonFrom(found.out).map((s) => s.name));
    const missing = unit.secrets.filter((name) => !have.has(name));
    return [unit.id, unit.secrets.join(" "), missing.join(" "), missing.length ? "missing" : "ok"];
  });
  console.log(table(rows, ["unit", "secrets", "missing", "result"]));
  return rows.every((r) => r[3] !== "missing");
}

async function install(stack, opts) {
  const units = selected(stack, opts);
  const args = npmCiArgs(units, npmWorkspace());
  log(`npm ${args.join(" ")}`);
  const done = await exec("npm", args, { cwd: ROOT, shell: true, onLine: (line) => log(line) });
  return done.code === 0;
}

function manifest(stack, opts) {
  const found = problems(stack, findWranglerConfigs());
  if (opts.check) {
    for (const problem of found) console.log(`- ${problem}`);
    console.log(found.length ? `\n${found.length} problems in deploy/stack.jsonc.` : "deploy/stack.jsonc is consistent with every wrangler.jsonc.");
    return !found.length;
  }
  const out = stack.units.map(({ config, ...unit }) => ({
    ...unit,
    queues: { produces: (config?.queues?.producers ?? []).map((q) => q.queue), consumes: (config?.queues?.consumers ?? []).map((q) => q.queue) },
    kv: (config?.kv_namespaces ?? []).map((kv) => stack.resources.kv?.[kv.id] ?? kv.id),
    r2: (config?.r2_buckets ?? []).map((b) => b.bucket_name),
    vectorize: (config?.vectorize ?? []).map((v) => v.index_name),
    dispatch_namespaces: (config?.dispatch_namespaces ?? []).map((d) => d.namespace),
    routes: (config?.routes ?? []).map((r) => r.pattern),
  }));
  if (opts.json) console.log(JSON.stringify({ stages: stack.stages, units: out }, null, 2));
  else
    console.log(
      table(
        out.map((u) => [u.id, u.stage, u.kind, u.worker, u.d1?.database ?? "", u.dependsOn.join(" ")]),
        ["unit", "stage", "kind", "worker", "d1", "built from (besides its folder)"],
      ),
    );
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stack = resolvedStack();
  switch (opts.command) {
    case "plan": {
      const p = await plan(stack, opts);
      const data = planJson(stack, p.decisions, p.migrations, p.head);
      if (opts.out) writeFileSync(opts.out, `${JSON.stringify(data)}\n`);
      if (opts.githubOutput) writeGithubOutputs(data, p);
      if (opts.json) console.log(JSON.stringify(data, null, 2));
      else if (!opts.githubOutput || process.env.GITHUB_OUTPUT) printPlan(stack, p);
      return true;
    }
    case "deploy":
      return deploy(stack, opts);
    case "build":
      return deploy(stack, { ...opts, force: true }, { dryRun: true });
    case "migrate": {
      const units = selected(stack, opts);
      const { migrations } = await survey(units.filter((u) => u.d1), { ...opts, noMigrations: false, noLive: true });
      const results = await migrate(stack, units, migrations, opts);
      if (results.length) summary(results);
      else console.log("No migrations to apply.");
      return results.every((r) => r.ok);
    }
    case "manifest":
      return manifest(stack, opts);
    case "doctor":
      return doctor(stack, opts);
    case "install":
      return install(stack, opts);
    default:
      console.error(USAGE);
      return false;
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(`\n${error.message ?? error}`);
    process.exit(1);
  },
);
