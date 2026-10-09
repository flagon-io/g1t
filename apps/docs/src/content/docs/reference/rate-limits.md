---
title: Rate limits
description: How many requests the API, the MCP server, git over HTTPS and the site take a minute, what a limited request is answered with, and how to stay under the limits.
---

g1t limits how many requests a client can make in a minute, so that one
client cannot slow g1t down for everyone else or run up a repository
owner's bill. The limits are well above what a person or an agent working
normally reaches. Each counts requests over 60 seconds, approximately: a
client can sometimes get a few more through before it is limited.

## Limits

| Where | Counted by | Requests a minute |
| --- | --- | --- |
| REST API, with a token | Token | 1,000 |
| REST API, without a token | Client IP address | 60 |
| MCP server | Token | 1,000 |
| Git over HTTPS, with credentials | Credentials | 1,200 |
| Git over HTTPS, without credentials | Client IP address | 120 |
| Anonymous clones of one repository that are not cached | Repository | 120 |
| Pages on g1t.sh, signed in | Session | 1,200 |
| Pages on g1t.sh, signed out | Client IP address | 600 |
| Archive downloads, workflow run pages, logs and search, signed out | Client IP address | 30 |
| [Raw files](/guides/git/#raw-files) on g1tusercontent.com | Client IP address, together with pages signed out | 600 |
| Container and package registries | See [storage and pull limits](/guides/containers/#storage-and-pull-limits) | |

The REST API and the MCP server count apart: calls to one do not use up
the other's limit. A request with a token that is not valid counts against
its IP address, as a request without a token does. On g1t.sh, every
request from one IP address, signed in or not, also counts toward 3,000 a
minute.

Agents' sandboxes and workflow jobs report to g1t with their own
credentials. Those reports are not rate limited.

## When you are limited

A request past a limit is answered `429 Too Many Requests` with a
`Retry-After` header: the number of seconds to wait before trying again.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{ "error": { "code": "rate_limited", "message": "Too many requests with this token. Wait a minute and try again: https://docs.g1t.sh/reference/rate-limits/" } }
```

| Where | Body |
| --- | --- |
| REST API and MCP server | JSON in the [error shape](/reference/api/#errors) every endpoint uses, with `code` `rate_limited`. Through MCP it comes back as the HTTP answer to the request, not as a tool result. |
| Git over HTTPS | Plain text, which git prints after `remote:` or in its error. |
| Pages on g1t.sh, and raw files | Plain text. |

Branch on the `429` status or the `rate_limited` code, never on the
message. The API sends `Access-Control-Expose-Headers: retry-after`, so a
browser app can read the header too.

## Staying under the limits

- **Send a token.** Signed-in limits are much higher than anonymous ones,
  and they follow the token rather than the network you are on, so people
  sharing an office or a VPN do not share a limit.
- **Clone with credentials.** A clone is about three git requests. Use
  [a token as the password](/guides/git/#authentication) to count against your own
  limit rather than your network's.
- **Wait for `Retry-After`.** Retrying sooner is answered `429` again and
  counts against the limit.
- **Cache what does not change.** A commit's contents never change: read
  a commit by its SHA once and keep it.
- **Use webhooks instead of polling.** A [webhook](/guides/webhooks/)
  tells you when something changes, without a request a minute.

Repeated anonymous clones of the same commit are answered from a cache and
do not count against the repository's limit. If a limit gets in the way of
something you need to do, [contact support](https://g1t.sh/support).

## Running g1t yourself

An installation you run yourself has no rate limits. See
[run g1t yourself](/guides/self-hosting/).
