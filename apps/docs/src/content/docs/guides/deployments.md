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

When a workspace is [renamed](/guides/workspaces/#rename-a-workspace), its
apps move to addresses with the new name, and the old addresses redirect to
them for 90 days.

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

Custom domains need the workspace's Deployments plan. Only members of the
workspace can add or remove them.

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
| 3 custom domains | Across the workspace's projects, with their certificates. A www/apex pair is two. |
| 200 build minutes | Every build's time, whether it succeeds or fails. About $0.25 of the plan's price at cost. |

**Usage past that** is charged at Cloudflare's price plus 20%:

| | Price |
| --- | --- |
| A build past the 200 minutes | $0.0015 a minute, by the second, whether it succeeds or fails. |
| Each app past 10 | $0.024 a month |
| Each million requests past 1 million | $0.36 |
| Each million CPU milliseconds past 3 million | $0.024 |
| Each custom domain past 3 | $0.12 a month, by the most the workspace had at once that month |

Builds are recorded when they finish: the plan's minutes pay for them
first, and a build that runs past them is charged only for the seconds
past them. Other usage past the allowance is charged once, on the first
sweep after the month ends, as one line: *Deployments in 2026-10 past the
plan*.

An app that no one visits costs nothing beyond counting toward the 10. That
is why previews come down when their pull request closes and after their
idle days.

### Seeing what you use

- **Billing**, under the Deployments plan, shows this month's apps, build
  minutes, requests and CPU time against what the plan includes.
  Requests and CPU time are counted from Cloudflare's analytics
  every 10 minutes.
- The **statement** on Billing lists every build (*Building acme/web to
  production (48 s), all of it included in the plan*) and every month's
  usage past the plan.
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
   by the name in the hostname. Nothing else is looked up. A request to a
   custom domain reaches the same dispatcher through Cloudflare for SaaS;
   it looks the hostname up once, in a key-value store kept at the edge.

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
| "Custom domains are being switched on" | Custom domains are not on for g1t.page yet. Domains you add are kept, and set up by themselves once they are. |
| A domain stays at **Waiting for DNS** | Check the record against the one listed, remove other `A`/`AAAA` records for the same name, then choose **Check now**. |
| A domain says "This domain is not set up" | It points at g1t, but no project has added it. Add it under **Settings → Domains**. |
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

Custom domains also need Cloudflare for SaaS on the apps' zone. Turn it on
under the zone's **SSL/TLS → Custom Hostnames**, give the token **SSL and
Certificates: Edit** on the zone, and run `scripts/setup-custom-domains.sh`:
it creates the `g1t-domains` KV namespace, the fallback origin's DNS record
(`domains`, `AAAA`, `100::`, proxied) and sets it as the fallback origin.
The dispatcher's `*/*` route on the zone, in `services/pages/wrangler.jsonc`,
is what brings custom domains' traffic to it.

Without a card processor configured, every feature is on and nothing is
charged.
