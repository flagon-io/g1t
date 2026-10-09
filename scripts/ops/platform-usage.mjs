#!/usr/bin/env node
// What is the platform using on Cloudflare? Asks Cloudflare's GraphQL
// Analytics API, for the month so far (UTC, from the 1st) and the last 24
// hours, how much each Worker, D1 database, queue, Durable Object namespace,
// KV namespace and Artifacts namespace did, and prints the top of each with
// totals. Workers Logs are added when the account's schema has a dataset for
// them.
//
// Read-only: one GraphQL query per dataset and window, all at once, and a few
// REST listings to put names on database, queue and namespace ids. A dataset
// or field Cloudflare refuses is a note in the report, never the end of it.
//
//   CLOUDFLARE_API_TOKEN=<token with Account Analytics: Read> \
//     node scripts/ops/platform-usage.mjs [--top 10] [--json] [--account <id>]
//
// --account (or CLOUDFLARE_ACCOUNT_ID) reads another account than g1t's.
// --json prints one object with snake_case keys and every row, not just the top.
// Names come from the D1, Queues, KV and Durable Objects listings when the
// token may read them (D1: Read, Queues: Read, Workers KV Storage: Read,
// Workers Scripts: Read); otherwise the ids are printed.
//
// It is also the check of billing's hourly watcher (services/billing/src/
// platform.rs): it asks Cloudflare billing's own queries, field for field,
// over the last full hour, and exits 1 naming every dataset that errored,
// fell back to fewer fields, or (all of them) answered with no rows. Run it
// once after deploying a change to the watcher's queries.

import { ACCOUNT_ID, cloudflareAuth } from "../deploy/cloudflare.mjs";

const API = "https://api.cloudflare.com/client/v4";

const HELP = `node scripts/ops/platform-usage.mjs [--top N] [--json] [--account <id>]

Cloudflare usage per Worker, D1 database, queue, Durable Object namespace,
KV namespace and Artifacts namespace, month to date (UTC) and the last 24 hours.

  --top N         rows shown per dataset in the tables (default 10)
  --json          one JSON object, snake_case keys, every row
  --account <id>  the Cloudflare account (default CLOUDFLARE_ACCOUNT_ID, else g1t's)
  --help          this text

Needs CLOUDFLARE_API_TOKEN (Account Analytics: Read), or CLOUDFLARE_API_KEY
with CLOUDFLARE_EMAIL.

Exits 1 when any dataset errored or fell back to fewer fields, when any of
billing's watcher queries errored, or when every dataset answered with no
rows (the wrong account, or a token that cannot see it).`;

/**
 * Billing's hourly watcher queries, as `QUERIES` in
 * services/billing/src/platform.rs has them (a test keeps the two the same):
 * the dataset, what it selects, what it groups by, and the filter field for
 * an hour.
 */
export const WATCHER_QUERIES = [
  { key: "workers", dataset: "workersInvocationsAdaptive", select: "sum { requests }", dimensions: "scriptName", hourFilter: "datetime" },
  { key: "workers_cpu", dataset: "workersInvocationsAdaptive", select: "sum { cpuTimeUs }", dimensions: "scriptName", hourFilter: "datetime" },
  { key: "d1", dataset: "d1AnalyticsAdaptiveGroups", select: "sum { rowsRead rowsWritten }", dimensions: "databaseId", hourFilter: "datetimeHour" },
  { key: "queues", dataset: "queueMessageOperationsAdaptiveGroups", select: "sum { billableOperations }", dimensions: "queueId", hourFilter: "datetime" },
  { key: "do_invocations", dataset: "durableObjectsInvocationsAdaptiveGroups", select: "sum { requests }", dimensions: "scriptName", hourFilter: "datetime" },
  { key: "do_periodic", dataset: "durableObjectsPeriodicGroups", select: "sum { activeTime storageWriteUnits }", dimensions: "namespaceId", hourFilter: "datetime" },
  { key: "do_sql", dataset: "durableObjectsPeriodicGroups", select: "sum { rowsWritten }", dimensions: "namespaceId", hourFilter: "datetime" },
  { key: "kv", dataset: "kvOperationsAdaptiveGroups", select: "sum { requests }", dimensions: "namespaceId actionType", hourFilter: "datetime" },
  { key: "artifacts", dataset: "artifactsEventsAdaptiveGroups", select: "count", dimensions: "repositoryName", hourFilter: "datetime" },
];

/** The last full hour (UTC) before `now`, as the watcher reads it. */
export function lastFullHour(now) {
  const until = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const since = new Date(until.getTime() - 3_600_000);
  const label = (date) => `${date.toISOString().slice(0, 13)}:00:00Z`;
  return { since: label(since), until: label(until) };
}

/** One watcher query over an hour, as billing sends it (its account variable named as this script names it). */
export function watcherQuery(query) {
  return `query ($accountTag: String!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    rows: ${query.dataset}(limit: 10000, filter: { ${query.hourFilter}_geq: $since, ${query.hourFilter}_lt: $until }) {
      ${query.select}
      dimensions { ${query.dimensions} }
    }
  } }
}`;
}

/**
 * Whether the schema checks out: every problem in the report's datasets and
 * in the watcher's queries (`watcher`: key to `{ error }` or `{ rows }`).
 * An empty list is a pass.
 */
export function verdict(report, watcher = {}) {
  const problems = [];
  for (const window of report.windows) {
    for (const error of window.errors ?? []) problems.push(`${window.label}: ${error}`);
  }
  let answered = 0;
  let rows = 0;
  for (const query of WATCHER_QUERIES) {
    const outcome = watcher[query.key];
    if (!outcome) continue;
    if (outcome.error) problems.push(`watcher query ${query.key} (${query.dataset}): ${outcome.error}`);
    else {
      answered += 1;
      rows += outcome.rows;
    }
  }
  const reportRows = report.windows.flatMap((w) => w.datasets).reduce((sum, set) => sum + set.rows.length, 0);
  const reportAnswered = report.windows.flatMap((w) => w.datasets).length;
  if (answered + reportAnswered > 0 && rows + reportRows === 0) {
    problems.push("every dataset answered with no rows: likely the wrong account, or a token that cannot see its analytics");
  }
  return problems;
}

/**
 * The datasets the report asks for. Each has one or more variants, tried in
 * order: when Cloudflare refuses a field, the next variant asks for less.
 * `names` says which REST listing puts a name on the first dimension's ids.
 */
export const DATASETS = [
  {
    key: "workers",
    label: "Workers invocations, by script",
    dataset: "workersInvocationsAdaptive",
    variants: [
      { sum: ["requests", "errors", "cpuTimeUs"], dims: ["scriptName"] },
      { sum: ["requests", "errors"], dims: ["scriptName"] },
    ],
  },
  {
    key: "d1",
    label: "D1 rows, by database",
    dataset: "d1AnalyticsAdaptiveGroups",
    names: "d1",
    variants: [
      { sum: ["rowsRead", "rowsWritten", "readQueries", "writeQueries"], dims: ["databaseId"] },
      { sum: ["rowsRead", "rowsWritten"], dims: ["databaseId"] },
    ],
  },
  {
    key: "queues",
    label: "Queue operations, by queue",
    dataset: "queueMessageOperationsAdaptiveGroups",
    names: "queues",
    variants: [{ sum: ["billableOperations"], dims: ["queueId"] }],
  },
  {
    key: "durable_objects",
    label: "Durable Object requests, by script",
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    variants: [
      { sum: ["requests", "errors"], dims: ["scriptName"] },
      { sum: ["requests"], dims: ["scriptName"] },
    ],
  },
  {
    key: "durable_objects_periodic",
    label: "Durable Object time and storage, by namespace",
    dataset: "durableObjectsPeriodicGroups",
    names: "durable_objects",
    variants: [
      { sum: ["activeTime", "cpuTime", "storageReadUnits", "storageWriteUnits"], dims: ["namespaceId"] },
      { sum: ["activeTime", "storageWriteUnits"], dims: ["namespaceId"] },
      // Periodic groups may filter by the minute rather than by datetime.
      { sum: ["activeTime"], dims: ["namespaceId"], time: "datetimeMinute" },
    ],
  },
  {
    key: "kv",
    label: "KV operations, by namespace and action",
    dataset: "kvOperationsAdaptiveGroups",
    names: "kv",
    variants: [{ sum: ["requests"], dims: ["namespaceId", "actionType"] }],
  },
  {
    key: "artifacts",
    label: "Artifacts events, by namespace and type",
    dataset: "artifactsEventsAdaptiveGroups",
    variants: [{ count: true, sum: ["durationMs"], dims: ["repositoryNamespace", "eventType"] }],
  },
  {
    key: "workers_logs",
    label: "Workers Logs events, by script",
    // Which dataset holds Workers Logs is read from the schema (logsDataset).
    dataset: null,
    optional: true,
    variants: [
      { count: true, dims: ["scriptName"] },
      { count: true, dims: [] },
    ],
  },
];

/** The two windows: the UTC month so far, and the last 24 hours. */
export function windows(now = new Date()) {
  const end = new Date(now.getTime());
  const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return [
    { key: "month_to_date", label: "Month to date (UTC)", start: monthStart.toISOString(), end: end.toISOString() },
    { key: "last_24h", label: "Last 24 hours", start: new Date(end.getTime() - 24 * 3600 * 1000).toISOString(), end: end.toISOString() },
  ];
}

/** Which account field holds Workers Logs, from the account type's field names; null when none does. */
export function logsDataset(fieldNames) {
  const known = ["workersObservabilityEventsAdaptiveGroups", "workersLogsEventsAdaptiveGroups", "workersLogsAdaptiveGroups"];
  return known.find((name) => fieldNames.includes(name)) ?? fieldNames.find((name) => /^workers.*(logs|observability).*groups$/i.test(name)) ?? null;
}

/** One dataset's query, for one variant. The rows come back under `rows`. */
export function buildQuery(dataset, variant) {
  const time = variant.time ?? "datetime";
  const fields = [
    variant.count ? "count" : "",
    variant.sum?.length ? `sum { ${variant.sum.join(" ")} }` : "",
    variant.dims.length ? `dimensions { ${variant.dims.join(" ")} }` : "",
  ].filter(Boolean);
  return `query PlatformUsage($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rows: ${dataset}(limit: 10000, filter: { ${time}_geq: $start, ${time}_leq: $end }) {
        ${fields.join("\n        ")}
      }
    }
  }
}`;
}

/** camelCase to snake_case, for the JSON report's keys. */
export const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The metric names a variant reports, snake_case: `count` first, then its sums. */
export const metricsOf = (variant) => [...(variant.count ? ["count"] : []), ...(variant.sum ?? []).map(snake)];

/**
 * A GraphQL answer to one dataset's query as rows, one per name, summed and
 * sorted by the first metric (largest first), with totals per metric. Throws
 * with Cloudflare's message when the answer has errors or no such dataset.
 */
export function parseGroups(body, variant, names = {}) {
  if (body?.errors?.length) throw new Error(body.errors.map((error) => error.message).join("; ").slice(0, 400));
  const groups = body?.data?.viewer?.accounts?.[0]?.rows;
  if (!Array.isArray(groups)) throw new Error("no rows in the answer");
  const metrics = metricsOf(variant);
  const byName = new Map();
  for (const group of groups) {
    const parts = variant.dims.map((dim, at) => {
      const value = group.dimensions?.[dim];
      const text = value == null || value === "" ? "(none)" : String(value);
      return at === 0 ? (names[text] ?? text) : text;
    });
    const name = parts.join(" / ") || "(all)";
    const row = byName.get(name) ?? { name, ...Object.fromEntries(metrics.map((metric) => [metric, 0])) };
    if (variant.count) row.count += Number(group.count ?? 0);
    for (const field of variant.sum ?? []) row[snake(field)] += Number(group.sum?.[field] ?? 0);
    byName.set(name, row);
  }
  const rows = sortRows([...byName.values()], metrics[0]);
  return { metrics, rows, totals: totalsOf(rows, metrics) };
}

/** Rows largest first by one metric, ties by name. */
export function sortRows(rows, metric) {
  return [...rows].sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0) || a.name.localeCompare(b.name));
}

/** Each metric summed over all rows. */
export function totalsOf(rows, metrics) {
  return Object.fromEntries(metrics.map((metric) => [metric, rows.reduce((total, row) => total + (row[metric] ?? 0), 0)]));
}

/**
 * The report from every dataset's outcome in every window. An outcome is
 * `{ body, variant }` (a GraphQL answer) or `{ error }` or `{ skipped }`;
 * whatever cannot be read becomes a note and the other datasets still count.
 */
export function assemble({ account, now, windowList, outcomes, names = {} }) {
  return {
    account,
    generated_at: now.toISOString(),
    windows: windowList.map((window) => {
      const notes = [];
      const errors = [];
      const datasets = [];
      for (const spec of DATASETS) {
        const outcome = outcomes[window.key]?.[spec.key];
        if (!outcome) continue;
        if (outcome.skipped) {
          notes.push(`${spec.label}: ${outcome.skipped}`);
          continue;
        }
        if (outcome.fellBack) {
          const note = `${spec.label} (${outcome.dataset ?? spec.dataset}): fell back to fewer fields: ${outcome.fellBack}`;
          notes.push(note);
          errors.push(note);
        }
        try {
          if (outcome.error) throw outcome.error;
          const parsed = parseGroups(outcome.body, outcome.variant, names[spec.names] ?? {});
          datasets.push({ key: spec.key, label: spec.label, dataset: outcome.dataset ?? spec.dataset, ...parsed });
        } catch (error) {
          const note = `${spec.label} (${outcome.dataset ?? spec.dataset ?? "no dataset"}): ${String(error.message ?? error).split("\n")[0]}`;
          notes.push(note);
          errors.push(note);
        }
      }
      return { key: window.key, label: window.label, start: window.start, end: window.end, datasets, notes, errors };
    }),
  };
}

const number = (value) => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** The report as plain tables: the top rows of each dataset, and a totals line. */
export function format(report, top = 10) {
  const lines = [`Cloudflare usage for account ${report.account}, ${report.generated_at}`];
  for (const window of report.windows) {
    lines.push("", `== ${window.label}: ${window.start} to ${window.end}`);
    for (const set of window.datasets) {
      lines.push("", `${set.label} (${set.dataset})`);
      const shown = set.rows.slice(0, top);
      const cells = [["name", ...set.metrics], ...shown.map((row) => [row.name, ...set.metrics.map((m) => number(row[m]))]), ["total", ...set.metrics.map((m) => number(set.totals[m]))]];
      const widths = cells[0].map((_, at) => Math.max(...cells.map((row) => String(row[at]).length)));
      const render = (row) => "  " + row.map((cell, at) => (at === 0 ? String(cell).padEnd(widths[at]) : String(cell).padStart(widths[at]))).join("  ");
      lines.push(render(cells[0]));
      if (!shown.length) lines.push("  (nothing in this window)");
      for (const row of cells.slice(1, -1)) lines.push(render(row));
      if (set.rows.length > shown.length) lines.push(`  ... and ${set.rows.length - shown.length} more`);
      lines.push(render(cells.at(-1)));
    }
    if (window.notes.length) {
      lines.push("", "Notes:");
      for (const note of window.notes) lines.push(`  ${note}`);
    }
  }
  return lines.join("\n");
}

/** The command line: flags and the account. */
export function parseArgs(argv, env = process.env) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
  };
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
    top: Math.max(1, Number(option("--top")) || 10),
    account: option("--account") || env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT_ID,
  };
}

async function graphql(auth, account, query, variables = {}) {
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "user-agent": "g1t-ops" },
    body: JSON.stringify({ query, variables: { accountTag: account, ...variables } }),
  });
  const body = await response.json().catch(() => ({ errors: [{ message: `HTTP ${response.status}, not JSON` }] }));
  if (!response.ok && !body.errors?.length) body.errors = [{ message: `HTTP ${response.status}` }];
  return body;
}

/** The account type's field names, to skip datasets the schema lacks; null when it cannot be read. */
async function schemaFields(auth, account) {
  try {
    const body = await graphql(auth, account, `{ __type(name: "account") { fields { name } } }`);
    const fields = body.data?.__type?.fields;
    return Array.isArray(fields) ? fields.map((field) => field.name) : null;
  } catch {
    return null;
  }
}

/** One dataset in one window: each variant in turn until one is answered. */
async function ask(auth, account, dataset, spec, window) {
  let last = null;
  let first = null;
  for (const variant of spec.variants) {
    try {
      const body = await graphql(auth, account, buildQuery(dataset, variant), { start: window.start, end: window.end });
      if (!body.errors?.length) return first ? { body, variant, dataset, fellBack: first } : { body, variant, dataset };
      first ??= body.errors.map((e) => e.message).join("; ");
      last = { body, variant, dataset };
    } catch (error) {
      last = { error, dataset };
    }
  }
  return last;
}

/** A REST listing as id to name; empty when the token may not read it. */
async function listing(auth, path, id, name) {
  const out = {};
  try {
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { headers: { ...auth, "user-agent": "g1t-ops" } });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.result)) break;
      for (const item of body.result) if (item[id]) out[item[id]] = item[name] ?? item[id];
      if (body.result.length < 100) break;
    }
  } catch {
    // Ids stand in for names.
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const auth = cloudflareAuth();
  if (!auth) {
    console.error(`Set CLOUDFLARE_API_TOKEN to a token with Account Analytics: Read on account ${options.account}, or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL.`);
    return 2;
  }
  const now = new Date();
  const windowList = windows(now);
  const account = options.account;
  const base = `/accounts/${account}`;
  const [fields, d1, queues, kv, durable] = await Promise.all([
    schemaFields(auth, account),
    listing(auth, `${base}/d1/database`, "uuid", "name"),
    listing(auth, `${base}/queues`, "queue_id", "queue_name"),
    listing(auth, `${base}/storage/kv/namespaces`, "id", "title"),
    listing(auth, `${base}/workers/durable_objects/namespaces`, "id", "name"),
  ]);
  const names = { d1, queues, kv, durable_objects: durable };
  const outcomes = {};
  const jobs = [];
  for (const window of windowList) {
    outcomes[window.key] = {};
    for (const spec of DATASETS) {
      const dataset = spec.dataset ?? (fields ? logsDataset(fields) : null);
      if (!dataset) {
        if (!spec.optional) outcomes[window.key][spec.key] = { skipped: "no dataset" };
        continue;
      }
      if (fields && !fields.includes(dataset)) {
        if (!spec.optional) outcomes[window.key][spec.key] = { skipped: `${dataset} is not in this account's schema` };
        continue;
      }
      jobs.push(ask(auth, account, dataset, spec, window).then((outcome) => (outcomes[window.key][spec.key] = outcome)));
    }
  }
  // Billing's own watcher queries, over the last full hour.
  const hour = lastFullHour(now);
  const watcher = {};
  jobs.push(
    ...WATCHER_QUERIES.map(async (query) => {
      try {
        const body = await graphql(auth, account, watcherQuery(query), { since: hour.since, until: hour.until });
        watcher[query.key] = body.errors?.length
          ? { error: body.errors.map((e) => e.message).join("; ") }
          : { rows: body.data?.viewer?.accounts?.[0]?.rows?.length ?? 0 };
      } catch (error) {
        watcher[query.key] = { error: String(error.message ?? error) };
      }
    }),
  );
  await Promise.all(jobs);
  const report = assemble({ account, now, windowList, outcomes, names });
  const problems = verdict(report, watcher);
  if (options.json) {
    console.log(JSON.stringify({ ...report, watcher_hour: hour, watcher, problems }, null, 2));
  } else {
    console.log(format(report, options.top));
    console.log("", `== Billing's watcher queries, ${hour.since} to ${hour.until}`);
    for (const query of WATCHER_QUERIES) {
      const outcome = watcher[query.key];
      console.log(`  ${query.key.padEnd(15)} ${outcome?.error ? `ERROR ${outcome.error}` : `${outcome?.rows ?? 0} rows`}`);
    }
  }
  if (problems.length) {
    console.error("", `platform-usage: ${problems.length} problem(s); the watcher may be blind on these:`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  return 0;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/platform-usage.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`platform-usage: ${error.message}`);
      process.exit(1);
    },
  );
}
