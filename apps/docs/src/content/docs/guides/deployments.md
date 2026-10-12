---
title: Deployments
description: A project's production on every push and a live preview of every branch with a pull request, on g1t.page. Scales to zero, and billed to the workspace.
---

Deployments put your [project](/guides/projects/) on the web. They are off
for every project until you turn them on. Once they are on, every branch
with a pull request gets its own live preview, linked on the pull request,
and the default branch goes to production on every push. Reviewers, and the agents reviewing for you,
click through the change instead of reading a diff. A [mirror](/guides/mirroring/)
deploys nothing while the remote leads it: pushes copied in from the remote
don't build, and its **Deployments** page comes with a takeover.

Apps run on Cloudflare Workers, on `g1t.page`:

| | Address |
| --- | --- |
| Production | `https://<project>-<workspace>.g1t.page` |
| Preview of the branch `fix-login` | `https://<project>-git-fix-login-<workspace>.g1t.page` |

A preview's address follows its branch, so it stays the same for every push
to it. A pull request from a fork, as g1t's agents make them, is named
`pr-<number>` in place of the branch. A name too long for an address, or
one another app already has, is shortened or given a short suffix.

A workspace whose name ends like a domain is written without that last
hyphen: `flagon-io` gives `https://web-flagonio.g1t.page`, not
`web-flagon-io.g1t.page`. Browsers read `flagon-io` in an address as a
copy of `flagon.io`, and warn people who visit flagon.io that the page
looks fake. Apps made before this moved to the new address on their own;
the old one redirects to it.

When a workspace is [renamed](/guides/workspaces/#rename-a-workspace), or a
repository is [transferred](/guides/transferring-repositories/#deployments)
to another workspace or [renamed](/guides/managing-repositories/), its apps
are built again under addresses with the new name, and the old addresses
redirect to them for 90 days. A rebuild that fails is tried again an hour
later, then two hours after that. After three failures with the same
error, or after one whose commit no longer exists, it is not tried again
until you push or choose **Redeploy**.

When the [default branch changes](/guides/managing-repositories/), production
is built again from the new default branch. An
[archived](/guides/managing-repositories/) repository's apps keep serving.

Every build is also a deployment in the repository's one list of
deployments, beside those reported from any CI and those g1t Actions
jobs make, with the source `g1t_page` and the environment `production` or
`preview`. See [Deployments API](/guides/deployments-api/) to read them,
report your own, and hear of them by webhook.

An app runs only while it answers a request. One nobody visits runs
nothing and costs nothing, and the next visit wakes it in milliseconds.

Deployments are part of the [g1t plan](/guides/usage-and-billing/#the-g1t-plan),
and are opt-in per project. A project set to deploy on g1t, with
deployments off, says **Deployments are off** on its overview, with **Turn on deployments** for
people with the Admin [role](/guides/access-and-roles/) on its repository. Nothing builds or runs until you turn them on, and one click turns
them off again.

## Turn on deployments

1. **Start the g1t plan for the workspace**, if it is not on. An owner
   opens **Settings → Billing and plans**, `g1t.sh/<workspace>/-/billing`,
   and chooses **Start the g1t plan** on the **g1t** card. Back on
   Billing, the card says **On the g1t plan**. The trial does not pay for
   deployments.
2. **Turn on deployments for a project.** Someone with the Admin role on
   its repository opens the project's
   **Settings → Deployments**, `g1t.sh/<workspace>/<project>/settings/deployments`,
   or chooses **Deploy** on its overview,
   and chooses **Turn on deployments**.

Production starts building at once from the default branch. Every pull
request opened or pushed to from then on gets a preview.

Deployments are for projects g1t runs. Not every project is one: a
library, a tool or documentation is published rather than deployed, and
an app may be deployed by its own pipeline somewhere else. Only a project
that is [an app or site deployed on g1t](/guides/projects/#what-a-project-is)
is asked to turn deployments on. Any other project's **Deployments** page
still turns them on; doing so makes it an app deployed on g1t, including
one that was deployed elsewhere. A project set to be a library, a tool or
something else cannot have deployments turned on until that setting
changes.

While payments on g1t are in test mode, no real card is charged: use the
test card `4242 4242 4242 4242` with any future date and any code.

## What deploys

g1t looks at the project's root directory and builds it the way it is meant to be built.
You do not configure anything for the common cases.

| The project has | g1t |
| --- | --- |
| `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` | Builds it as a **Workers project**: installs dependencies, runs `wrangler deploy --dry-run` to bundle it (which runs the config's own `build` command), and deploys the bundle with the config's static assets, `compatibility_date`, `compatibility_flags` and `vars`. |
| A framework from the table below | Installs dependencies, builds it with the framework's command, and serves the folder it writes as a **static site**, or deploys the Worker its Cloudflare adapter writes as a **Workers project**. |
| A `build` script in `package.json` | Installs dependencies, runs `npm run build`, and serves the output as a **static site**. |
| An `index.html` and nothing to build | Serves it as it is. |

**Settings → Deployments** shows what g1t detected at the project's last
finished build (**Workers project**, **Static site** or **Plain HTML**),
and what running it costs. Before the first build it says **Detected at
the first build**. The framework is named at the top of the build's log,
as `Detected Astro: framework=astro.`

Dependencies are installed by the lockfile that is there: `npm ci`,
`pnpm install --frozen-lockfile`, `yarn install` or `bun install`, and
`npm install` with no lockfile.

### Frameworks

g1t knows a framework by the packages in `package.json`
(`dependencies` and `devDependencies`) and by its config file. The build
command is the package's own `build` script when it has one, else the
command in the table. A **Build command** or **Output directory** of
your own, under **Settings → Deployments**, always wins over the table.

| Framework | Found by | Builds with | Serves |
| --- | --- | --- | --- |
| Vite, and React, Vue, Svelte, Solid or Preact on Vite | `vite` | `vite build` | `dist`, or `build.outDir` from `vite.config` |
| Astro | `astro` | `astro build` | `dist`, or `outDir` |
| Astro with `@astrojs/cloudflare` | `astro`, `@astrojs/cloudflare` | `astro build` | A Workers project: the Worker and config the adapter writes |
| Next.js with `output: 'export'` | `next`, and `output: 'export'` in `next.config` | `next build` | `out` |
| Next.js with OpenNext | `next`, `@opennextjs/cloudflare` and a `wrangler.jsonc` | `opennextjs-cloudflare build`, then `wrangler deploy --dry-run` | A Workers project |
| SvelteKit with `@sveltejs/adapter-static` | `@sveltejs/kit` and the adapter | `vite build` | `build`, or the adapter's `pages` |
| SvelteKit with `@sveltejs/adapter-cloudflare` | `@sveltejs/kit` and the adapter | `vite build` | A Workers project: `.svelte-kit/cloudflare/_worker.js` and the files beside it |
| Nuxt | `nuxt` | `npm run generate` if there is one, else `nuxi generate` | `.output/public` |
| React Router in SPA mode | `@react-router/dev`, and `ssr: false` in `react-router.config` | `react-router build` | `build/client` |
| Remix in SPA mode | `@remix-run/dev`, and `ssr: false` in `vite.config` | `remix vite:build` | `build/client` |
| Gatsby | `gatsby` | `gatsby build` | `public` |
| Docusaurus | `@docusaurus/core` | `docusaurus build` | `build` |
| Eleventy | `@11ty/eleventy` | `eleventy` | `_site`, or `dir.output` |
| Angular | `@angular/core` and `angular.json` | `ng build` | `dist/<project>/browser`, from `angular.json` |
| Create React App | `react-scripts` | `react-scripts build` | `build` |
| Hugo | `hugo.toml`, `hugo.yaml` or `hugo.json`; or a Hugo `config.toml` and no `package.json` | `hugo --minify` | `public`, or `publishDir` |
| Jekyll | `_config.yml` and a `Gemfile` | `bundle install`, then `bundle exec jekyll build` | `_site`, or `destination` |
| mdBook | `book.toml` | `mdbook build` | `book`, or `build.build-dir` |

- **Frameworks that need a server fail early, saying what to change.**
  g1t.page runs static sites and Workers, not servers that stay up. A
  Next.js app without `output: 'export'`, an Astro site with
  `output: 'server'` and no Cloudflare adapter, a SvelteKit app with
  `adapter-auto` or `adapter-node`, and a React Router or Remix app that
  renders on the server each fail before anything is installed, with the
  change that makes them deploy: a static export, or the framework's
  Cloudflare adapter. An **Output directory** of your own skips the check.
- **A framework's Worker.** Astro's and SvelteKit's Cloudflare adapters,
  OpenNext, and `@cloudflare/vite-plugin` with a Wrangler config build a
  Worker. g1t runs the build, then bundles what it wrote with
  `wrangler deploy --dry-run`, reading the config the build wrote
  (`.wrangler/deploy/config.json`) when there is one. A `_worker.js`,
  `_routes.json` or `.assetsignore` at the top of the static files, and
  the names `.assetsignore` lists, are never served.
- **Hugo and mdBook** use the `hugo` or `mdbook` on the machine's `PATH`.
  Without one, the build fetches Hugo 0.166.0 (the extended edition, with
  npm) or builds mdBook 0.5.4 with cargo, which takes a minute or two.
  Jekyll's gems are installed into `vendor/bundle` in the project.

A project that is none of these is served from the first of these that
exists after the build: `dist`, `build`, `out`, `public`, `_site`,
`.output/public`. Set **Output directory** to choose another.

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
  (`triggers.crons`) are not scheduled, so a `scheduled` handler never
  runs; the deployment says so in its warnings.
- Each request your Worker answers may use up to 50 ms of CPU time
  (waiting on the network does not count) and make up to 50 requests of
  its own (`fetch` calls and the like). A request that goes over either
  is stopped and answered with a 503 page that says so. Static assets are
  served without running your Worker, and count toward neither.
- `vars` are deployed as plain-text bindings (or JSON, for objects). Rows
  of the project's [secrets and variables](/guides/secrets-and-variables/)
  available to Deployments are bound too, and replace a `var` of the same
  name: secrets as secret bindings.
- **Not provisioned yet:** D1, KV, R2, Durable Objects, Queues, service
  bindings, Vectorize, Hyperdrive, Workers AI and Workflows. A project that
  declares any of them still deploys, without them, and its deployment
  lists each one it left out. Code that needs them should check that the
  binding is there.

What Deployments cannot run yet, such as long-running servers, is on
[What g1t can't do yet](/about/limitations/#deployments).

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

The **Deployments** page lists the same failure of one app, repeated, as a
single row with how many times it happened and when it last did. The row
opens the newest of them.

## Production

Each push to the default branch, which is each merge on a protected
branch, builds and replaces production. The **Deployments** page shows the
live address, the commit it runs and when it went up.

### The production screenshot

When production goes live, g1t takes a screenshot of its home page, as a
1280 by 800 browser window sees it, and shows it on the project's
[overview](/guides/projects/#the-overview). Choosing it opens the site.

- One screenshot is taken per production deploy. g1t waits up to 12
  seconds for the page to settle, then takes it as it is.
- The screenshot is of the app's `g1t.page` address. A custom domain
  serves the same app, so it looks the same.
- Until it is ready, or if it could not be taken, the overview shows the
  project's uploaded image, if it has one, or else a plain frame with the
  address. A failed screenshot is tried again when the overview is next
  opened, at most every five minutes.
- Only people with a role on the project's repository see it, like the
  rest of its deployments; anyone else who can see the project sees its
  uploaded image or the frame.
- With **Use the uploaded image instead of a screenshot** on, the
  uploaded image shows instead.
- Screenshots are not charged.

An app deployed elsewhere gets a screenshot of its production address
too, and any project can show an uploaded image instead. See
[production's picture](/guides/projects/#productions-picture).

The [checklist on the overview](/guides/projects/#get-to-production) also
tracks the first production deploy, a custom domain and a first preview.

## Deploying from a workflow

A [workflow](/guides/actions/) job can build and deploy the project
itself, with g1t's own action, `g1t/deploy`. Use it when the build needs
steps of yours first (generated code, a test that must pass, a tool the
default build lacks), or to deploy from a branch without a pull request.
The app, its address, its checks and its custom domains are the same as
for the builds g1t starts by itself.

```yaml
# .g1t/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm test
      - id: deploy
        uses: g1t/deploy@v1
        with:
          build-command: npm run build
      - run: echo "Live at ${{ steps.deploy.outputs.url }}"
```

1. Turn Deployments on for the project, as in
   [Turn on deployments](#turn-on-deployments).
2. Add a workflow like the one above. The job needs `deployments: write`
   (or `pages: write`) in its `permissions:`.
3. Push. The run on `main` deploys production; a pull request's run
   deploys its preview.

What the run builds:

| The run | Builds |
| --- | --- |
| On the project's production branch (a push, `workflow_dispatch` or `schedule` there) | Production |
| For a pull request (`pull_request`, `pull_request_target`) | That pull request's preview, at its branch's address, or `pr-<number>` for one from a fork |
| On another branch | That branch's preview |
| For a tag | Nothing: the step fails and says to run the workflow on a branch |

`g1t/deploy` takes these inputs:

| Input | Default | |
| --- | --- | --- |
| `project` | The repository's one project with Deployments on | The project's slug. Needed when the repository has several. |
| `root-dir` | The project's **Root directory** | Where the project is in the checkout. |
| `build-command` | The project's **Build command**, else what the build finds | What builds it, run after the install. |
| `output-dir` | The project's **Output directory**, else the first folder found | The folder a static build writes. |
| `sha` | The run's commit | The commit the `g1t / deploy` check goes on. |
| `token` | `${{ github.token }}` | The job's own token. No other token can open a build. |

Its outputs are `url` (the app's address), `deployment-id` (`dpl_…`) and
`kind` (`production` or `preview`).

The action calls
[`POST /repos/{owner}/{repo}/deployments/builds`](/reference/api/deployments/start-deployment-build/),
which checks the plan and the spend limit as any build does, sets the
commit's `g1t / deploy` check to pending, and answers with a token for
that build alone and the project's
[variables and secrets](#secrets-and-variables) for production or
previews. The action masks the token and every secret in the log, then
runs `g1t-runner deploy` in the checkout, which installs, builds and
uploads exactly as [What deploys](#what-deploys) says; its output is in
the step's log and on the deployment's page. When the build fails, or
g1t does not take what it built, the step fails and the deployment says
why. When the job ends before the build has finished, because it was
cancelled, failed in an earlier step or timed out, the deployment fails
as the job ends, saying how it ended, rather than staying **Building**.

- **Secrets.** A pull request from a fork or from someone without the
  Write role, and a run that had to be
  [approved](/guides/actions/#pull-requests), build without
  the project's secrets, as previews of them always have. Their token is
  read-only, so they cannot open a build at all unless the workflow runs
  on `pull_request_target`.
- **Cost.** The build runs in the job, so its time is the job's
  [Actions time](/guides/usage-and-billing/), free on a
  [self-hosted runner](/guides/self-hosted-runners/), and is not charged
  again as build seconds. Requests, CPU time and custom domains are
  charged as for any app.
- **g1t's own builds still run.** A push to the production branch and a
  pull request's push still start g1t's build too. Whichever starts
  later replaces the other, so the app ends up at the newest commit
  either way.
- **On your own machines**, the action uses the `g1t-runner` on `PATH`, or
  downloads the newest release and checks it against its `SHA256SUMS`. It
  runs on Linux and macOS, with `curl` and `jq` or `python3`.

`g1t/detect` says what a build of the checkout would find, without
building anything: its outputs are `kind` (`workers`, `static`, `html` or
`none`), `install`, `build`, `output-dir` and `framework` (such as
`astro` or `nextjs`, empty when there is none). A framework set up to
need a server is `none`, and the step's log says what to change. Use
them to cache, or to fail early:

```yaml
- id: detect
  uses: g1t/detect@v1
- if: steps.detect.outputs.kind == 'none'
  run: |
    echo "::error::Nothing here would be served: add an index.html or a build script."
    exit 1
```

### Build with a workflow

Turn on **Build with a workflow** under **Settings → Deployments** and the
project's builds run as a workflow g1t manages for it, instead of as
builds Deployments starts by itself. Nothing else changes: the same
previews and production, at the same addresses, with the same
**g1t / deploy** check, which is now the check of the workflow's job.

- The workflow is listed on the repository's **Actions** page, named
  `g1t`, with its runs, logs and re-runs like any other. It is not a file
  in the repository: it is made from the project's settings, and follows
  them when they change.
- It calls g1t's reusable deploy workflow,
  `g1t/workflows/.g1t/workflows/deploy.yml@v1`, which checks out the
  commit and runs [`g1t/deploy`](#deploying-from-a-workflow). As g1t
  improves how projects are built, that workflow improves for every
  project that uses it.
- A pull request from a fork runs it with a read-only token, as on
  GitHub, and still gets its preview, without the project's build
  secrets.
- To change it, commit a workflow named `g1t` to `.g1t/workflows/`: that
  file runs in its place. Start from the one the **Actions** page shows,
  or call the reusable workflow yourself:

```yaml
# .g1t/workflows/g1t.yml
name: g1t

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  deployments: write

jobs:
  g1t:
    name: g1t
    uses: g1t/workflows/.g1t/workflows/deploy.yml@v1
    with:
      project: web
    secrets: inherit
```

Its jobs are [workflow jobs](/guides/actions/#machine-sizes): on g1t's
machines they are charged as Actions time, at cost plus 20% like every
build, and on a [self-hosted runner](/guides/self-hosted-runners/) they
cost nothing.

## Custom domains

Production can be served at a domain of your own, such as `example.com` or
`www.example.com`, as well as at its address on g1t.page. A domain belongs
to the project, not to a build: every redeploy is served on it with nothing
to change.

### Add a domain

1. Open the project's **Settings → Domains**,
   `g1t.sh/<workspace>/<repo>/settings/domains`.
2. Enter the domain and choose **Add domain**. Leave **Also add the www
   (or apex) twin** checked to add both `example.com` and
   `www.example.com` at once: the one you typed serves the app, and the
   other redirects to it with a `308`, path and query kept.
3. Add the DNS records the page lists, at whoever manages the domain's
   DNS. Each name and value has a copy button.
4. Wait. The page follows the domain from **Waiting for DNS** to
   **Issuing certificate** to **Active** by itself; **Check now** asks
   again at once.

Custom domains need the workspace's g1t plan, and are $0.12 a month each
(their cost plus 20%), as many as you like. Adding or removing one needs
the Admin [role](/guides/access-and-roles/) on the project's repository.

### A subdomain, such as www

Add one record:

| Type | Name | Target |
| --- | --- | --- |
| `CNAME` | `www` | `domains.g1t.page` |

The same goes for any subdomain, such as `app.example.com` (name `app`).

### The apex, such as example.com

DNS does not allow a plain `CNAME` at the apex of a domain, so use your
provider's flattened form of one, pointed at `domains.g1t.page`:

| DNS provider | Record |
| --- | --- |
| Cloudflare DNS | `CNAME` at `@` (Cloudflare flattens it) |
| Amazon Route 53 | Not supported by alias records to other zones; use the www pairing below |
| DNSimple, NS1, Namecheap, Porkbun, Gandi | `ALIAS` at `@` |
| DNS Made Easy, Constellix | `ANAME` at `@` |

If your provider has no flattened `CNAME`, `ALIAS` or `ANAME`, add
`www.example.com` on g1t instead, and set up your provider's forwarding (or
any redirect) from `example.com` to `www.example.com`.

### Verification and certificates

Pointing the domain at `domains.g1t.page` is what proves it is yours: once
the record is seen, the certificate authority checks the domain over HTTP
and issues a certificate, renewed by itself before it expires. Visitors are
always served over HTTPS, TLS 1.2 or newer.

The page may also list a `TXT` record named `_cf-custom-hostname.<domain>`.
It proves ownership before traffic moves, which is useful when the domain
is serving a site elsewhere today: add the `TXT` first, wait for
**Issuing certificate** or **Active**, then change the `CNAME`. Any other
`TXT` records listed are for the certificate and are needed as shown.

DNS changes can take from a few minutes to an hour to be seen. A domain
that stays at **Waiting for DNS** usually has a record with a typo, a
leftover `A` or `AAAA` record beside the new one, or (on Cloudflare DNS) a
`CAA` record that does not allow the certificate's authority.

### Remove a domain

Choose **Remove** beside it. It stops serving the project at once, and any
domain redirecting to it goes too. Your DNS records are left as they are.

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
| The repository is [deleted](/guides/managing-repositories/) | Every app of its projects, at once. Custom domains stay set up and serve nothing. If you restore the repository, production is built again and its domains serve it; previews come back with their next push. When it is purged, its custom domains are removed. |

A preview that came down comes back with the next push to its pull
request, or **Redeploy** on the Deployments page.

## Who can do what

What you can do with a project's deployments follows your
[role](/guides/access-and-roles/) on its repository:

| | Needs |
| --- | --- |
| See its deployments, their build logs, previews and domains | Read |
| **Redeploy**, take an app down | Write |
| Turn deployments on or off, change their settings | Admin |
| Add, verify and remove custom domains | Admin |

A public repository's deployments, and their build logs, can be seen by
anyone, signed in or not, the same as its code. Its settings and domains
still need Admin. A private repository's deployments are seen only by
people with a role on it.

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
| Build with a workflow | Off | Build through the deploy workflow g1t manages for the project; see [build with a workflow](#build-with-a-workflow). |

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
rather than the build. Secrets reach a preview only when the pull
request's author has Write or higher on the repository, whether a member
or an [outside collaborator](/guides/access-and-roles/#outside-collaborators),
or it is g1t working on its own. For a pull request g1t made, whoever
asked for it is the one whose role counts. A preview of anyone else's pull request, such as
one from a fork or by someone with Read or Triage, is built and runs with
variables only, no secrets.

For example, a `STRIPE_KEY` secret with a Production row holding the live
key and a Preview row holding the test key gives every preview the test
key.

## What it costs

Deployments come with the
[g1t plan](/guides/usage-and-billing/#the-g1t-plan), $20 a month per
workspace with $10 of usage included. There are **no quotas**: as many
projects and previews as you like, and no count of builds, requests or
domains ever stops or pauses an app. What deployments cost g1t is metered
from the first unit, at Cloudflare's price plus 20%, and paid from the
plan's $10 of included usage first; past it, it is charged up to your
[spend limit](/guides/usage-and-billing/#limits).

| | Costs g1t | You pay |
| --- | --- | --- |
| Projects, previews and the apps behind them | Next to nothing | Not charged |
| Builds g1t runs, by the second, whether they succeed or fail (a [workflow's build](#deploying-from-a-workflow) is its job's Actions time instead) | About $0.001 a minute | About $0.0012 a minute |
| Requests, to all of the workspace's apps | $0.30 a million | $0.36 a million |
| CPU time your code spends computing (waiting on the network is not counted) | $0.02 a million ms | $0.024 a million ms |
| Custom domains, with their certificates (a www/apex pair is two) | $0.10 a month | $0.12 a month, by the most the workspace had at once that month |

Builds are charged when they finish. Requests, CPU time and custom domains
are counted through the month, so your limit and **Billing** follow them as
they happen, and charged once, on the first sweep after the month ends, as
one line: *Deployments in 2026-10: 1,240,000 requests, 3,100,000 CPU ms, 2
custom domains*.

A static site, or plain HTML, runs no code when it is visited: its files
are served as they are, so serving it adds no requests or CPU time. Its
builds are metered. A Workers project's code runs on every request, so its
requests and CPU time are metered too.

An app that no one visits costs nothing. Previews still come down when
their pull request closes and after their idle days, to keep the list of
what is up short.

The only things that stop a workspace's apps are its own spend limit
(apps pause with a notice, and come back once there is room) and the plan
ending (they come down).

Deployments used to be a $5 plan of their own. A Deployments subscription
bought before keeps working until its current period ends, and is not
renewed.

### Seeing what you use

- **Usage** shows **Deployments** with *Builds*
  (build minutes and their cost), *Requests & CPU* and *Custom domains*,
  in dollars, beside the rest of the workspace's usage. Requests and CPU
  time are counted from Cloudflare's analytics every 10 minutes.
- The **statement** on Billing lists every build (*Building acme/web to
  production (48 s), paid by your plan's included usage*) and every
  month's requests, CPU time and custom domains.
- Each build's page shows how long it ran.

## Turn it off

- **For a project:** **Turn off deployments** under its **Settings →
  Deployments**. Every app comes down at once. Turning it on again
  rebuilds production.
- **For the workspace:** when an owner ends the g1t plan on Billing,
  deployments keep working until the date shown; then every app comes
  down and nothing more is charged.

Usage from the month that is under way is still charged once it ends.

## How it works

1. A pull request opens, or someone pushes. The deployments service hears
   of it, checks that the workspace's plan is on, and reserves what the
   build may cost (30 minutes of sandbox time) with billing. If billing
   refuses (no paid plan, the spend limit reached, compute paused), the
   build does not start: the deployment's status is **Skipped** with the
   reason and what to do, and **Redeploy** shows the same reason.
2. It starts a build in a sandbox of its own, the same machines that run
   [GitHub Actions](/guides/actions/) and agents. The sandbox checks out
   the commit with a read-only token that expires in 30 minutes. Its
   network is restricted to the project's allowed domains, the package
   registries, GitHub and Cloudflare's API, as
   [workflow jobs'](/guides/actions/#what-a-job-can-reach) are, and it
   stops at 30 minutes.
   When it stops, what it cost is settled against what was reserved.
3. The sandbox builds, then lists its files. g1t opens an upload with
   Cloudflare for exactly those files and hands the sandbox a key that can
   upload them and nothing else. Files Cloudflare already has are skipped.
4. The sandbox sends the Worker's code to g1t, which puts the app in
   g1t's [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
   namespace, under the name in its address.
5. A request to `*.g1t.page` reaches g1t's dispatcher, which runs the app
   by the name in the hostname. Nothing else is looked up. A request to a
   custom domain reaches the same dispatcher through Cloudflare for SaaS;
   it looks the hostname up once, in a key-value store kept at the edge.

Your code never holds a Cloudflare credential, and apps are served from
`g1t.page`, not `g1t.sh`, so they share no cookies or origin with the site
you sign in to.

## Troubleshooting

| You see | Do |
| --- | --- |
| "Deployments come with the g1t plan … and `<workspace>` does not have it" | An owner starts the g1t plan under Billing. |
| A deployment **Skipped**, saying it reached its spend limit or that new compute is paused | The build was refused before it started. Follow the link in the message: raise the spend limit, prepay, or answer the spike, on Billing. |
| "Stopped: unusual CPU use" | The build looked like it was mining. Contact support if it was a real build; see [abuse and mining](/guides/guardrails/#abuse-and-mining). |
| "403" from a host in the build log | The build's network is restricted. Add the host to the project's allowed domains under **Settings → Guardrails**. |
| "found nothing to serve" | Add a `build` script, an `index.html`, or a Workers config; or set **Output directory**. |
| "the output directory `x` does not exist after the build" | The build wrote elsewhere: check its log, then fix **Output directory**. |
| "`d1_databases` is not provisioned on g1t.page yet" | The app deployed without that binding. See [Workers projects](#workers-projects). |
| "`triggers.crons` (1 schedule) is not set up on g1t.page yet" | The app deployed, but its `scheduled` handler never runs. See [Workers projects](#workers-projects). |
| A preview page says "This preview is not up" | It came down (see [When apps come down](#when-apps-come-down)). Push, or choose **Redeploy**. |
| "Custom domains are being switched on" | Custom domains are not on for g1t.page yet. Domains you add are kept, and set up by themselves once they are. |
| A domain stays at **Waiting for DNS** | Check the record against the one listed, remove other `A`/`AAAA` records for the same name, then choose **Check now**. |
| A domain says "This domain is not set up" | It points at g1t, but no project has added it. Add it under **Settings → Domains**. |
| "This pull request's commit no longer exists" | The pull request's head was force-pushed over, or its branch deleted, after the build was asked for. Push to the pull request again, or close it. g1t does not try that commit again. |
| g1t/deploy says "The job's token needs `deployments: write`" | Add `deployments: write` to the workflow's or the job's `permissions:`. A pull request's run from outside gets a read-only token and cannot deploy. |
| g1t/deploy says "Name the project to build" | The repository has several projects with Deployments on: give `project:`. |
| g1t/deploy says "g1t.page deploys branches and pull requests" | The run is for a tag. Run the workflow on a branch, such as on a push to `main`. |
| "The workflow job was cancelled before the build finished" | The job that opened the build (`g1t/deploy`) was cancelled, or ended another way the message names, before `g1t-runner deploy` reported. Run the job again. |
| "The build did not finish in 45 minutes" | The build stopped reporting: a build stops at 30 minutes, and one not heard from after 45 is failed. Make the build faster, or build less for previews with **Build command**. |

## Running your own g1t

Deployments need a Workers for Platforms namespace and a zone for apps:

1. Create the namespace: `npx wrangler dispatch-namespace create g1t-deployments`.
2. Add a proxied wildcard DNS record (`*`, `AAAA`, `100::`) on the apps'
   zone, and set the zone in `services/pages/wrangler.jsonc`.
3. Create an API token with **Workers Scripts: Edit** and **Account
   Analytics: Read**, and store it:
   `npx wrangler secret put CLOUDFLARE_API_TOKEN` in `services/deployments`.
4. Deploy `services/deployments`, `services/pages`, and the runner.

Custom domains also need Cloudflare for SaaS on the apps' zone. Turn it on
under the zone's **SSL/TLS → Custom Hostnames**, give the token **SSL and
Certificates: Edit** on the zone, and run `scripts/setup-custom-domains.sh`:
it creates the `g1t-domains` KV namespace, the fallback origin's DNS record
(`domains`, `AAAA`, `100::`, proxied) and sets it as the fallback origin.
The dispatcher's `*/*` route on the zone, in `services/pages/wrangler.jsonc`,
is what brings custom domains' traffic to it.

Without a card processor configured, every feature is on and nothing is
charged.
