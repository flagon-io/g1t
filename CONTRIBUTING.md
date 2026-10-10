# Contributing to g1t

g1t is built the way it asks others to build: issues and pull requests on
[g1t.sh/flagon-io/g1t](https://g1t.sh/flagon-io/g1t), required checks that prove
a change works, and a merge queue that keeps `main` passing.

## A change ships with its docs

Documentation is part of the product, held to the same bar as the code.
A pull request that changes what someone can do, see or call changes the
docs in the same pull request:

| If you change | Update |
| --- | --- |
| Something a person does on g1t.sh | The guide for it in `apps/docs/src/content/docs/guides/` |
| An API route, a field, or an MCP tool | `apps/api/src/operations.rs` descriptions (they feed the OpenAPI document and the API reference), the example and notes for it in `apps/api/src/reference.json`, `reference/mcp.md`, and any guide that shows the call. Then refresh the docs' copy of the OpenAPI document with `G1T_WRITE_OPENAPI=1 cargo test -p g1t-api openapi`; `cargo test` fails until you do. |
| How agents behave | `guides/working-with-g1t.md`, and `apps/web/public/llms.txt` |
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

## Icons

- **Interface icons come from [Lucide](https://lucide.dev/icons).** In the
  apps, import them from `lucide-react`. In the docs, use `@lucide/astro`:
  import an icon component, or give `apps/docs/src/components/Card.astro`
  and `Aside.astro` a Lucide name such as `icon="git-branch"`. Starlight's
  own `<Card>`, `<LinkCard>` and `<Aside>` draw Starlight's icon set, so the
  docs import the wrappers in `apps/docs/src/components/` instead.
- **Brand marks come from [Simple Icons](https://simpleicons.org)**
  (`simple-icons`), and follow each brand's own usage guidelines. Add the
  dependency with the first one you show.
- **The g1t logo and illustrations are our own artwork**, in
  `apps/web/app/components/logo.tsx` and `art.tsx`.
- Never hand-copy an icon's SVG paths into a file. If Lucide lacks the
  icon you need, pick the closest one that it has.

## Before you push

- `cargo test` in the crate or service you changed.
- `npx tsc -b --force` in `apps/web` (the incremental build misses changes
  in `packages/contracts`).
- Look at what you changed in a browser. Screenshots catch what type
  checks do not.

## Deploying

Pushes to `main` deploy themselves: `.g1t/workflows/deploy.yml` runs
`scripts/deploy.mjs`, which deploys only the parts that changed, migrations
first. Every deployable part is listed in `deploy/stack.jsonc`; a new service
or app goes there, and in the table on
[How a self-hosted g1t runs](https://docs.g1t.sh/guides/self-hosting-architecture/#each-part)
(`npm run test:deploy` says what is missing).
[Deploy g1t to Cloudflare](https://docs.g1t.sh/guides/deploy-to-cloudflare/)
covers the tool, the workflow, rollbacks, adding a unit and first-time
setup.

- **Migrations run before the code**, so the old code reads the new schema
  for a minute or more. Add tables and columns; change what rows mean in
  two deploys (code that reads both forms first); never drop what live code
  still reads.
- **The self-hosted runner** is released, not deployed: bump `version` in
  `crates/runner/Cargo.toml`, merge, and push a `runner-v<version>` tag.
  `.g1t/workflows/runner-release.yml` builds, signs and publishes it, and
  runners update themselves to it. `scripts/runner-release.mjs` does the
  same by hand.

## Speed

Pages are a few rounds of service calls, and each round costs a trip to
the databases, so start calls together and add no rounds.

- Every page answers with `Server-Timing`: each loader, each service's
  calls and their database time. Look at it in DevTools when a page feels
  slow.
- `scripts/perf/measure.ps1` times pages from your machine (`-BrowserUA`
  for signed-out pages as a browser sees them). A page that only reads
  must not set the `g1t_d1` cookie: a new read-only service method goes in
  `READS` in `apps/web/app/lib/perf.ts`.
- Targets from the US: signed-out pages under 200 ms to first byte,
  signed-in pages under 400 ms, streamed panels within a second.
- Workers run without Smart Placement; `scripts/perf/placement-probe.mjs`
  measures a placement before you pin one.

## Rate limits

`RATE_LIMITS` in `packages/contracts/src/rate-limits.ts` is the table of
record, and the [rate limits page](https://docs.g1t.sh/reference/rate-limits/)
is the public one: change both, and the binding in the Worker's
`wrangler.jsonc`, together (`front-door-limits.test.ts` fails when they
disagree). Limits fail open, keys hash anything secret, and each Worker
takes its namespace ids from its own block of a hundred (41xx packages,
42xx web, 43xx repos, 44xx api, 45xx og, 46xx status).

## Operating g1t.sh

For Flagon staff.

- **Incidents** are declared, updated and resolved in sudo, under
  **Platform → Incidents**, and appear on status.g1t.sh within 30 seconds.
  Declare as soon as people are affected, and pick the higher severity
  when unsure. SEV1 (down for most people, or data at risk) gets an update
  at least every 30 minutes and SEV2 (a core part broken for many) at least
  hourly; both email subscribers and need a blameless postmortem within
  five working days.
- **An Artifacts outage:** `scripts/ops/gitstore-namespaces.mjs` shows a
  failing namespace. After 15 minutes, serve it read-only from the fallback
  git store (`scripts/ops/restore-to-gitstore.mjs restore`, then the repos
  Worker's secret `GIT_FALLBACK_NAMESPACES`) and open an incident. To
  switch back, `reconcile` anything the fallback took, then delete the
  secret. The script's header has every step.
- **Costs and margin**, model prices, credits and the platform pause are
  in sudo, under **Costs & margin**. The code is in `services/billing/src`
  (`costs.rs`, `margin.rs`, `pricing.rs`, `budget.rs`, `platform.rs`).
