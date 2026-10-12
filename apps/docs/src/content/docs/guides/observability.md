---
title: Observability
description: A project's requests, logs, traces, metrics and errors, from its apps on g1t.page with nothing to set up, and from anything else over OpenTelemetry.
---

Observability shows what a [project](/guides/projects/)'s running software
does: every request it answers, every line it writes, every trace through
the services it calls, the metrics it reports, and its errors, grouped. It
is on every project's menu, under **Observability**.

It has two sources, and they meet in one place:

- **Apps on [g1t.page](/guides/deployments/).** Nothing to set up. Every
  request a deployed app answers arrives within seconds, with its status,
  how long it took, its CPU time, where in the world it was served, and
  every line it wrote with `console.log` and the like. Exceptions are
  grouped into errors. An [OpenTelemetry](https://opentelemetry.io/) SDK in
  the app sends its spans here too, with no configuration: g1t gives each
  app the endpoint and a token.
- **Anything else, over OpenTelemetry.** Software running on another host,
  a server of your own, a phone app or a background worker sends traces,
  logs and metrics to `https://otel.g1t.sh` with one of the project's
  ingest tokens, in OTLP over HTTP, JSON or protobuf. Any OpenTelemetry SDK
  or collector does this already.

Both arrive in the same store, so a request on g1t.page and the spans of
the API it called elsewhere are one trace.

## The pages

| Page | What it shows |
| --- | --- |
| **Overview** | Requests, error rate, and latency at the 50th, 95th and 99th percentiles, against the period before; requests and latency over time; each deployment's numbers, newest first; the busiest routes; open errors; the services reporting; and where requests were served |
| **Requests** | Every request, newest first: status, method and address, duration, CPU time, region and deployment. Narrow by status, failed only, a route, or search |
| **Logs** | Every line, newest first. Search words, a level or an attribute; follow it live |
| **Traces** | Each trace, with the services it touched, its spans and errors. A trace opens as a waterfall, with each span's attributes and events, and the logs written under it |
| **Errors** | Exceptions grouped by what they are and where they were thrown, with how often and since which deployment. Each can become an issue |
| **Metrics** | Every metric sent over OpenTelemetry, over time, averaged, summed or as a percentile, and grouped by service or any attribute |
| **Settings** | Ingest tokens, exports, retention, and what the project used this month |

Every page narrows by period (the last 15 minutes to the last 30 days),
environment, service and deployment, and the address says what it shows,
so a view can be shared by its link.

### Search

The Logs, Requests and Traces pages take the same search:

| You write | It finds |
| --- | --- |
| `timeout` | lines with the word, or a word starting with it at the end |
| `payment captured` | lines with both words |
| `"payment captured"` | the phrase |
| `level:error` | errors (and `level:warn`, `level:info`, `level:debug`) |
| `user.id=42` | records whose attribute `user.id` is `42` |
| `status:502`, `region:AMS`, `method:POST` | requests by a field of their own |
| `service:api`, `trace_id:…`, `deployment_id:…` | records from one service, trace or deployment |

### A regression points at its deployment

The Overview's **By deployment** table lists each deployment that served
requests in the period, newest first, with its requests, error rate and
95th-percentile latency. An error rate well above the deployment's
before it shows in red. Choosing a deployment narrows every page to it.
Each error group also says which deployment it was first seen on.

### Errors become issues

An error is grouped with others like it: the same name, the same message
once numbers, ids and quoted values are taken out, and the same place in
the code it was thrown from (its file and function, not its line, which
moves with every change). A thousand `TypeError: Cannot read 'name' of
user 41`, `… of user 977` are one group with a count.

**Make an issue** opens an issue with the error, its stack, how often it
happened, the deployment it began with, and links to its latest request
and trace. An error
marked **Resolve** opens again if it happens again; **Ignore** keeps it
quiet.

## Apps on g1t.page

Nothing to set up. Every request reaches an app through g1t.page's
dispatcher, which gives it an id and a trace and records it, so even a
request a site's files answered without running its code is counted. When
the app's code runs, Cloudflare hands g1t what it wrote and threw. Both
halves are filed under the project and the deployment that served it.

Each request the app receives carries two headers it can use:

| Header | What it is |
| --- | --- |
| `x-g1t-request-id` | The request's id on its page under **Requests**. Log it, or show it on an error page, to find the request again |
| `traceparent` | The request's trace ([W3C Trace Context](https://www.w3.org/TR/trace-context/)). An incoming `traceparent` is continued, so a caller's trace runs through |

### Spans from the app

Each app on g1t.page is deployed with OpenTelemetry's standard variables
set:

| Variable | Value |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://otel.g1t.sh` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `authorization=Bearer <the project's deployments token>`, a secret |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_SERVICE_NAME` | the project's name |
| `OTEL_RESOURCE_ATTRIBUTES` | `deployment.environment.name`, `g1t.deployment.id`, `g1t.project.id` and `vcs.ref.head.revision` |

An OpenTelemetry SDK that reads them sends its spans, logs and metrics
here as they are, and its server span continues the request's
`traceparent`, so the spans sit under the request in its trace. For a
Worker, [`@microlabs/otel-cf-workers`](https://github.com/evanderkoogh/otel-cf-workers)
reads the endpoint and headers from `env`:

```ts
// src/index.ts
import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";

const config: ResolveConfigFn = (env: Env) => ({
  exporter: {
    url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    headers: { authorization: env.OTEL_EXPORTER_OTLP_HEADERS.replace(/^authorization=/, "") },
  },
  service: { name: env.OTEL_SERVICE_NAME },
});

export default instrument({ async fetch(request, env) { /* … */ } }, config);
```

### Cloudflare's own spans

Every app on g1t.page is also traced by Cloudflare itself, with nothing in
its code: a span for each `fetch` it makes, each KV, D1, R2 and Durable
Object call, and its cache, under the request. They arrive in the
request's trace, next to any spans of the app's own SDK. Its logs are not
sent this way: they already arrive with each request.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` yourself, under the project's
[secrets and variables](/guides/secrets-and-variables/), to send the
app's OpenTelemetry somewhere else instead: g1t then sets none of these.
Requests and logs still arrive from g1t.page either way. A build that is
not trusted (a pull request from a fork) gets no token.

To stop apps on g1t.page reporting, turn off **Apps on g1t.page report
here** under the project's **Observability**, **Settings**. What is
already here stays.

## Sending from anywhere else

1. Under the project's **Observability**, **Settings**, choose **New
   token**, name it after what will send with it, and copy it: it is shown
   once. Tokens start with `g1to_`, and each can only send to its project.
2. Point your software at the endpoint, with the token:

   ```sh
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.g1t.sh
   OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer g1to_…"
   OTEL_SERVICE_NAME=billing-api
   OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
   ```

   Every OpenTelemetry SDK reads these: Node.js, Python, Go, Java, .NET,
   Ruby, PHP, Rust and the rest. `OTEL_SERVICE_NAME` is what the service is
   called on the pages, and `deployment.environment.name` its environment.
   `vcs.ref.head.revision`, the commit it runs, shows next to its numbers.

3. Run it. What it sends shows within seconds.

The endpoint takes OTLP over HTTP: `POST /v1/traces`, `/v1/logs` and
`/v1/metrics`, as `application/json` or `application/x-protobuf`, gzipped
or not, up to 8 MB a request. It answers as OTLP expects, so exporters
retry what should be retried and drop what should not. It also answers
browsers (CORS), for a web page that sends its own spans; a token in a page
can be read by anyone who opens it, so give a page a token of its own.

`https://api.g1t.sh/otlp` is the same endpoint at a second address.

### From an OpenTelemetry Collector

A collector already gathering telemetry sends it on with the
`otlphttp` exporter:

```yaml
exporters:
  otlphttp/g1t:
    endpoint: https://otel.g1t.sh
    headers:
      authorization: Bearer ${env:G1T_INGEST_TOKEN}

service:
  pipelines:
    traces: { receivers: [otlp], exporters: [otlphttp/g1t] }
    logs: { receivers: [otlp], exporters: [otlphttp/g1t] }
    metrics: { receivers: [otlp], exporters: [otlphttp/g1t] }
```

### Traces

Spans arrive as they are, with their attributes, events and links. Every
server span (`SpanKind.SERVER`) of software outside g1t.page is also a
request: it is on the Requests page and counted on the Overview, by its
`http.route` (or its path with ids taken out), status and duration. An
exception recorded on a span (its `exception` event) is an error.

### Logs

Log records arrive with their severity, body, attributes and, when the SDK
sets them, the trace and span they were written under, so a trace shows its
logs. A record with `exception.type` or `exception.message` attributes is
also an error.

### Metrics

Gauges, sums, histograms and summaries are kept as points. A counter
(a cumulative, monotonic sum) shows as its increase in each step of the
chart. A histogram shows as its mean, or its 50th, 95th or 99th
percentile from its buckets. Exponential histograms keep their count,
sum, minimum and maximum.

## Sending it on elsewhere too

An **export** sends everything that arrives on to any OTLP/HTTP endpoint
as well: a collector of your own, or any tool that takes OpenTelemetry.
Requests on g1t.page go as server spans, and their logs as log records, so
the tool shows the project's apps as it shows any other service.

Under **Observability**, **Settings**, choose **New export**, give its
address (g1t adds `/v1/traces`, `/v1/logs` and `/v1/metrics`), the signals
to send, and the headers it needs, such as an API key. Header values are
kept as secrets and never shown again. An export's last error, if any,
shows under it. Exports go to addresses on the internet over `https` only.

## Retention

Requests, logs, spans and metric points are kept for 7 days, or 1, 3, 14 or
30, as the project's **Observability**, **Settings** say. The Overview's
per-minute numbers are kept for 90 days whatever the retention, so its
charts reach back further than its requests do. A project's store holds up
to 4 GB; past that, its oldest day goes first.

## On the free plan

A project in a workspace on the free plan can send **1 GB a month**, held a
day at a time: about 34 MB a day (UTC), a thirtieth of the month, so a burst
cannot use the month up in an hour. What counts is what arrives: an OTLP
request's body once unzipped, and the rows kept from an app's tail events.
**Settings** shows what arrived this month and today.

Past the day's share, OTLP requests are answered `429 Too Many Requests`
with the reason, until 00:00 UTC; OpenTelemetry SDKs retry or drop the
batch. Requests from an app on g1t.page still arrive, so its charts and
request list keep going, but without their logs. On the g1t plan there is
no such cap. OTLP is also limited to 600 requests a minute from one
address; see [rate limits](/reference/rate-limits/).

## Who can do what

| | Who |
| --- | --- |
| See the pages | People with a role on the project's repository, even when its code is public: logs and addresses can hold what only the people running it should read |
| Resolve, ignore or reopen errors | Triage and up |
| Make an issue of an error | Anyone who can open issues |
| Tokens, exports, retention and the g1t.page switch | Admin |

## The API and MCP

Everything on the pages is in the [REST API](/reference/api/), under
**Observability**, with the `observability:read` scope, and
`observability:write` to change errors, settings, tokens and exports.

Coding agents read it through the `observability` tool of the
[MCP server](/reference/mcp/): the overview, requests, logs, traces,
errors and metrics. A coding agent fixing an error reads its stack, its
request and its trace the same way you do.

## What it costs

Nothing yet, while g1t is in alpha. **Observability**, **Settings**,
**This month** shows what the project sent and keeps: the bytes received,
requests, log lines, spans and metric points.

## How it works

Each project's telemetry is kept in a store of its own, a Durable Object
with its own SQLite database, so one project's volume never slows another's
pages. Log bodies are indexed for full-text search.

- **g1t.page.** The dispatcher in front of every app names the telemetry
  service as its Tail Worker, and so does each app. Each app's own
  Cloudflare tracing is exported to the service too, over OTLP, and filed
  under the app's project and deployment. The dispatcher's half
  of a request (status, time, place) and the app's half (logs, exceptions,
  CPU time) arrive apart and are joined by the request's id.
- **OTLP.** The endpoint reads the project from the token, checks it
  against the project's tokens (kept as hashes), decodes the request, and
  files each record by its resource: `service.name`,
  `deployment.environment.name` and `g1t.deployment.id`.
- **Counting.** Each minute, the requests of the minute before are counted
  into per-minute numbers by service, environment, deployment and route,
  with latency and CPU time as histograms, which is how percentiles over any
  period come from a few numbers. The newest minute is counted as it stands
  when a page asks.

On a [self-hosted installation](/guides/self-hosting/), Observability runs
with the rest of g1t; software sends to `http://localhost:8789/otlp`.
