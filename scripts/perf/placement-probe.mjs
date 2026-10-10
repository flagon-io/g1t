#!/usr/bin/env node
// Where should g1t's Workers run? A throwaway experiment that answers it
// with numbers, without touching any production Worker.
//
// It deploys a handful of tiny Workers named g1t-probe-*, one per
// placement setting, each bound read-only in practice (it runs only
// `SELECT 1`) to the g1t-repos D1 database, plus g1t-probe-edge, which runs
// near the caller and calls each of the others through a service binding,
// the way the site calls the services. Then it measures them from this
// machine, prints a table, and deletes them.
//
//   node scripts/perf/placement-probe.mjs deploy     # make the probes (needs `wrangler login`)
//   node scripts/perf/placement-probe.mjs measure    # 1 warm-up + 7 requests each, a table
//   node scripts/perf/placement-probe.mjs delete     # remove them all
//   node scripts/perf/placement-probe.mjs apply '{"region":"aws:us-west-1"}'
//                                                    # write a placement into every config that should have it
//   node scripts/perf/placement-probe.mjs apply '{"mode":"smart"}'   # back to Smart Placement
//
// Nothing here runs in CI.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT } from "../deploy/stack.mjs";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = { name: "g1t-repos", id: "f9544c51-c3bf-4621-a96f-8a6d5cf24a97" };

/** Each placement tried. Regions near D1's WNAM, one far one as a control. */
export const VARIANTS = [
  { name: "off", placement: { mode: "off" } },
  { name: "smart", placement: { mode: "smart" } },
  { name: "aws-us-west-1", placement: { region: "aws:us-west-1" } },
  { name: "aws-us-west-2", placement: { region: "aws:us-west-2" } },
  { name: "gcp-us-west1", placement: { region: "gcp:us-west1" } },
  { name: "gcp-us-west2", placement: { region: "gcp:us-west2" } },
  { name: "aws-us-east-1", placement: { region: "aws:us-east-1" } },
];

/**
 * The Workers that read D1 or call services that do, by config: what
 * `apply` sets the placement of. The rest (pages, models, og, runner,
 * status, docs) serve from the edge or have no data of their own.
 */
export const PLACED = [
  "apps/web/wrangler.jsonc",
  "apps/api/wrangler.jsonc",
  "apps/sudo/wrangler.jsonc",
  "services/actions/wrangler.jsonc",
  "services/billing/wrangler.jsonc",
  "services/context/wrangler.jsonc",
  "services/deployments/wrangler.jsonc",
  "services/events/wrangler.jsonc",
  "services/identity/wrangler.jsonc",
  "services/integrations/wrangler.jsonc",
  "services/projects/wrangler.jsonc",
  "services/repos/wrangler.jsonc",
  "services/search/wrangler.jsonc",
  "services/security/wrangler.jsonc",
  "services/webhooks/wrangler.jsonc",
  "services/work/wrangler.jsonc",
];

const PROBE = `
const QUERIES = 5;
async function ranIn() {
  const trace = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
  return /colo=(\\w+)/.exec(trace)?.[1] ?? null;
}
async function timedQueries(db) {
  const ms = [];
  let meta = null;
  for (let i = 0; i < QUERIES; i++) {
    const started = Date.now();
    const result = await db.prepare("SELECT 1 AS one").run();
    ms.push(Date.now() - started);
    meta = result.meta;
  }
  return { ms, region: meta?.served_by_region ?? null, primary: meta?.served_by_primary ?? null, sql_ms: meta?.timings?.sql_duration_ms ?? null };
}
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/chain") {
      const names = Object.keys(env).filter((key) => key.startsWith("TO_"));
      const out = {};
      await Promise.all(names.map(async (name) => {
        const started = Date.now();
        try {
          const answer = await (await env[name].fetch("https://probe/")).json();
          out[name.slice(3).toLowerCase().replaceAll("_", "-")] = { rpc_ms: Date.now() - started, ran_in: answer.ran_in, primary_ms: answer.primary.ms };
        } catch (error) {
          out[name] = { error: String(error) };
        }
      }));
      return Response.json({ worker: env.NAME, ingress: request.cf?.colo ?? null, ran_in: await ranIn(), chain: out });
    }
    const where = await ranIn();
    const primary = await timedQueries(env.DB);
    const session = await timedQueries(env.DB.withSession("first-unconstrained"));
    return Response.json({ worker: env.NAME, ingress: request.cf?.colo ?? null, ran_in: where, primary, session });
  },
};
`;

function configFor(variant, bindings = []) {
  return {
    name: `g1t-probe-${variant.name}`,
    main: "worker.js",
    account_id: "1e6f2cffa3f445920836e8ebe446bb58",
    compatibility_date: "2026-09-26",
    workers_dev: true,
    preview_urls: false,
    placement: variant.placement,
    vars: { NAME: variant.name },
    d1_databases: [{ binding: "DB", database_name: DATABASE.name, database_id: DATABASE.id }],
    services: bindings,
  };
}

async function wrangler(args, cwd) {
  const { code, out } = await exec(process.execPath, [WRANGLER, ...args], { cwd, env: wranglerEnv() });
  return { code, out };
}

const URLS = join(tmpdir(), "g1t-placement-probe", "urls.json");

async function deploy() {
  const urls = {};
  const edge = { name: "edge", placement: { mode: "off" } };
  const bindings = VARIANTS.map((v) => ({ binding: `TO_${v.name.toUpperCase().replaceAll("-", "_")}`, service: `g1t-probe-${v.name}` }));
  for (const [variant, extra] of [...VARIANTS.map((v) => [v, []]), [edge, bindings]]) {
    const dir = join(tmpdir(), "g1t-placement-probe", variant.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.js"), PROBE);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(configFor(variant, extra), null, 2));
    process.stdout.write(`deploying g1t-probe-${variant.name} ${JSON.stringify(variant.placement)} … `);
    const { code, out } = await wrangler(["deploy", "--config", "wrangler.json"], dir);
    const url = /https:\/\/g1t-probe-[\w-]+\.[\w-]+\.workers\.dev/.exec(out)?.[0];
    console.log(code === 0 ? url ?? "deployed (no URL printed)" : "FAILED");
    if (code !== 0) console.log(out.split("\n").slice(-15).join("\n"));
    if (url) urls[variant.name] = url;
  }
  writeFileSync(URLS, JSON.stringify(urls, null, 2));
  console.log("\nSmart Placement needs traffic from several places and up to 15 minutes before it moves anything;");
  console.log("the region variants are placed at once. Wait a minute, then: node scripts/perf/placement-probe.mjs measure");
}

const median = (values) => {
  const sorted = [...values].filter((v) => typeof v === "number").sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

async function timedFetch(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const ttfb = performance.now() - started;
  const body = await response.json();
  return { ttfb: Math.round(ttfb), placement: response.headers.get("cf-placement"), body };
}

async function measure() {
  const urls = JSON.parse(readFileSync(URLS, "utf8"));
  const rows = [];
  for (const variant of VARIANTS) {
    const url = urls[variant.name];
    if (!url) continue;
    await timedFetch(url).catch(() => null);
    const runs = [];
    for (let i = 0; i < 7; i++) runs.push(await timedFetch(url));
    const last = runs.at(-1);
    rows.push({
      variant: variant.name,
      "cf-placement": last.placement ?? "",
      "ran in": last.body.ran_in,
      "ttfb ms (p50)": median(runs.map((r) => r.ttfb)),
      "D1 primary ms/query (p50)": median(runs.flatMap((r) => r.body.primary.ms)),
      "D1 session ms/query (p50)": median(runs.flatMap((r) => r.body.session.ms)),
      "session served by": `${last.body.session.region ?? "?"}${last.body.session.primary ? " (primary)" : ""}`,
    });
  }
  console.table(rows);
  if (urls.edge) {
    await timedFetch(`${urls.edge}/chain`).catch(() => null);
    const chains = [];
    for (let i = 0; i < 5; i++) chains.push(await timedFetch(`${urls.edge}/chain`));
    const names = Object.keys(chains[0].body.chain);
    console.log(`\nFrom g1t-probe-edge (runs in ${chains[0].body.ran_in}) through a service binding, as the site calls a service:`);
    console.table(
      names.map((name) => ({
        target: name,
        "target ran in": chains.at(-1).body.chain[name].ran_in,
        "rpc ms (p50)": median(chains.map((c) => c.body.chain[name].rpc_ms)),
        "its D1 ms/query (p50)": median(chains.flatMap((c) => c.body.chain[name].primary_ms ?? [])),
      })),
    );
  }
  console.log("\nPick the region with the lowest D1 primary ms/query (the database's neighbour), then:");
  console.log(`  node scripts/perf/placement-probe.mjs apply '{"region":"<it>"}'`);
}

async function remove() {
  for (const name of [...VARIANTS.map((v) => v.name), "edge"]) {
    const { code } = await wrangler(["delete", "--name", `g1t-probe-${name}`, "--force"], ROOT);
    console.log(`g1t-probe-${name}: ${code === 0 ? "deleted" : "not deleted (already gone?)"}`);
  }
}

/** Sets `"placement"` in every config in PLACED, keeping the line's place. */
export function withPlacement(text, placement) {
  const fields = Object.entries(placement).map(([key, value]) => `"${key}": ${JSON.stringify(value)}`);
  const line = `"placement": { ${fields.join(", ")} },`;
  if (/"placement":\s*\{[^}]*\},?/.test(text)) return text.replace(/"placement":\s*\{[^}]*\},?/, line);
  return text.replace(/(\r?\n)([ \t]*)("compatibility_date":[^\r\n]*)/, (_, nl, indent, date) => `${nl}${indent}${date}${nl}${indent}${line}`);
}

function apply(json) {
  const placement = JSON.parse(json);
  for (const file of PLACED) {
    const path = join(ROOT, file);
    const before = readFileSync(path, "utf8");
    const after = withPlacement(before, placement);
    if (after !== before) writeFileSync(path, after);
    console.log(`${file}: ${after === before ? "unchanged" : JSON.stringify(placement)}`);
  }
}

const [command, argument] = process.argv.slice(2);
if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/perf/placement-probe.mjs")) {
  if (command === "deploy") await deploy();
  else if (command === "measure") await measure();
  else if (command === "delete") await remove();
  else if (command === "apply" && argument) apply(argument);
  else {
    console.log("usage: node scripts/perf/placement-probe.mjs deploy | measure | delete | apply '<placement json>'");
    process.exitCode = 1;
  }
}
