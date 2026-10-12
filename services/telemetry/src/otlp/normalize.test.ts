import assert from "node:assert/strict";
import test from "node:test";

import { OTLP_DOOR, readLogs, readMetrics, readTraces } from "./normalize.ts";
import { projectOfToken } from "./ingest.ts";

const resource = (attrs: Record<string, string>) => ({ attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })) });

test("a server span is a request, filed under its service and environment", () => {
  const batch = readTraces(
    {
      resourceSpans: [
        {
          resource: resource({ "service.name": "billing", "deployment.environment.name": "production", "vcs.ref.head.revision": "abc123" }),
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                  spanId: "00f067aa0ba902b7",
                  name: "POST",
                  kind: 2,
                  startTimeUnixNano: "1760000000000000000",
                  endTimeUnixNano: "1760000000120000000",
                  attributes: [
                    { key: "http.request.method", value: { stringValue: "POST" } },
                    { key: "url.path", value: { stringValue: "/invoices/12345" } },
                    { key: "http.response.status_code", value: { intValue: "502" } },
                  ],
                  events: [{ name: "exception", timeUnixNano: "1760000000100000000", attributes: [{ key: "exception.type", value: { stringValue: "UpstreamError" } }] }],
                  status: { code: 2, message: "upstream refused" },
                },
                // Ids of zeros are no ids: the span is dropped.
                { traceId: "00000000000000000000000000000000", spanId: "0000000000000000", startTimeUnixNano: "1" },
              ],
            },
          ],
        },
      ],
    },
    OTLP_DOOR,
    100,
  );
  assert.equal(batch.spans.length, 1);
  const span = batch.spans[0];
  assert.equal(span.service, "billing");
  assert.equal(span.environment, "production");
  assert.equal(span.commit_sha, "abc123");
  assert.equal(span.start_us, 1_760_000_000_000_000);
  assert.equal(span.duration_us, 120_000);
  assert.equal(span.status, "error");
  assert.equal(batch.requests.length, 1);
  assert.equal(batch.requests[0].route, "/invoices/:id");
  assert.equal(batch.requests[0].status, 502);
  assert.equal(batch.requests[0].outcome, "error");
  assert.equal(batch.errors[0].name, "UpstreamError");
});

test("an app on g1t.page has its requests counted from its tail events, not its SDK's spans", () => {
  const batch = readTraces(
    {
      resourceSpans: [
        {
          resource: resource({ "service.name": "web", "g1t.deployment.id": "dep_1" }),
          scopeSpans: [{ spans: [{ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", kind: "SPAN_KIND_SERVER" as never, startTimeUnixNano: "1760000000000000000" }] }],
        },
      ],
    },
    OTLP_DOOR,
    0,
  );
  assert.equal(batch.spans[0].kind, "server");
  assert.equal(batch.spans[0].deployment_id, "dep_1");
  assert.equal(batch.requests.length, 0);
});

test("log records keep their severity, body and trace", () => {
  const batch = readLogs(
    {
      resourceLogs: [
        {
          resource: resource({ "service.name": "worker" }),
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: "1760000000000000000", severityText: "warning", body: { stringValue: "slow" } },
                { observedTimeUnixNano: "1760000000000000000", severityNumber: 17, body: { kvlistValue: { values: [{ key: "a", value: { intValue: "1" } }] } }, attributes: [{ key: "exception.type", value: { stringValue: "Boom" } }] },
              ],
            },
          ],
        },
      ],
    },
    OTLP_DOOR,
    0,
  );
  assert.equal(batch.logs[0].severity, "warn");
  assert.equal(batch.logs[0].body, "slow");
  assert.equal(batch.logs[1].severity, "error");
  assert.equal(batch.logs[1].body, '{"a":1}');
  assert.equal(batch.errors.length, 1);
});

test("metrics of each kind become points", () => {
  const batch = readMetrics(
    {
      resourceMetrics: [
        {
          resource: resource({ "service.name": "api" }),
          scopeMetrics: [
            {
              metrics: [
                { name: "queue.depth", gauge: { dataPoints: [{ timeUnixNano: "1760000000000000000", asInt: "7" }] } },
                { name: "jobs", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ timeUnixNano: "1760000000000000000", asDouble: 3 }] } },
                { name: "latency", unit: "ms", histogram: { dataPoints: [{ timeUnixNano: "1760000000000000000", count: "4", sum: 40, explicitBounds: [10], bucketCounts: ["2", "2"] }] } },
              ],
            },
          ],
        },
      ],
    },
    OTLP_DOOR,
    0,
  );
  assert.deepEqual(batch.metrics.map((m) => [m.name, m.kind, m.value]), [["queue.depth", "gauge", 7], ["jobs", "sum", 3], ["latency", "histogram", 10]]);
  assert.equal(batch.metrics[1].monotonic, true);
  assert.deepEqual(batch.metrics[2].counts, [2, 2]);
});

test("a token names its project", () => {
  assert.equal(projectOfToken("g1to_prj_01J9ZK3_abcdef0123"), "prj_01J9ZK3");
  assert.equal(projectOfToken("g1t_prj_x_y"), null);
  assert.equal(projectOfToken("g1to_nounderscore"), null);
});
