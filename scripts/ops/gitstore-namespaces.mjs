#!/usr/bin/env node
// How each git store namespace stands: what it
// holds, how busy its busiest minute was against Cloudflare's limit of
// 2,000 control-plane requests per 10 seconds, how it has been failing,
// whether it takes new repositories, and its limits. Also queues and lists
// moves of repositories between namespaces (services/repos/src/moves.rs).
//
//   node scripts/ops/gitstore-namespaces.mjs                 # the report, as a table
//   node scripts/ops/gitstore-namespaces.mjs --json          # the same, as JSON
//   node scripts/ops/gitstore-namespaces.mjs --cloudflare    # with Cloudflare's own event counts per namespace
//   node scripts/ops/gitstore-namespaces.mjs moves           # moves asked for, newest first
//   node scripts/ops/gitstore-namespaces.mjs move acme/rocket g1t-us-1   # queue one; the hourly sweep runs it
//
// The report and `moves` are read-only: SELECTs against the g1t-repos
// database through Wrangler (as you are logged in, or CLOUDFLARE_D1_TOKEN),
// and with --cloudflare one GraphQL query (CLOUDFLARE_API_TOKEN with Account
// Analytics: Read). `move` inserts one row into repo_moves, nothing else.
// What is configured is read from services/repos/wrangler.jsonc, so the
// report says what the next deploy will do.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNT_ID, cloudflareAuth, exec, jsonFrom, wranglerEnv } from "../deploy/cloudflare.mjs";
import { ROOT, parseJsonc } from "../deploy/stack.mjs";

const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "g1t-repos";
/** Cloudflare's control-plane limit for one namespace, per minute (shards.rs). */
export const LIMIT_PER_MINUTE = 12_000;
/** Past this share of it, the repos service stops placing new repositories there. */
export const HOT_SHARE = 0.7;

/** What services/repos/wrangler.jsonc configures: each namespace, its binding and jurisdiction, and the placement variables. */
export function configured(wrangler) {
  const vars = wrangler.vars ?? {};
  let named = {};
  try {
    named = JSON.parse(vars.GITSTORE_NAMESPACES ?? "{}");
  } catch {}
  const bindings = new Map((wrangler.artifacts ?? []).map((one) => [one.binding, one]));
  if (!named.GITSTORE) named.GITSTORE = "g1t";
  let limits = {};
  try {
    limits = JSON.parse(vars.GITSTORE_NAMESPACE_LIMITS ?? "{}");
  } catch {}
  const newRepos = String(vars.GITSTORE_NEW_REPOS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const eu = vars.GITSTORE_EU_NAMESPACE?.trim() || null;
  return Object.entries(named).map(([binding, namespace]) => ({
    namespace,
    binding,
    bound: bindings.has(binding) && bindings.get(binding).namespace === namespace,
    // Set when the namespace is made, not in the binding: known with --cloudflare.
    jurisdiction: null,
    default: binding === "GITSTORE",
    eu: eu === namespace,
    takes_new_repos: newRepos.includes(namespace),
    max_repos: limits[namespace]?.max_repos ?? null,
  }));
}

/** A store key's namespace, as the registry keeps it: none means the default. */
export function namespaceOf(store, defaultNamespace = "g1t") {
  const at = (store ?? "").indexOf("/");
  return at > 0 ? store.slice(0, at) : defaultNamespace;
}

/**
 * Every namespace's standing, from what is configured, what the registry
 * holds (`held`: ns, repos, forks, stored_bytes), how it answered
 * (`health`: store, peak, calls, errors, rate_limited, rejected, the last
 * hour and the last day), Cloudflare's own counts (`events`) and the
 * namespaces Cloudflare has (`made`: namespace, jurisdiction), when asked.
 */
export function standings(config, held, health, events = [], made = null) {
  const defaultNamespace = config.find((one) => one.default)?.namespace ?? "g1t";
  const names = [...new Set([...config.map((one) => one.namespace), ...held.map((row) => row.ns || defaultNamespace)])];
  return names.map((namespace) => {
    const known = made?.find((one) => one.namespace === namespace);
    const set = { ...(config.find((one) => one.namespace === namespace) ?? { namespace, binding: null, bound: false }) };
    if (known) set.jurisdiction = known.jurisdiction ?? "any";
    const holds = held.filter((row) => (row.ns || defaultNamespace) === namespace);
    const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
    const hour = health.find((row) => row.store === namespace && row.window === "hour") ?? {};
    const day = health.find((row) => row.store === namespace && row.window === "day") ?? {};
    const fallback = health.find((row) => row.store === `${namespace}@fallback` && row.window === "hour");
    const peak = Number(day.peak ?? 0);
    const repos = sum(holds, "repos");
    const warnings = [];
    if (!set.bound && repos > 0) warnings.push("holds repositories but is not bound");
    if (set.takes_new_repos && !set.bound) warnings.push("named in GITSTORE_NEW_REPOS but not bound: passed over");
    if (peak >= LIMIT_PER_MINUTE * HOT_SHARE) warnings.push(`busiest minute at ${Math.round((peak / LIMIT_PER_MINUTE) * 100)}% of the limit`);
    if (set.max_repos && repos >= set.max_repos) warnings.push("at its max_repos: takes no new repositories while another can");
    if (Number(hour.rate_limited ?? 0) > 0) warnings.push(`${hour.rate_limited} calls rate limited in the last hour`);
    if (made && set.binding && !known) warnings.push("named in GITSTORE_NAMESPACES, but Cloudflare has no namespace of this name: make it before deploying");
    if (set.eu && known && known.jurisdiction !== "eu") warnings.push(`named as the EU namespace, but Cloudflare says its jurisdiction is ${known.jurisdiction ?? "unrestricted"}`);
    if (fallback) warnings.push(`served from the fallback store lately (${fallback.calls} calls in the last hour)`);
    return {
      ...set,
      repos,
      forks: sum(holds, "forks"),
      stored_bytes: sum(holds, "stored_bytes"),
      peak_per_minute_day: peak,
      peak_per_minute_hour: Number(hour.peak ?? 0),
      peak_share: peak / LIMIT_PER_MINUTE,
      calls_day: Number(day.calls ?? 0),
      errors_day: Number(day.errors ?? 0),
      rate_limited_day: Number(day.rate_limited ?? 0),
      rejected_day: Number(day.rejected ?? 0),
      cloudflare_events: events.filter((event) => event.namespace === namespace).reduce((total, event) => total + event.count, 0),
      warnings,
    };
  });
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const pct = (share) => `${(share * 100).toFixed(1)}%`;

export function table(rows) {
  const header = ["namespace", "binding", "where", "new", "repos", "forks", "stored", "peak/min (24h)", "of limit", "calls 24h", "errors", "429s"];
  const lines = rows.map((row) => [
    row.namespace + (row.default ? " *" : ""),
    row.bound ? row.binding : `${row.binding ?? "-"} (not bound)`,
    row.jurisdiction ?? "?",
    row.takes_new_repos ? "yes" : row.eu ? "eu" : "no",
    String(row.repos),
    String(row.forks),
    gb(row.stored_bytes),
    String(row.peak_per_minute_day),
    pct(row.peak_share),
    String(row.calls_day),
    String(row.errors_day),
    String(row.rate_limited_day),
  ]);
  const widths = header.map((title, at) => Math.max(title.length, ...lines.map((line) => line[at].length)));
  const format = (line) => line.map((cell, at) => cell.padEnd(widths[at])).join("  ");
  const out = [format(header), format(widths.map((width) => "-".repeat(width))), ...lines.map(format)];
  for (const row of rows) for (const warning of row.warnings) out.push(`! ${row.namespace}: ${warning}`);
  out.push("* the default namespace: keys without a namespace are in it. Limit: 12,000 control-plane requests a minute per namespace.");
  return out.join("\n");
}

// ---------------------------------------------------------------------

async function d1(sql) {
  const env = { ...wranglerEnv({ ...process.env, CI: "true" }) };
  if (process.env.CLOUDFLARE_D1_TOKEN) env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_D1_TOKEN;
  const { code, out } = await exec(process.execPath, [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
    cwd: join(ROOT, "services/repos"),
    env,
  });
  if (code !== 0) throw new Error(out.slice(-600));
  return jsonFrom(out)[0]?.results ?? [];
}

const quoted = (text) => `'${String(text).replaceAll("'", "''")}'`;
const minuteAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16);

async function readHeld() {
  return d1(`SELECT CASE WHEN instr(coalesce(store, ''), '/') > 0 THEN substr(store, 1, instr(store, '/') - 1) ELSE '' END AS ns,
      count(*) AS repos, sum(CASE WHEN fork_of IS NULL THEN 0 ELSE 1 END) AS forks, sum(coalesce(stored_bytes, 0)) AS stored_bytes
    FROM repos WHERE deleted_at IS NULL AND retired_at IS NULL GROUP BY ns`);
}

async function readHealth() {
  const window = (name, minutes) =>
    `SELECT '${name}' AS window, store, max(calls) AS peak, sum(calls) AS calls, sum(errors) AS errors,
       sum(rate_limited) AS rate_limited, sum(rejected) AS rejected
     FROM store_health WHERE minute >= '${minuteAgo(minutes)}' GROUP BY store`;
  return d1(`${window("hour", 60)} UNION ALL ${window("day", 24 * 60)}`);
}

async function readEvents() {
  const auth = cloudflareAuth();
  if (!auth) throw new Error("--cloudflare needs CLOUDFLARE_API_TOKEN with Account Analytics: Read");
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const query = `query Q($accountTag: String!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) {
    artifactsEventsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { repositoryNamespace } } } } }`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: ACCOUNT_ID, start: start.toISOString(), end: end.toISOString() } }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return (body.data?.viewer?.accounts?.[0]?.artifactsEventsAdaptiveGroups ?? []).map((group) => ({
    namespace: group.dimensions.repositoryNamespace,
    count: group.count,
  }));
}

/** The namespaces Cloudflare has, with their jurisdictions (CLOUDFLARE_API_TOKEN with Artifacts: Read). */
async function readNamespaces() {
  const auth = cloudflareAuth();
  if (!auth) throw new Error("--cloudflare needs CLOUDFLARE_API_TOKEN");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces`, { headers: auth });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`listing namespaces: ${response.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  const list = Array.isArray(body.result) ? body.result : (body.result?.namespaces ?? []);
  return list.map((one) => ({ namespace: one.namespace ?? one.name, jurisdiction: one.jurisdiction ?? null }));
}

function wranglerConfig() {
  return parseJsonc(readFileSync(join(ROOT, "services/repos/wrangler.jsonc"), "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "report";

  if (command === "moves") {
    const rows = await d1(`SELECT m.*, r.namespace AS workspace, r.name FROM repo_moves m LEFT JOIN repos r ON r.id = m.repo_id
      ORDER BY m.queued_ms DESC LIMIT 50`);
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.id}  ${row.status.padEnd(8)}  ${row.workspace}/${row.name} -> ${row.to_namespace}${row.note ? `  (${row.note})` : ""}`);
    return 0;
  }

  if (command === "move") {
    const [path, namespace] = args.slice(1);
    const [workspace, name] = String(path ?? "").toLowerCase().split("/");
    if (!workspace || !name || !namespace) throw new Error("usage: move <workspace/name> <namespace>");
    const config = configured(wranglerConfig());
    if (!config.some((one) => one.namespace === namespace && one.bound)) throw new Error(`${namespace} is not a bound namespace in services/repos/wrangler.jsonc`);
    const [repo] = await d1(`SELECT id, store FROM repos WHERE namespace = ${quoted(workspace)} AND name = ${quoted(name)} AND deleted_at IS NULL AND fork_of IS NULL`);
    if (!repo) throw new Error(`no repository ${workspace}/${name}`);
    if (namespaceOf(repo.store, config.find((one) => one.default)?.namespace) === namespace) throw new Error(`${workspace}/${name} is in ${namespace} already`);
    const id = `mov_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await d1(`INSERT INTO repo_moves (id, repo_id, to_namespace, status, requested_by, queued_ms)
      VALUES (${quoted(id)}, ${quoted(repo.id)}, ${quoted(namespace)}, 'queued', 'scripts/ops/gitstore-namespaces.mjs', ${Date.now()})`);
    console.log(`queued ${id}: ${workspace}/${name} (${repo.store}) -> ${namespace}. The hourly sweep (:23) moves it; watch with \`moves\`.`);
    return 0;
  }

  const config = configured(wranglerConfig());
  const cloudflare = args.includes("--cloudflare");
  const [held, health, events, made] = await Promise.all([
    readHeld(),
    readHealth(),
    cloudflare ? readEvents() : [],
    cloudflare ? readNamespaces() : null,
  ]);
  const rows = standings(config, held, health, events, made);
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(table(rows));
  return rows.some((row) => row.warnings.length) ? 1 : 0;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/gitstore-namespaces.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`namespaces: ${error.message}`);
      process.exit(2);
    },
  );
}
