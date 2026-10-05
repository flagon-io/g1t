---
title: Deployments
description: A project's production on every push and a live preview of every branch with a pull request, on g1t.page. Scales to zero, and billed to the workspace.
---

Deployments put your [project](/guides/projects/) on the web. Every branch
with a pull request gets its own live preview, linked on the pull request,
and the default branch goes to
production on every push. Reviewers, and the agents reviewing for you,
click through the change instead of reading a diff.

Apps run on Cloudflare Workers, on `g1t.page`:

| | Address |
| --- | --- |
| Production | `https://<project>-<workspace>.g1t.page` |
| Preview of the branch `fix-login` | `https://<project>-git-fix-login-<workspace>.g1t.page` |

A preview's address follows its branch, so it stays the same for every push
to it. A pull request from a fork, as g1t's agents make them, is named
`pr-<number>` in place of the branch. A name too long for an address, or
one another app already has, is shortened or given a short suffix.

An app runs only while it answers a request. One nobody visits runs
nothing and costs nothing, and the next visit wakes it in milliseconds.

Deployments are a paid feature, turned on per workspace with a monthly
plan, and then per project. Nothing deploys until you turn it on, and
one click turns it off again.

## Turn on deployments

1. **Turn on the plan for the workspace.** An owner opens
   **Settings → Billing**, `g1t.sh/<workspace>/-/billing`, and under
   **Plans** chooses **Turn on Deployments**, then pays on the card page.
   Back on Billing, the plan says **On** with its renewal date.
2. **Turn on deployments for a project.** Any member opens the project's
   **Settings → Deployments**, `g1t.sh/<workspace>/<project>/settings/deployments`,
   or chooses **Deploy** on its overview,
   and chooses **Turn on deployments**.

Production starts building at once from the default branch. Every pull
request opened or pushed to from then on gets a preview.

While payments on g1t are in test mode, no real card is charged: use the
test card `4242 4242 4242 4242` with any future date and any code.

## What deploys

g1t looks at the project's root directory and builds it the way it is meant to be built.
You do not configure anything for the common cases.

| The project has | g1t |
| --- | --- |
| `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` | Builds it as a **Workers project**: installs dependencies, runs `wrangler deploy --dry-run` to bundle it (which runs the config's own `build` command), and deploys the bundle with the config's static assets, `compatibility_date`, `compatibility_flags` and `vars`. |
| A `build` script in `package.json` | Installs dependencies, runs `npm run build`, and serves the output as a **static site**. |
| An `index.html` and nothing to build | Serves it as it is. |

Dependencies are installed by the lockfile that is there: `npm ci`,
`pnpm install --frozen-lockfile`, `yarn install` or `bun install`, and
`npm install` with no lockfile.

A static site is served from the first of these that exists after the
build: `dist`, `build`, `out`, `public`, `_site`, `.output/public`. Set
**Output directory** to choose another.

### Static sites

- A site without a `404.html` is treated as a single-page app: an address
  that matches no file serves `index.html`. With a `404.html`, that page
  is served instead, with status 404.
- `_headers` and `_redirects` files in the output are honored, in
  [Cloudflare's format](https://developers.cloudflare.com/workers/static-assets/headers/).
- Up to 20,000 files, and 25 MiB per file: Cloudflare's limits.

### Workers projects

- Your Worker's `fetch` handler runs as written, and its static assets
  are served under the binding name your config gives them. Cron triggers
  in the config are not scheduled.
- `vars` are deployed as plain-text bindings (or JSON, for objects). Rows
  of the project's [secrets and variables](/guides/secrets-and-variables/)
  available to Deployments are bound too, and replace a `var` of the same
  name: secrets as secret bindings.
- **Not provisioned yet:** D1, KV, R2, Durable Objects, Queues, service
  bindings, Vectorize, Hyperdrive, Workers AI and Workflows. A project that
  declares any of them still deploys, without them, and its deployment
  lists each one it left out. Code that needs them should check that the
  binding is there.

## Addresses of other projects

A project that [depends on another](/guides/projects/#dependencies) with
`as: API_URL` gets that project's address as `API_URL`, in its build and in
its running app:

| Building | `API_URL` is |
| --- | --- |
| Production | The other project's production. |
| A preview of branch `x` | The other project's preview of `x` if it is up, else its production. |

A secret or variable of the same name wins over it.

### Preview stacks

A change to an API is best seen in the apps that call it. On a pull
request whose preview is up, **Preview them against this change** (under
**Affects**) builds a preview of every project that uses this one, from its
own default branch, under the same branch name. Each gets this preview's
address through its variable. They come down with their idle days, like
any preview.

## Previews of branches

A preview is built when a pull request is opened, when it is marked ready,
and on every push to it, including an agent's. Pull requests from forks,
which is how g1t's agents work, are built from the fork.

The pull request shows the deployment as a check named **g1t / deploy**:

| State | Means |
| --- | --- |
| Pending, "Building" | The build is running. The link opens its log. |
| Passed, "Preview is live" | The link opens the preview. |
| Failed, "Deployment failed" | The link opens the build log and the reason. |

A newer push replaces a build that is still running for the same pull
request. Previews are marked `noindex`, so search engines leave them alone.

## Production

Each push to the default branch, which is each merge on a protected
branch, builds and replaces production. The **Deployments** page shows the
live address, the commit it runs and when it went up.

## When apps come down

Nothing keeps running unasked. An app comes down, and stops costing
anything, when:

| | |
| --- | --- |
| Its pull request is merged or closed | That preview, at once. |
| No one visits a preview for the project's **idle days** | That preview, at the next sweep (every 10 minutes). The default is 7 days. |
| You choose **Take down** on the Deployments page | That app, at once. |
| You turn off previews or production | All of that kind, at once. |
| You choose **Turn off deployments** | Every app of the project, at once, and no more builds. |
| The workspace's plan ends or its payment fails | Every app of the workspace, at the next sweep. |

A preview that came down comes back with the next push to its pull
request, or **Redeploy** on the Deployments page.

## Settings

Under the project's **Settings → Deployments**,
`g1t.sh/<workspace>/<repo>/settings/deployments`:

| Setting | Default | |
| --- | --- | --- |
| Production | On | Deploy the default branch on every push. |
| Previews | On | A preview for every branch with an open pull request. |
| Build command | The project's own | Runs instead of `npm run build`, or before bundling a Workers project. |
| Output directory | Found by itself | What a static site serves. |
| Idle days | 7 | 1 to 90. A preview no one visits this long comes down. |

## Secrets and variables

Builds and running apps read the project's
[secrets and variables](/guides/secrets-and-variables/) that are
available to Deployments, and the workspace's that reach it:

| | Reads |
| --- | --- |
| A production build, and production | Each key's Production row, else its row for all environments. |
| A preview build, and the preview | Each key's Preview row, else its row for all environments. |

The build gets them as environment variables, with secrets hidden in its
log. The running app gets them as bindings, `env.KEY`, put in place by g1t
rather than the build. A preview of a pull request from outside the
workspace is built and runs with config only, no secrets.

For example, a `STRIPE_KEY` secret with a Production row holding the live
key and a Preview row holding the test key gives every preview the test
key.

## What it costs

Deployments are never free, including while the rest of g1t is.

**The plan:** $5 a month per workspace, charged by card, renewing monthly.
It includes, each calendar month (UTC):

| Included | |
| --- | --- |
| 10 apps | The most apps up at once: production and previews together, across the workspace's projects. |
| 1 million requests | To all of the workspace's apps. |
| 3 million CPU milliseconds | Time your code spends computing. Waiting on the network is not counted. |

**Usage past that,** and **every build**, come out of the workspace's
[credit](/guides/usage-and-billing/#add-credit) at Cloudflare's price plus
20%:

| | Price |
| --- | --- |
| A build | $0.0015 a minute, by the second, whether it succeeds or fails. Not part of the plan. |
| Each app past 10 | $0.024 a month |
| Each million requests past 1 million | $0.36 |
| Each million CPU milliseconds past 3 million | $0.024 |

Builds are charged when they finish. Usage past the allowance is charged
once, on the first sweep after the month ends, as one line: *Deployments in
2026-10 past the plan*.

An app that no one visits costs nothing beyond counting toward the 10. That
is why previews come down when their pull request closes and after their
idle days.

### Seeing what you use

- **Billing**, under the Deployments plan, shows this month's apps,
  requests and CPU time against what the plan includes, and what builds
  have cost. Requests and CPU time are counted from Cloudflare's analytics
  every 10 minutes.
- The **statement** on Billing lists every build (*Building acme/web to
  production (48 s)*) and every month's usage past the plan.
- Each build's page shows how long it ran.

## Turn it off

- **For a project:** **Turn off deployments** under its **Settings →
  Deployments**. Every app comes down at once. Turning it on again
  rebuilds production.
- **For the workspace:** an owner chooses **Turn off at the end of the
  period** under the plan on Billing. Deployments keep working until the
  date shown; then every app comes down and nothing more is charged.
  **Keep Deployments** takes it back before then.

Usage from the month that is under way is still charged once it ends.

## How it works

1. A pull request opens, or someone pushes. The deployments service hears
   of it, and checks that the workspace's plan is on.
2. It starts a build in a sandbox of its own, the same machines that run
   [GitHub Actions](/guides/actions/) and agents. The sandbox checks out
   the commit with a read-only token that expires in 30 minutes.
3. The sandbox builds, then lists its files. g1t opens an upload with
   Cloudflare for exactly those files and hands the sandbox a key that can
   upload them and nothing else. Files Cloudflare already has are skipped.
4. The sandbox sends the Worker's code to g1t, which puts the app in
   g1t's [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
   namespace, under the name in its address.
5. A request to `*.g1t.page` reaches g1t's dispatcher, which runs the app
   by the name in the hostname. Nothing else is looked up.

Your code never holds a Cloudflare credential, and apps are served from
`g1t.page`, not `g1t.sh`, so they share no cookies or origin with the site
you sign in to.

## Troubleshooting

| You see | Do |
| --- | --- |
| "Deployments is a paid feature, and it is not on" | An owner turns on the plan under Billing. |
| "found nothing to serve" | Add a `build` script, an `index.html`, or a Workers config; or set **Output directory**. |
| "the output directory `x` does not exist after the build" | The build wrote elsewhere: check its log, then fix **Output directory**. |
| "`d1_databases` is not provisioned on g1t.page yet" | The app deployed without that binding. See [Workers projects](#workers-projects). |
| A preview page says "This preview is not up" | It came down (see [When apps come down](#when-apps-come-down)). Push, or choose **Redeploy**. |
| "The build did not finish in 45 minutes" | Builds are stopped after 45 minutes. Make the build faster, or build less for previews with **Build command**. |

## Running your own g1t

Deployments need a Workers for Platforms namespace and a zone for apps:

1. Create the namespace: `npx wrangler dispatch-namespace create g1t-deployments`.
2. Add a proxied wildcard DNS record (`*`, `AAAA`, `100::`) on the apps'
   zone, and set the zone in `services/pages/wrangler.jsonc`.
3. Create an API token with **Workers Scripts: Edit** and **Account
   Analytics: Read**, and store it:
   `npx wrangler secret put CLOUDFLARE_API_TOKEN` in `services/deployments`.
4. Deploy `services/deployments`, `services/pages`, and the runner.

Without a card processor configured, every feature is on and nothing is
charged.
