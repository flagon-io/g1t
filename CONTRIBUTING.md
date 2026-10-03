# Contributing to g1t

g1t is built the way it asks others to build: issues and pull requests on
[g1t.sh/syntaqx/g1t](https://g1t.sh/syntaqx/g1t), checks that prove a change
done, and a merge queue that keeps `main` passing.

## A change ships with its docs

Documentation is part of the product, held to the same bar as the code.
A pull request that changes what someone can do, see or call changes the
docs in the same pull request:

| If you change | Update |
| --- | --- |
| Something a person does on g1t.sh | The guide for it in `apps/docs/src/content/docs/guides/` |
| An API route, a field, or an MCP tool | `apps/api/src/operations.rs` descriptions (they feed the OpenAPI document and the API reference), `reference/mcp.md`, and any guide that shows the call |
| How agents behave | `guides/g1t-agents.md`, and `apps/web/public/llms.txt` |
| Settings, limits or prices | The page that names them, and the table it is in |
| A new feature | A section in the guide that owns it, linked from the docs home if it is a new task |

The style, in short: plain sentences, second person, no marketing words,
sentence-case headings, a numbered list for steps, a table for options, and
every API mention with its exact route or tool name. Examples are copyable
and real. Nothing is documented that the code does not do.

Check the docs build before you push:

```sh
cd apps/docs && npm run build
```

## Before you push

- `cargo test` in the crate or service you changed.
- `npx tsc -b --force` in `apps/web` (the incremental build misses changes
  in `packages/contracts`).
- Look at what you changed in a browser. Screenshots catch what type
  checks do not.
