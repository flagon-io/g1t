---
title: Agent telemetry
description: Record coding agents' sessions and what they cost from their own OpenTelemetry, with no plugin installed. Settings to roll out for Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot, what g1t keeps and drops, and the OTLP endpoints.
---

Most coding agents can export OpenTelemetry: what each request used and,
for some, what it cost. Point that export at g1t and each session's usage
and cost are recorded on its [session](/guides/sessions/), and counted in
[Spend](/guides/spend/), with nothing installed on the machine. Settings
rolled out to every machine (managed settings) cover a whole team at once.

g1t takes the export at the API's address, as OTLP over HTTP:

```text
https://api.g1t.sh/v1/logs
https://api.g1t.sh/v1/metrics
```

Most exporters add those paths themselves, so the endpoint to give them is
`https://api.g1t.sh`. The token goes in the `Authorization` header.

## What g1t keeps and drops

g1t reads the few events and metrics that say what a request used, and
drops everything else in the export unread. Prompts and responses never
reach g1t's storage, whatever the harness is set to send.

| Kept                                                                                    | Dropped                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tokens by model: input, output, cache reads and cache writes                            | Prompts (`user_prompt`, `codex.user_prompt`), however the harness's prompt logging is set            |
| The cost the harness reported (Claude Code's `cost_usd`, Codex's `usage.estimated_usd`) | Responses (`assistant_response`, `codex.agent_response`, Gemini CLI's `response_text`)               |
| The harness's session id (`session.id`, `conversation.id`, `cursor.conversation.id`)    | Tool calls, their input and output (`tool_result`, `codex.tool_result`), request and response bodies |
| The repository the export names, as `owner/name`                                        | Cursor's `conversation.*` messages, every other event, and every other attribute                     |
| For a workspace token only: the address that says whose session it is (`user.email`)    | Traces: g1t doesn't take `/v1/traces` here                                                           |

Turn your harness's own prompt logging off anyway (each snippet below
does), so prompts never leave the machine.

## Which token

Make a token with the **Work: write** permission (`work:write`), which
recording sessions needs.

- **Your own [personal access token](/guides/authentication/)**, in your
  own settings: every session the export names is yours, whatever address
  the records carry.
- **A [workspace token](/guides/authentication/#workspace-tokens)**, in
  settings rolled out to every machine: each session is the member's whose
  address the records name (`user.email`, or Cursor's `cursor.user.email`),
  matched only through an address that member has
  [verified on g1t](/guides/authentication/#email-addresses). Records g1t
  can't match to a member of the token's workspace aren't kept, and the
  export's answer says how many (a partial success). Sessions start only in
  the workspace's own repositories, as the token reaches them.

A workflow job's token can't send agent telemetry.

## How sessions are found

Each harness names its session: Claude Code's and Gemini CLI's
`session.id`, Codex's `conversation.id`, Cursor's `cursor.conversation.id`.
g1t gives the usage to that person's session with that id, in whichever
repository it was recorded, such as one the
[Claude Code plugin](/guides/claude-code-plugin/) or a hook started.

A session nobody has started yet needs a repository, and OpenTelemetry
names none on its own. g1t starts the session, as its person, in the
repository the export names, if they may work in it:

- **`g1t.repository`**, a resource attribute you set:
  `OTEL_RESOURCE_ATTRIBUTES=g1t.repository=acme/web`.
- **Claude Code's repository attributes**, with
  `OTEL_METRICS_INCLUDE_REPOSITORY=true`: its git remote's owner and name.
  g1t uses its own repository of that owner and name.

Otherwise the usage waits, for up to 30 days, for a session with that id
to start, and is given to it then. A session started from telemetry ends
on its own once its exports stop for 30 minutes.

### With the plugin as well

A session is never counted twice. Its usage comes from one place:

- **The plugin's report wins.** A session whose plugin reported its usage,
  or one of whose subagents' plugins did, keeps the plugin's figures, and
  telemetry adds nothing to it. If telemetry got there first, the
  plugin's report replaces it.
- **Logs or metrics, not both.** A harness that exports both says the same
  requests twice. g1t reads a session's log records when any arrived, and
  its metrics only when none did.

### What a session cost

The cost is what the harness reported, where it reports one: Claude
Code's, and Codex's for API-key accounts. Otherwise the tokens are priced
at list price, as the plugin's are, and a model without a known list price
leaves the cost [partial](/guides/spend/#sessions-with-no-known-cost).

## Claude Code

Put the variables in the `env` of Claude Code's
[managed settings](https://code.claude.com/docs/en/managed-settings), or
your own `~/.claude/settings.json`:

| System        | Managed settings file                                           |
| ------------- | --------------------------------------------------------------- |
| macOS         | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL | `/etc/claude-code/managed-settings.json`                        |
| Windows       | `C:\Program Files\ClaudeCode\managed-settings.json`             |

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://api.g1t.sh",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer g1t_…",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true",
    "OTEL_LOG_USER_PROMPTS": "0",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "OTEL_LOG_TOOL_DETAILS": "0"
  }
}
```

g1t reads the `api_request` event (tokens and `cost_usd` per request) and
the `claude_code.token.usage` and `claude_code.cost.usage` metrics. A
subagent's requests carry its parent's `session.id`, so they count with
their session.

## Codex

Put an `[otel]` table in Codex's managed configuration
(`/etc/codex/managed_config.toml`, or `~/.codex/managed_config.toml` on
Windows) or your own `~/.codex/config.toml`. Codex takes the whole
address, path included:

```toml
[otel]
log_user_prompt = false
exporter = { otlp-http = { endpoint = "https://api.g1t.sh/v1/logs", protocol = "binary", headers = { "Authorization" = "Bearer ${G1T_TOKEN}" } } }
```

g1t reads `codex.sse_event` when a response completes (its tokens, cached
ones apart) and `codex.turn_cost` (`usage.estimated_usd`), which Codex
sends for API-key accounts. On a ChatGPT plan the tokens are priced at
list price: a measure of the work, not a bill.

## Cursor

Cursor exports from its own servers, for the whole team, so it needs a
workspace token. In Cursor's **Team Settings**, **OpenTelemetry Export**
(Enterprise):

| Field    | Value                                     |
| -------- | ----------------------------------------- |
| Endpoint | `https://api.g1t.sh`                      |
| Header   | `Authorization: Bearer <workspace token>` |

g1t reads the `api_request` log (tokens by `cursor.model.name`) and gives
it to each member through their verified address (`cursor.user.email`).
Cursor reports no cost per request, so its tokens are priced at list
price where the model has one. Its metrics don't name a conversation and
aren't used. A personal token's Cursor records are refused: the export is
everyone's, not one person's.

## Gemini CLI

Put `telemetry` in Gemini CLI's system settings
(`/etc/gemini-cli/settings.json`,
`/Library/Application Support/GeminiCli/settings.json` or
`C:\ProgramData\gemini-cli\settings.json`) or your own
`~/.gemini/settings.json`. Prompt logging is on unless it is turned off:

```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "otlpEndpoint": "https://api.g1t.sh",
    "otlpProtocol": "http",
    "otlpHeaders": { "Authorization": "Bearer g1t_…" },
    "logPrompts": false
  }
}
```

g1t reads `gemini_cli.api_response` (tokens, with thoughts counted as
output) and the `gemini_cli.token.usage` metric.

## GitHub Copilot in VS Code

Turn on Copilot Chat's OpenTelemetry in VS Code's settings, and give the
token through the standard variable in the environment VS Code starts in:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "https://api.g1t.sh",
  "github.copilot.chat.otel.captureContent": false
}
```

```sh
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer g1t_…"
```

g1t reads the `gen_ai.client.token.usage` metric. It names VS Code's
session rather than a conversation, so a Copilot session on g1t is a VS
Code window's, and Copilot's usage is tokens priced at list price: what
your plan bills is in GitHub's own reports.

## The endpoints

`POST /v1/logs` and `POST /v1/metrics` take an
[OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/) export request.

| Request            |                                                                                 |
| ------------------ | ------------------------------------------------------------------------------- |
| `Authorization`    | `Bearer g1t_…`: a personal access token or a workspace token with `work:write`. |
| `Content-Type`     | `application/x-protobuf` or `application/json`. The answer comes in the same.   |
| `Content-Encoding` | `gzip`, or none.                                                                |
| Size               | Up to 4 MiB as sent, and 16 MiB once inflated.                                  |

| Answer | When                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | Read. Empty when everything was kept; a `partialSuccess` with `rejectedLogRecords` or `rejectedDataPoints` and an `errorMessage` when some records weren't. |
| 400    | The body couldn't be read.                                                                                                                                  |
| 401    | No token, or one g1t doesn't know.                                                                                                                          |
| 403    | A token without `work:write`, or one that can't send it (a workflow job's).                                                                                 |
| 413    | The body is too large: send smaller batches.                                                                                                                |
| 415    | Another content type or encoding.                                                                                                                           |
| 429    | Too many requests, as for any [rate limit](/reference/rate-limits/).                                                                                        |

Errors are a `google.rpc.Status` (`code`, `message`). Records g1t doesn't
read, such as prompts and other events, are dropped without being counted
as rejected.

These aren't a [project's telemetry](/guides/observability/), which takes
OTLP at `/otlp/v1/…` with the project's ingest token.

## Limits

- An export that is retried after g1t kept it counts again. Exporters
  retry only when an export fails, so this is rare.
- A session's usage from metrics sent as running totals (cumulative)
  keeps the largest total seen; one restarted under the same id counts
  from its restart only.
- Records with no session id, and Cursor's metrics, aren't used.
