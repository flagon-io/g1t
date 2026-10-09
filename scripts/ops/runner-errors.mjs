#!/usr/bin/env node
// What are the runner's Durable Object errors? The sandboxes that run agent
// attempts, workflow jobs and merge-queue builds are Durable Objects of the
// g1t-runner Worker (services/runner: AttemptSandbox, Sandbox2Core,
// Sandbox4Core). This asks Cloudflare, over the last N days:
//
// 1. GraphQL Analytics (durableObjectsInvocationsAdaptiveGroups): requests
//    and errors by namespace and status, and by day and status.
// 2. Workers Observability (the telemetry query API): the runner's failed
//    invocations by class, event type (alarm, rpc, fetch) and outcome; the
//    exceptions they threw, by message; the runner's own error-level logs
//    (`sandbox stop not reported`, `sandbox alarm failed`, `sandbox not
//    started`, `sandbox container error`), by message; and a few recent
//    failed invocations in full.
//
// Each message is put in a bucket (`classify`): a deploy resetting the
// object, no container free, a container that exited, and so on, so what is
// expected and what is a bug can be told apart at a glance.
//
// Read-only: GraphQL queries, one Durable Objects listing for names, and
// telemetry queries. Never prints the token.
//
//   CLOUDFLARE_API_TOKEN=<token> node scripts/ops/runner-errors.mjs [--days 7] [--json]
//
// The token needs Account Analytics: Read (GraphQL) and Workers Observability:
// Read (logs); Workers Scripts: Read adds namespace names. A part the token
// cannot read is a note in the report, never the end of it.

import { ACCOUNT_ID, cloudflareAuth } from "../deploy/cloudflare.mjs";

const API = "https://api.cloudflare.com/client/v4";

const HELP = `node scripts/ops/runner-errors.mjs [--days N] [--script NAME] [--samples N] [--json] [--keys] [--account <id>]

The runner's Durable Object errors: requests and errors by namespace and
status (GraphQL Analytics), and what failed and why (Workers Observability).

  --days N        how far back, in days (default 7, at most 31)
  --script NAME   the Worker (default g1t-runner)
  --samples N     recent failed invocations shown in full (default 10)
  --json          one JSON object, snake_case keys
  --keys          also list the telemetry keys the runner's events have
  --account <id>  the Cloudflare account (default CLOUDFLARE_ACCOUNT_ID, else g1t's)
  --help          this text

Needs CLOUDFLARE_API_TOKEN (Account Analytics: Read, Workers Observability:
Read), or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL. Exits 1 when nothing
could be read.`;

/** The command line. */
export function parseArgs(argv, env = process.env) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
  };
  const days = Number(option("--days") ?? NaN);
  const samples = Number(option("--samples") ?? NaN);
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
    keys: argv.includes("--keys"),
    days: Number.isFinite(days) && days > 0 ? Math.min(31, days) : 7,
    samples: Number.isFinite(samples) && samples >= 0 ? Math.min(100, Math.floor(samples)) : 10,
    script: option("--script") || "g1t-runner",
    account: option("--account") || env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT_ID,
  };
}

/** The window: the last `days` days up to `now`. */
export function windowOf(now, days) {
  return { start: new Date(now.getTime() - days * 86_400_000).toISOString(), end: now.toISOString() };
}

/**
 * The GraphQL queries, each with variants tried in order when Cloudflare
 * refuses a field. Rows come back under `rows`.
 */
export const DO_QUERIES = [
  {
    key: "by_namespace",
    label: "Durable Object requests by namespace and status",
    variants: [
      { sum: ["requests", "errors", "wallTime"], dims: ["namespaceId", "status"] },
      { sum: ["requests", "errors"], dims: ["namespaceId", "status"] },
      { sum: ["requests"], dims: ["namespaceId", "status"] },
      { sum: ["requests", "errors"], dims: ["namespaceId"] },
    ],
  },
  {
    key: "by_day",
    label: "Durable Object requests by day and status",
    variants: [
      { sum: ["requests", "errors"], dims: ["date", "status"] },
      { sum: ["requests"], dims: ["date", "status"] },
    ],
  },
];

/** One DO invocations query for one script, for one variant. */
export function doQuery(variant) {
  return `query RunnerErrors($accountTag: String!, $start: Time!, $end: Time!, $script: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rows: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }) {
        sum { ${variant.sum.join(" ")} }
        dimensions { ${variant.dims.join(" ")} }
      }
    }
  }
}`;
}

const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * A GraphQL answer as rows: one per dimension combination, the first
 * dimension named through `names` (namespace ids to names), with each sum
 * and the error rate, largest first by requests. Throws with Cloudflare's
 * message when the answer has errors.
 */
export function parseDoGroups(body, variant, names = {}) {
  if (body?.errors?.length) throw new Error(body.errors.map((error) => error.message).join("; ").slice(0, 400));
  const groups = body?.data?.viewer?.accounts?.[0]?.rows;
  if (!Array.isArray(groups)) throw new Error("no rows in the answer");
  const rows = groups.map((group) => {
    const row = {};
    variant.dims.forEach((dim, at) => {
      const value = group.dimensions?.[dim];
      const text = value == null || value === "" ? "(none)" : String(value);
      row[snake(dim)] = at === 0 && names[text] ? names[text] : text;
    });
    for (const field of variant.sum) row[snake(field)] = Number(group.sum?.[field] ?? 0);
    return row;
  });
  const sortKey = variant.dims[0] === "date" ? null : "requests";
  rows.sort((a, b) => (sortKey ? b.requests - a.requests : 0) || String(a[snake(variant.dims[0])]).localeCompare(String(b[snake(variant.dims[0])])));
  const totals = Object.fromEntries(variant.sum.map((field) => [snake(field), rows.reduce((sum, row) => sum + row[snake(field)], 0)]));
  return { dims: variant.dims.map(snake), metrics: variant.sum.map(snake), rows, totals };
}

/**
 * Requests and errors per status, summed over namespaces: which statuses
 * the errors are (`scriptThrewException`, `internalError`,
 * `clientDisconnected`, `exceededResources`, ...).
 */
export function byStatus(parsed) {
  if (!parsed.dims.includes("status")) return [];
  const out = new Map();
  for (const row of parsed.rows) {
    const entry = out.get(row.status) ?? { status: row.status, requests: 0, errors: 0 };
    entry.requests += row.requests ?? 0;
    entry.errors += row.errors ?? 0;
    out.set(row.status, entry);
  }
  return [...out.values()].sort((a, b) => b.requests - a.requests);
}

/** The telemetry keys the questions below group by and filter on. */
export const KEYS = {
  outcome: "$workers.outcome",
  eventType: "$workers.eventType",
  entrypoint: "$workers.entrypoint",
  error: "$metadata.error",
  message: "$metadata.message",
  level: "$metadata.level",
};

/** Which key names the Worker: tried in order, the next when one finds nothing. */
export const SERVICE_KEYS = ["$workers.scriptName", "$metadata.service"];

const filter = (key, operation, value) => (value === undefined ? { key, operation, type: "string" } : { key, operation, type: "string", value });

/**
 * The telemetry questions: each a body for `POST .../workers/observability/
 * telemetry/query`, for the Worker named under `serviceKey`.
 */
export function telemetryQuestions({ script, from, to, samples, serviceKey = SERVICE_KEYS[0] }) {
  const service = filter(serviceKey, "eq", script);
  const failed = filter(KEYS.outcome, "neq", "ok");
  const base = { timeframe: { from, to }, limit: 100 };
  const count = [{ operator: "count", alias: "events" }];
  const group = (...keys) => keys.map((value) => ({ type: "string", value }));
  return [
    {
      key: "failed_invocations",
      label: "Failed invocations by class, event and outcome",
      body: {
        ...base,
        queryId: "g1t-runner-failed-invocations",
        view: "calculations",
        parameters: { datasets: ["cloudflare-workers"], filters: [service, failed], calculations: count, groupBys: group(KEYS.entrypoint, KEYS.eventType, KEYS.outcome) },
      },
    },
    {
      key: "exceptions",
      label: "Exceptions by message",
      body: {
        ...base,
        queryId: "g1t-runner-exceptions",
        view: "calculations",
        parameters: { datasets: ["cloudflare-workers"], filters: [service, filter(KEYS.error, "exists")], calculations: count, groupBys: group(KEYS.error) },
      },
    },
    {
      key: "error_logs",
      label: "The runner's error-level logs by message",
      body: {
        ...base,
        queryId: "g1t-runner-error-logs",
        view: "calculations",
        parameters: { datasets: ["cloudflare-workers"], filters: [service, filter(KEYS.level, "eq", "error")], calculations: count, groupBys: group(KEYS.message) },
      },
    },
    {
      key: "samples",
      label: "Recent failed invocations",
      body: {
        ...base,
        limit: Math.max(1, samples),
        queryId: "g1t-runner-failed-samples",
        view: "events",
        parameters: { datasets: ["cloudflare-workers"], filters: [service, failed] },
      },
    },
  ];
}

/**
 * A telemetry calculations answer as rows: each group's key values and its
 * count, largest first. Throws with Cloudflare's message when it failed.
 */
export function parseCalculations(body) {
  if (body?.success === false || body?.errors?.length) throw new Error(messagesOf(body));
  const calculation = body?.result?.calculations?.[0];
  if (!calculation) throw new Error("no calculations in the answer");
  const rows = (calculation.aggregates ?? []).map((aggregate) => {
    const row = {};
    for (const group of aggregate.groups ?? []) row[group.key] = group.value == null || group.value === "" ? "(none)" : String(group.value);
    row.count = Number(aggregate.value ?? aggregate.count ?? 0);
    return row;
  });
  return rows.sort((a, b) => b.count - a.count);
}

/** A telemetry events answer as plain records: when, which class, event, outcome, and what went wrong. */
export function parseEvents(body) {
  if (body?.success === false || body?.errors?.length) throw new Error(messagesOf(body));
  const events = body?.result?.events?.events ?? body?.result?.events ?? [];
  if (!Array.isArray(events)) throw new Error("no events in the answer");
  return events.map((event) => {
    const workers = event.$workers ?? {};
    const metadata = event.$metadata ?? {};
    const at = event.timestamp ?? metadata.startTime ?? workers.timestamp;
    return {
      at: typeof at === "number" ? new Date(at).toISOString() : (at ?? null),
      entrypoint: workers.entrypoint ?? null,
      event_type: workers.eventType ?? null,
      outcome: workers.outcome ?? null,
      object: typeof workers.durableObjectId === "string" ? workers.durableObjectId.slice(0, 12) : null,
      error: metadata.error ?? null,
      message: metadata.message ?? (typeof event.source === "string" ? event.source : (event.source?.message ?? null)),
    };
  });
}

function messagesOf(body) {
  const errors = body?.errors ?? [];
  const text = errors.map((error) => error.message ?? JSON.stringify(error)).join("; ");
  return (text || `request failed${body?.status ? ` with ${body.status}` : ""}`).slice(0, 400);
}

/**
 * What a failure most likely is, from its message or outcome: a bucket and
 * whether it is expected. Order matters: the first match wins.
 */
export const BUCKETS = [
  { bucket: "deploy_reset", expected: true, why: "a runner deploy reset the object mid-invocation", test: /code (was|has been) updated|reset because its code|new version of the (script|worker)|durable object reset/i },
  { bucket: "stop_not_reported", expected: false, why: "onStop could not tell a service the sandbox stopped (now logged, not thrown)", test: /sandbox stop not reported/i },
  { bucket: "alarm_failed", expected: false, why: "the sandbox's alarm threw (retried by Cloudflare)", test: /sandbox alarm failed/i },
  { bucket: "no_capacity", expected: true, why: "no container instance free (max_instances, or provisioning)", test: /no container instance|max(imum)? concurrent instance|too many containers per second/i },
  { bucket: "not_started", expected: false, why: "a sandbox could not start (guardrails unreadable, or the container would not start)", test: /sandbox not started|could not read this project's guardrails|did not start after|failed to start container/i },
  { bucket: "container_exited", expected: true, why: "the container exited or was stopped (a finished run, a time cap, a stop)", test: /container exited|runtime signalled|exited before we could determine|crashed while checking for ports|exit code/i },
  { bucket: "connection_lost", expected: false, why: "the connection to the container was lost", test: /network connection lost|disconnected/i },
  { bucket: "storage", expected: false, why: "Durable Object storage failed or was overloaded", test: /storage|sqlite|overloaded/i },
  { bucket: "limits", expected: false, why: "a CPU, memory or subrequest limit", test: /exceeded|too many subrequests|memory limit/i },
  { bucket: "container_error", expected: false, why: "the containers library reported an error", test: /sandbox container error|container error/i },
];

/** The bucket of one failure's message (or, failing that, its outcome). */
export function classify(message, outcome = null) {
  const text = String(message ?? "");
  for (const bucket of BUCKETS) if (text && bucket.test.test(text)) return { bucket: bucket.bucket, expected: bucket.expected, why: bucket.why };
  if (/canceled|cancelled|clientdisconnected|responsestreamdisconnected/i.test(String(outcome ?? ""))) {
    return { bucket: "caller_gone", expected: true, why: "the caller went away before the object answered" };
  }
  return { bucket: "other", expected: false, why: "not recognised: read the message" };
}

/** Rows of messages with counts, summed into buckets, largest first. */
export function bucketsOf(rows, messageKey) {
  const out = new Map();
  for (const row of rows) {
    const found = classify(row[messageKey], row[KEYS.outcome]);
    const entry = out.get(found.bucket) ?? { ...found, count: 0 };
    entry.count += row.count;
    out.set(found.bucket, entry);
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

const number = (value) => (Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const percent = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");

function table(rows, columns) {
  if (!rows.length) return ["  (nothing in this window)"];
  const cells = [columns.map((c) => c.title), ...rows.map((row) => columns.map((c) => c.value(row)))];
  const widths = columns.map((_, at) => Math.max(...cells.map((row) => String(row[at]).length)));
  return cells.map((row) => "  " + row.map((cell, at) => (columns[at].right ? String(cell).padStart(widths[at]) : String(cell).padEnd(widths[at]))).join("  "));
}

/** The report as plain text. */
export function format(report, top = 25) {
  const lines = [`Durable Object errors of ${report.script} on account ${report.account}, ${report.start} to ${report.end}`];
  for (const query of report.analytics) {
    lines.push("", query.label);
    if (query.error) {
      lines.push(`  could not read: ${query.error}`);
      continue;
    }
    const columns = [
      ...query.dims.map((dim) => ({ title: dim, value: (row) => row[dim] })),
      ...query.metrics.map((metric) => ({ title: metric, right: true, value: (row) => number(row[metric]) })),
    ];
    if (query.metrics.includes("errors")) columns.push({ title: "error_rate", right: true, value: (row) => percent(row.errors, row.requests) });
    lines.push(...table(query.rows.slice(0, top), columns));
    lines.push(`  total: ${Object.entries(query.totals).map(([metric, value]) => `${metric} ${number(value)}`).join(", ")}`);
    if (query.by_status?.length) {
      lines.push("  by status:");
      lines.push(...table(query.by_status, [
        { title: "status", value: (row) => row.status },
        { title: "requests", right: true, value: (row) => number(row.requests) },
        { title: "errors", right: true, value: (row) => number(row.errors) },
      ]).map((line) => `  ${line}`));
    }
  }
  for (const question of report.telemetry) {
    lines.push("", question.label);
    if (question.error) {
      lines.push(`  could not read: ${question.error}`);
      continue;
    }
    if (question.key === "samples") {
      if (!question.rows.length) lines.push("  (none)");
      for (const row of question.rows) {
        lines.push(`  ${row.at ?? "?"}  ${row.entrypoint ?? "?"} ${row.event_type ?? "?"} ${row.outcome ?? "?"}${row.object ? ` ${row.object}` : ""}`);
        if (row.error || row.message) lines.push(`    ${String(row.error ?? row.message).slice(0, 300)}`);
      }
      continue;
    }
    const keys = Object.keys(question.rows[0] ?? {}).filter((key) => key !== "count");
    lines.push(...table(question.rows.slice(0, top), [
      ...keys.map((key) => ({ title: key, value: (row) => String(row[key] ?? "").slice(0, 120) })),
      { title: "count", right: true, value: (row) => number(row.count) },
    ]));
    if (question.buckets?.length) {
      lines.push("  most likely:");
      for (const bucket of question.buckets) lines.push(`    ${String(number(bucket.count)).padStart(6)}  ${bucket.bucket}${bucket.expected ? " (expected)" : ""}: ${bucket.why}`);
    }
  }
  if (report.keys) lines.push("", "Telemetry keys:", ...report.keys.map((key) => `  ${key}`));
  if (report.notes.length) lines.push("", "Notes:", ...report.notes.map((note) => `  ${note}`));
  return lines.join("\n");
}

async function post(auth, path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "user-agent": "g1t-ops" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${response.status}, not JSON` }] }));
  if (!response.ok && !answer.errors?.length) answer.errors = [{ message: `HTTP ${response.status}` }];
  return answer;
}

async function durableNames(auth, account) {
  const out = {};
  try {
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`${API}/accounts/${account}/workers/durable_objects/namespaces?per_page=100&page=${page}`, { headers: { ...auth, "user-agent": "g1t-ops" } });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.result)) break;
      for (const item of body.result) if (item.id) out[item.id] = item.name ?? item.id;
      if (body.result.length < 100) break;
    }
  } catch {
    // Ids stand in for names.
  }
  return out;
}

async function analytics(auth, options, window, names) {
  return Promise.all(
    DO_QUERIES.map(async (query) => {
      let error = null;
      for (const variant of query.variants) {
        try {
          const body = await post(auth, "/graphql", { query: doQuery(variant), variables: { accountTag: options.account, start: window.start, end: window.end, script: options.script } });
          const parsed = parseDoGroups(body, variant, names);
          return { key: query.key, label: query.label, ...parsed, by_status: query.key === "by_namespace" ? byStatus(parsed) : undefined };
        } catch (thrown) {
          error ??= String(thrown.message ?? thrown);
        }
      }
      return { key: query.key, label: query.label, error };
    }),
  );
}

async function telemetry(auth, options, window) {
  const path = `/accounts/${options.account}/workers/observability/telemetry/query`;
  const from = Date.parse(window.start);
  const to = Date.parse(window.end);
  let results = null;
  for (const serviceKey of SERVICE_KEYS) {
    results = await Promise.all(
      telemetryQuestions({ script: options.script, from, to, samples: options.samples, serviceKey }).map(async (question) => {
        try {
          const body = await post(auth, path, question.body);
          if (question.key === "samples") return { key: question.key, label: question.label, rows: parseEvents(body) };
          const rows = parseCalculations(body);
          const messageKey = question.key === "exceptions" ? KEYS.error : question.key === "error_logs" ? KEYS.message : null;
          return { key: question.key, label: question.label, rows, buckets: messageKey ? bucketsOf(rows, messageKey) : undefined };
        } catch (error) {
          return { key: question.key, label: question.label, error: String(error.message ?? error) };
        }
      }),
    );
    // Another key names the Worker when this one found nothing at all.
    if (results.some((result) => result.rows?.length)) return { serviceKey, results };
  }
  return { serviceKey: SERVICE_KEYS.at(-1), results };
}

async function telemetryKeys(auth, options, window) {
  const body = await post(auth, `/accounts/${options.account}/workers/observability/telemetry/keys`, {
    timeframe: { from: Date.parse(window.start), to: Date.parse(window.end) },
    datasets: ["cloudflare-workers"],
    filters: [filter(SERVICE_KEYS[0], "eq", options.script)],
    limit: 500,
  });
  if (body?.success === false || body?.errors?.length) throw new Error(messagesOf(body));
  return (body.result ?? []).map((key) => (typeof key === "string" ? key : `${key.key} (${key.type})`)).sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const auth = cloudflareAuth();
  if (!auth) {
    console.error(`Set CLOUDFLARE_API_TOKEN to a token with Account Analytics: Read and Workers Observability: Read on account ${options.account}.`);
    return 2;
  }
  const window = windowOf(new Date(), options.days);
  const names = await durableNames(auth, options.account);
  const [graph, logs, keys] = await Promise.all([
    analytics(auth, options, window, names),
    telemetry(auth, options, window),
    options.keys ? telemetryKeys(auth, options, window).catch((error) => [`could not list keys: ${error.message}`]) : Promise.resolve(null),
  ]);
  const notes = [];
  if (!Object.keys(names).length) notes.push("Namespace ids are not named: the token cannot read the Durable Objects listing (Workers Scripts: Read).");
  notes.push(`Telemetry is filtered on ${logs.serviceKey}.`);
  const report = { account: options.account, script: options.script, start: window.start, end: window.end, analytics: graph, telemetry: logs.results, keys, notes };
  console.log(options.json ? JSON.stringify(report, null, 2) : format(report));
  const read = [...graph, ...logs.results].some((part) => !part.error);
  return read ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ops/runner-errors.mjs")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`runner-errors: ${error.message}`);
      process.exit(1);
    },
  );
}
