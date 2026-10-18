---
title: g1t developer resources
description: Start integrating with g1t using the REST API, OpenAPI specification, scoped access tokens, MCP server or official CLI.
---

Use g1t from an agent, an application or a terminal. Public repository
reads need no credentials. Private reads and writes require authorization.

## Choose an interface

| Resource              | Start here                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| REST API              | [g1t API reference](/reference/api/) and the [interactive explorer](/api/reference/)                       |
| OpenAPI specification | [JSON schema for the REST API](https://api.g1t.sh/openapi.json), including each operation's required scope |
| Authentication        | [g1t authentication and scopes](/guides/authentication/)                                                   |
| MCP                   | [g1t MCP tools](/reference/mcp/) at `https://mcp.g1t.sh`; authentication stays required                    |
| CLI                   | [Install the official g1t CLI](/guides/cli/) and read the [command reference](/reference/cli/)             |
| Compatibility         | [g1t API versioning and deprecation policy](/reference/versioning/)                                        |
| Agent instructions    | [llms.txt](https://g1t.sh/llms.txt) and the [full agent guide](https://g1t.sh/agents.md)                   |

For a language client, use the REST API directly or generate a client from
OpenAPI. g1t does not currently publish a standalone official language SDK.

## Make a first request

```sh
curl https://api.g1t.sh/repos -H 'X-G1t-Api-Version: 1'
```

The [free plan](https://g1t.sh/pricing) includes the forge without a card.
Create an account in the browser, then create a scoped token yourself in
[Settings → Access tokens](https://g1t.sh/settings/tokens).
There is no sales approval step. Agents can also use the
[device sign-in flow](/guides/authentication/) or MCP OAuth so the person
approves access in their browser. Never send a password to an agent.

## Test an integration

For an isolated core-forge environment, follow [Run g1t yourself](/guides/self-hosting/).
It uses local storage and Mailpit for email, and billing is disabled. Its
feature table lists differences from hosted g1t, including unavailable
deployments and runner-dependent checks. Keep production credentials out
of this environment; external integrations still contact the services you configure.

A disposable repository on g1t.sh is another way to test repository operations,
but it is production data with normal permissions and usage costs. g1t does
not currently offer a separate hosted API sandbox. Use a dedicated workspace
and only the scopes needed for the test.
