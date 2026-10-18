/**
 * The store end to end, on Node's SQLite standing in for the Durable
 * Object's: tail events from the dispatcher and the app meet as one
 * request, are counted into the overview, and read back as requests,
 * logs, traces and errors.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TELEMETRY_TAG } from "@g1t/contracts/telemetry";

import { emptyBatch } from "./batch.ts";
import { OTLP_DOOR, readTraces } from "./otlp/normalize.ts";
import { Store, aggregate, ftsQuery, parseSearch, stepFor } from "./store.ts";
import { REQUEST_ID_HEADER, REQUEST_MARK, readTail } from "./tail.ts";

/** A Durable Object's state, as far as the store uses it, on an in-memory database. */
function state() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (!args.length && query.trim().split(";").filter((q) => q.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const rows = db.prepare(query).all(...(args as never[]));
      const written = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n);
      return { toArray: () => rows, rowsWritten: written };
    },
    get databaseSize() {
      return 1024;
    },
  };
  const waits: Promise<unknown>[] = [];
  return {
    storage: {
      sql,
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
      deleteAlarm: async () => void (alarm = null),
      deleteAll: async () => {
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'logs_fts%'").all() as { name: string }[]) {
          db.exec(`DELETE FROM "${name}"`);
        }
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    blockConcurrencyWhile: async (f: () => Promise<unknown>) => f(),
  } as unknown as DurableObjectState;
}

const NOW_MS = 1_760_000_000_000;
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

function edgeEvent(id: string, status: number, wallMs: number, at = NOW_MS): TraceItem {
  return {
    scriptName: "g1t-pages",
    eventTimestamp: at,
    outcome: "ok",
    wallTime: wallMs,
    cpuTime: 1,
    truncated: false,
    exceptions: [],
    diagnosticsChannelEvents: [],
    executionModel: "stateless",
    logs: [
      {
        timestamp: at,
        level: "log",
        message: [REQUEST_MARK, { id, script: "web-acme", trace_id: TRACE, app: { project: "prj_1", deployment: "dep_1", environment: "production", service: "web", commit: "abc" } }],
      },
    ],
    event: { request: { url: `https://web-acme.g1t.page/users/${id.length}?q=1`, method: "GET", headers: {}, cf: { colo: "AMS", country: "NL" } }, response: { status } },
  } as unknown as TraceItem;
}

function appEvent(id: string, opts: { outcome?: string; exception?: string; logs?: string[]; at?: number } = {}): TraceItem {
  const at = opts.at ?? NOW_MS;
  return {
    scriptName: "web-acme",
    scriptTags: ["workspace:acme", "project:acme/web", "production", `${TELEMETRY_TAG.project}prj_1`, `${TELEMETRY_TAG.deployment}dep_1`],
    eventTimestamp: at,
    outcome: opts.outcome ?? "ok",
    wallTime: 40,
    cpuTime: 7,
    truncated: false,
    diagnosticsChannelEvents: [],
    executionModel: "stateless",
    exceptions: opts.exception ? [{ timestamp: at + 1, name: "TypeError", message: opts.exception, stack: "TypeError\n    at handler (src/index.ts:3:1)" }] : [],
    logs: (opts.logs ?? []).map((m, i) => ({ timestamp: at + i, level: i === 0 ? "log" : "warn", message: [m] })),
    event: {
      request: {
        url: "https://web-acme.g1t.page/users/1",
        method: "GET",
        headers: { [REQUEST_ID_HEADER]: id, traceparent: `00-${TRACE}-${id}-01` },
      },
      response: opts.outcome && opts.outcome !== "ok" ? undefined : { status: 200 },
    },
  } as unknown as TraceItem;
}

async function ingestTail(store: Store, events: TraceItem[]) {
  for (const g of readTail(events)) {
    assert.equal(g.project_id, "prj_1");
    await store.ingest(g.batch, g.halves);
  }
}

test("the dispatcher's half and the app's meet as one request, in either order", async () => {
  const store = new Store(state());
  await ingestTail(store, [appEvent("aaaaaaaaaaaaaaa1", { logs: ["hello", "careful"] })]);
  await ingestTail(store, [edgeEvent("aaaaaaaaaaaaaaa1", 200, 55)]);
  await ingestTail(store, [edgeEvent("aaaaaaaaaaaaaaa2", 304, 3)]); // a site's file: no app half

  const page = store.requests({ limit: 10 });
  assert.equal(page.items.length, 2);
  const one = store.request("aaaaaaaaaaaaaaa1")!;
  assert.equal(one.request.status, 200);
  assert.equal(one.request.duration_us, 55_000, "the dispatcher's time is the whole request");
  assert.equal(one.request.cpu_ms, 7);
  assert.equal(one.request.region, "AMS");
  assert.equal(one.request.country, "NL");
  assert.equal(one.request.service, "web");
  assert.equal(one.request.deployment_id, "dep_1");
  assert.equal(one.request.trace_id, TRACE);
  assert.equal(one.request.route, "/users/:id");
  assert.deepEqual(one.logs.map((l) => [l.severity, l.body]), [["info", "hello"], ["warn", "careful"]]);
  const site = store.request("aaaaaaaaaaaaaaa2")!;
  assert.equal(site.request.status, 304);
  assert.equal(site.request.service, "web");
});

test("errors are grouped, counted, and open again when they come back", async () => {
  const store = new Store(state());
  await ingestTail(store, [appEvent("bbbbbbbbbbbbbbb1", { outcome: "exception", exception: "Cannot read 'x' of user 1" }), edgeEvent("bbbbbbbbbbbbbbb1", 502, 30)]);
  await ingestTail(store, [appEvent("bbbbbbbbbbbbbbb2", { outcome: "exception", exception: "Cannot read 'y' of user 2" })]);
  let groups = store.errors({});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].first_deployment_id, "dep_1");
  store.setError(groups[0].fingerprint, { state: "resolved", item: 12 });
  await ingestTail(store, [appEvent("bbbbbbbbbbbbbbb3", { outcome: "exception", exception: "Cannot read 'z' of user 3" })]);
  groups = store.errors({});
  assert.equal(groups[0].state, "open");
  assert.equal(groups[0].item, 12);
  const failed = store.requests({ errors_only: true });
  assert.equal(failed.items.length, 3);
  // An app that threw answered with an error page, whichever half said so.
  assert.equal(store.requests({ status: ["5xx"] }).items.length, 3);
  assert.equal(store.requests({ status: ["2xx"] }).items.length, 0);
});

test("the overview counts requests, by minute and route, whether rolled up yet or not", async () => {
  const store = new Store(state());
  for (let i = 0; i < 20; i++) {
    const id = `c${String(i).padStart(15, "0")}`;
    await ingestTail(store, [edgeEvent(id, i < 2 ? 500 : 200, 10 + i * 10, NOW_MS + i * 1000)]);
  }
  const range = { from_us: (NOW_MS - 3_600_000) * 1000, to_us: (NOW_MS + 3_600_000) * 1000 };
  const before = store.overview(range);
  assert.equal(before.totals.requests, 20);
  assert.equal(before.totals.errors, 2);
  // Counted into rollups, the numbers are the same.
  store.roll((NOW_MS + 600_000) * 1000);
  const after = store.overview(range);
  assert.equal(after.totals.requests, 20);
  assert.equal(after.totals.errors, 2);
  assert.deepEqual(after.totals.latency, before.totals.latency);
  assert.equal(after.routes[0].route, "/users/:id");
  assert.equal(after.deployments[0].deployment_id, "dep_1");
  assert.equal(after.regions[0].region, "AMS");
  assert.equal(after.points.reduce((n, p) => n + p.requests, 0), 20);
  // Rolling again counts nothing twice.
  store.roll((NOW_MS + 600_000) * 1000);
  assert.equal(store.overview(range).totals.requests, 20);
});

test("a trace joins the request on g1t.page with the app's own spans and logs", async () => {
  const store = new Store(state());
  await ingestTail(store, [appEvent("ddddddddddddddd1", { logs: ["in handler"] }), edgeEvent("ddddddddddddddd1", 200, 80)]);
  const spans = readTraces(
    {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "web" } }, { key: "g1t.deployment.id", value: { stringValue: "dep_1" } }] },
          scopeSpans: [
            {
              spans: [
                { traceId: TRACE, spanId: "eeeeeeeeeeeeeee1", parentSpanId: "ddddddddddddddd1", name: "db.query", kind: 3, startTimeUnixNano: `${NOW_MS}010000000`.slice(0, 19), endTimeUnixNano: `${NOW_MS}050000000`.slice(0, 19) },
              ],
            },
          ],
        },
      ],
    },
    OTLP_DOOR,
    10,
  );
  const ok = await store.ingest(spans, [], "wrong-token");
  assert.equal(ok.accepted, false, "a token that is not the project's is refused");
  const { secret } = await store.createToken("prj_1", "ci", "u1");
  assert.equal((await store.ingest(spans, [], secret)).accepted, true);

  const trace = store.trace(TRACE)!;
  assert.deepEqual(trace.spans.map((s) => [s.name, s.parent_span_id]), [["GET /users/:id", null], ["db.query", "ddddddddddddddd1"]]);
  assert.equal(trace.logs[0].body, "in handler");
  // Found by its route too: an OTLP server span often has no address.
  const { secret: other } = await store.createToken("prj_1", "api", null);
  await store.ingest(
    readTraces({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "billing" } }] }, scopeSpans: [{ spans: [{ traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", spanId: "bbbbbbbbbbbbbbbb", name: "POST", kind: 2, startTimeUnixNano: `${NOW_MS}000000`, attributes: [{ key: "http.route", value: { stringValue: "/invoices" } }] }] }] }] }, OTLP_DOOR, 10),
    [],
    other,
  );
  assert.equal(store.requests({ text: "invoices" }).items.length, 1);
  const list = store.traces({});
  assert.equal(list.items[0].trace_id, TRACE);
  assert.equal(list.items[0].name, "GET /users/:id");
  assert.equal(list.items[0].span_count, 2);
});

test("logs are searched by words, levels and attributes, and paged", async () => {
  const store = new Store(state());
  const batch = emptyBatch();
  for (let i = 0; i < 30; i++) {
    batch.logs.push({
      id: `log${String(i).padStart(3, "0")}`,
      time_us: (NOW_MS + i) * 1000,
      severity: i % 3 === 0 ? "error" : "info",
      severity_number: i % 3 === 0 ? 17 : 9,
      body: i % 2 ? `payment captured for order ${i}` : `cache miss on key ${i}`,
      trace_id: null,
      span_id: null,
      request_id: null,
      attributes: { "user.id": `u${i % 5}` },
      service: "api",
      environment: "production",
      deployment_id: null,
      commit_sha: null,
      source: "otlp",
    });
  }
  const { secret } = await store.createToken("prj_1", "x", null);
  await store.ingest(batch, [], secret);
  assert.equal(store.logs({ text: "payment" }).items.length, 15);
  assert.equal(store.logs({ text: "payment captured" }).items.length, 15);
  assert.equal(store.logs({ text: "pay" }).items.length, 15, "the last word is a prefix");
  assert.equal(store.logs({ text: "level:error" }).items.length, 10);
  assert.equal(store.logs({ severities: ["error"], text: "cache" }).items.length, 5);
  assert.equal(store.logs({ text: "user.id=u1" }).items.length, 6);
  const first = store.logs({ limit: 20 });
  assert.equal(first.items.length, 20);
  const second = store.logs({ limit: 20, cursor: first.next });
  assert.equal(second.items.length, 10);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map((l) => l.id)).size, 30);
});

test("tokens: the deployments' one is kept and the same each time; others can be revoked", async () => {
  const store = new Store(state());
  const a = await store.deploymentToken("prj_1");
  const b = await store.deploymentToken("prj_1");
  assert.equal(a.secret, b.secret);
  assert.match(a.secret, /^g1to_prj_1_[0-9a-f]{48}$/);
  const made = await store.createToken("prj_1", "laptop", "u1");
  const listed = store.tokens();
  assert.deepEqual(listed.map((t) => t.name), ["laptop"], "the deployments' token is g1t's, not listed");
  assert.ok(!JSON.stringify(listed).includes(made.secret), "a token's secret is never listed");
  const managedId = String((store.sql.exec("SELECT id FROM tokens WHERE managed = 1").toArray()[0] as { id: string }).id);
  assert.equal(store.revokeToken(managedId), false);
  assert.equal(store.revokeToken(made.token.id), true);
  assert.equal(await store.checkToken(made.secret), false);
});

test("retention removes what is past it, and turning deployments off stops tail events", async () => {
  const store = new Store(state());
  await ingestTail(store, [appEvent("fffffffffffffff1", { logs: ["old"] }), edgeEvent("fffffffffffffff1", 200, 5)]);
  store.prune((NOW_MS + 8 * 86_400_000) * 1000);
  assert.equal(store.requests({}).items.length, 0);
  assert.equal(store.logs({}).items.length, 0);
  // Counted before they went.
  assert.equal(store.overview({ from_us: (NOW_MS - 60_000) * 1000, to_us: (NOW_MS + 60_000) * 1000 }).totals.requests, 1);
  store.setSettings({ deployments: false });
  const [g] = readTail([appEvent("fffffffffffffff2")]);
  assert.equal((await store.ingest(g.batch, g.halves)).accepted, false);
  assert.throws(() => store.setSettings({ retention_days: 365 }));
});

test("exports refuse addresses that loop or stay inside a network", () => {
  const store = new Store(state());
  assert.throws(() => store.putExport({ name: "x", endpoint: "https://otel.g1t.sh", signals: ["traces"], enabled: true }));
  assert.throws(() => store.putExport({ name: "x", endpoint: "http://collector.example.com", signals: ["traces"], enabled: true }));
  assert.throws(() => store.putExport({ name: "x", endpoint: "https://10.0.0.4", signals: ["traces"], enabled: true }));
  const made = store.putExport({ name: "Honeycomb", endpoint: "https://api.honeycomb.io", signals: ["traces", "logs"], headers: { "x-honeycomb-team": "secret" }, enabled: true });
  assert.deepEqual(made.header_names, ["x-honeycomb-team"]);
  assert.ok(!JSON.stringify(store.exports()).includes("secret"));
  // Changing it without giving the header again keeps it.
  store.putExport({ id: made.id, name: "Honeycomb", endpoint: "https://api.honeycomb.io", signals: ["traces"], enabled: false });
  assert.deepEqual(store.exports()[0].header_names, ["x-honeycomb-team"]);
});

test("search text, FTS queries and chart steps", () => {
  assert.deepEqual(parseSearch('status:500 "two words" user.id=7 timeout https://x.y'), {
    words: ["two words", "timeout", "https://x.y"],
    pairs: [["status", "500"], ["user.id", "7"]],
  });
  assert.equal(ftsQuery(["a", 'b"c']), '"a" AND "b""c"*');
  assert.equal(stepFor(3_600_000_000), 60);
  assert.equal(stepFor(86_400_000_000), 900);
  assert.equal(aggregate([]).length, 0);
});

test("a project of a workspace past its day's share is refused, and tail events keep only their requests", async () => {
  const store = new Store(state());
  const { secret } = await store.createToken("prj_1", "ci", "u1");
  const batch = (bytes: number) => ({ ...emptyBatch(), bytes });
  assert.deepEqual(await store.ingest(batch(60), [], secret, false), { accepted: true, bytes: 60 });
  assert.equal(store.todayBytes(), 60);
  const refused = await store.ingest(batch(50), [], secret, true);
  assert.deepEqual(refused, { accepted: false, reason: "quota" });
  assert.equal(store.todayBytes(), 60, "nothing refused is counted");
  // Not over (the plan, or a workspace not known yet): nothing is refused.
  assert.equal((await store.ingest(batch(5000), [], secret)).accepted, true);
  // Tail events past the share keep their requests, not their logs, and count only what they kept.
  const tail = { ...emptyBatch(), bytes: 10_000 };
  tail.logs.push({ id: "l1", time_us: 1, severity: "info", severity_number: 9, body: "x".repeat(9000), trace_id: null, span_id: null, request_id: null, attributes: {}, service: "web", environment: null, deployment_id: null, commit_sha: null, source: "cloudflare" });
  const kept = await store.ingest(tail, [], undefined, true);
  assert.equal(kept.accepted, true);
  assert.ok((kept.bytes ?? 0) < 100);
  assert.equal(store.logs({}).items.length, 0);
  assert.equal(store.usage().today_bytes, store.todayBytes());
  // The workspace is remembered as the site says it.
  assert.equal(store.workspaceOf(), null);
  store.setWorkspace(" Acme ");
  assert.equal(store.workspaceOf(), "acme");
  store.setWorkspace("not a slug!");
  assert.equal(store.workspaceOf(), "acme");
});
