---
title: g1t API versioning and deprecation policy
description: Select the g1t REST API contract and understand how breaking changes, deprecation notices and retirement dates are communicated.
---

The current REST contract is version `1`. Send `X-G1t-Api-Version: 1` or
omit the header to select it. REST responses include `X-G1t-Api-Version: 1`.
Unsupported version values return `422` before an operation runs.
Use unprefixed URLs at `https://api.g1t.sh`; `/v1/` is a compatibility alias.
MCP negotiates its own protocol version during initialization.

## Compatible and breaking changes

New endpoints and optional fields may be added within a version. Clients
should ignore fields they do not recognize. Breaking contract changes need
a new version value and a migration guide.

## Deprecation notices

Before retiring a version or endpoint, g1t will publish its replacement and
retirement date in the docs and signal the change on affected responses:

- `Deprecation`: an [RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html)
  Structured Field date (an `@` followed by Unix seconds).
- `Sunset`: an [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594.html)
  HTTP date for the retirement time.
- `Link`: a link with `rel="deprecation"` pointing to the migration guide.

No REST version is currently deprecated and no retirement date is set.
These headers are absent until a deprecation is announced. A fixed minimum
notice period has not been established; this policy does not promise one.

See the [g1t API reference](/reference/api/) for authentication, errors and pagination.
