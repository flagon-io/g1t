---
title: Deployments
description: A project's production on every push and a live preview of every branch with a pull request, on g1t.page. Scales to zero, and billed to the workspace.
---

Deployments put your [project](/guides/projects/) on the web. They are off
for every project until you turn them on. Once they are on, every branch
with a pull request gets its own live preview, linked on the pull request,
and the default branch goes to production on every push. Reviewers
click through the change instead of reading a diff.

Apps run on Cloudflare Workers, on `g1t.page`: sites, Workers projects,
and Node.js servers such as Express apps. A server that cannot run as a
Worker runs as a container on Cloudflare Containers behind one; see
[What a project is built as](#what-a-project-is-built-as) and
[Docker deployments](#docker-deployments):

| | Address |
| --- | --- |
| Production | `https://<project>-<workspace>.g1t.page` |
| Preview of the branch `fix-login` | `https://<project>-git-fix-login-<workspace>.g1t.page` |

A preview's address follows its branch, so it stays the same for every push
to it. A pull request from a fork, as coding agents make them, is named
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
nothing and costs nothing, and the next visit wakes it in milliseconds. A
container wakes in seconds, and sleeps again after five minutes without a
request.

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

On a g1t whose payments use Stripe's test mode, such as a self-hosted one
set up with test keys, no real card is charged: use the test card
`4242 4242 4242 4242` with any future date and any code. With live
payments, the card you enter is charged.

## What deploys

g1t looks at the project's root directory and builds it the way it is meant to be built.
You do not configure anything for the common cases.

| The project has | g1t |
| --- | --- |
| `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` | Builds it as a **Workers project**: installs dependencies, runs `wrangler deploy --dry-run` to bundle it (which runs the config's own `build` command), and deploys the bundle with the config's static assets, `compatibility_date`, `compatibility_flags` and `vars`. |
| A framework from the table below, even beside a `Dockerfile` | Installs dependencies, builds it with the framework's command, and serves the folder it writes as a **static site**, or deploys the Worker its Cloudflare adapter writes as a **Workers project**. |
| A framework set up to need a server (Next.js without a static export, Astro's `@astrojs/node`, SvelteKit's `adapter-node`, a server-rendered React Router or Remix app) | Builds it as a **container**: from its `Dockerfile`, or one g1t writes for it. |
| A Node.js server (Express, Koa, Hono, `node:http` and others) with no `Dockerfile` | Runs it as a **Workers project**: wraps its server in a Worker, bundles it, and checks that it starts. One that cannot run as a Worker runs as a **container** instead, and the build's log says why. See [Node.js servers as Workers](#nodejs-servers-as-workers). |
| A Python, Go, Ruby, PHP or Rust server, or a Node.js server with a `Dockerfile` | Builds it as a **container**: from its `Dockerfile`, or one g1t writes for it and shows in the build's log. See [Docker deployments](#docker-deployments). |
| A `build` script in `package.json`, even beside a `Dockerfile` | Installs dependencies, runs `npm run build`, and serves the output as a **static site**. |
| An `index.html` and nothing to build, even beside a `Dockerfile` | Serves it as it is. |
| A `Dockerfile` and nothing else to serve | Builds the image and runs it as a **container**. |
| Nothing g1t recognises | Fails, saying to add a `Dockerfile`, a `build` script or an `index.html`. |

### What a project is built as

A site or a Worker is always preferred: it runs nothing while no one
visits, so it costs nothing then, and it wakes in milliseconds. A
container is the fallback. With **Build as** on **Auto** (the default),
the first of these that fits is what the project is built as:

1. **A Workers project**: a Wrangler config (`wrangler.jsonc`,
   `wrangler.json` or `wrangler.toml`), or a framework's Cloudflare
   adapter, even beside a `Dockerfile`.
2. **A framework's site**: a framework from the [table below](#frameworks)
   that builds a site, even beside a `Dockerfile`. A framework set up to
   need a server is a container, from its `Dockerfile` or one g1t writes.
3. **A Node.js server as a Worker**: a Node.js server with no
   `Dockerfile` ([Node.js servers as Workers](#nodejs-servers-as-workers)).
   One that cannot run as a Worker is a container, from a Dockerfile g1t
   writes.
4. **A container for any other server g1t recognises**: Python, Go, Ruby,
   PHP or Rust, or a Node.js server with a `Dockerfile` of its own; from
   that `Dockerfile`, or one g1t writes.
5. **A site**: a `build` script's output, or an `index.html`, even beside
   a `Dockerfile`.
6. **A container from its `Dockerfile`** (or `Containerfile`, or the path
   set as its **Dockerfile**), when there is nothing else to serve.
7. Otherwise the build fails, saying what to add.

When a site is built beside a `Dockerfile`, the build's log says the
`Dockerfile` is not used, near its top: "Built as a Vite site; Dockerfile
is not used (a container is only the fallback; choose **Build as**:
Container to use it)." To run the project's `Dockerfile` instead, set
**Build as** to **Container** under **Settings → Deployments**. **Build
as** set to **Static site**, **Workers** or **Container** is what the
project is built as, whatever else it has.

**Settings → Deployments** shows what g1t detected at the project's last
finished build and what it was built with, such as **Static site ·
Astro**, **Workers project**, **Container · Dockerfile** or **Container ·
Flask, with a Dockerfile g1t wrote**, and what running it costs. Before
the first build it says **Detected at the first build**. The framework is
named at the top of the build's log, as `Detected Astro: framework=astro.`
**Build as**, under the same settings, overrides what is detected.

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

- **Frameworks that need a server run as containers.** A Next.js app
  without `output: 'export'`, an Astro site with `@astrojs/node`, a
  SvelteKit app with `adapter-node`, and a React Router or Remix app that
  renders on the server are built from their `Dockerfile`, or one g1t
  writes ([Docker deployments](#docker-deployments)). A static export or
  the framework's Cloudflare adapter costs less, since it runs nothing
  while no one visits; the build's log says so. One g1t cannot run as a
  server, such as SvelteKit with `adapter-auto`, fails before anything is
  installed, saying what to change or to add a `Dockerfile`. An **Output
  directory** of your own, or **Build as** Static site, builds it as a
  static site instead.
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

### Node.js servers as Workers

A Node.js server with no `Dockerfile` runs as a Worker, not a container:
an Express, Koa, Hono, Polka, Restify or hapi app, or one on `node:http`
alone. Workers run Node.js HTTP servers with the `nodejs_compat`
compatibility flag, through
[`httpServerHandler`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)
from `cloudflare:node`, so the app's code runs as written. g1t knows a
Node.js server by a server package in `package.json`, or by a `start`
script with no `build` script or `index.html` beside it.

1. **It finds the file that starts the app**: the file its `start` script
   runs with `node`, `tsx` or `ts-node` (`node server.js`,
   `NODE_ENV=production node dist/index.js`), else `main` in
   `package.json`, else `server.js`, `index.js`, `app.js` or the like.
2. **It installs and builds** as for any project: the lockfile's install,
   then `npm run build` when there is a `build` script (a TypeScript app
   compiled to `dist`, say).
3. **It writes a Worker entry** that imports that file, keeps the server
   it starts, and answers each request with `httpServerHandler`. An app
   whose default export has a `fetch` method (a Hono app) is answered by
   that `fetch` directly. `listen` may name any port and address: on
   Workers the port only names the server. `PORT` is `8080` unless the
   project's variables set it. The entry is printed whole in the build's
   log.
4. **It bundles the Worker** with `wrangler deploy --dry-run`, with the
   compatibility date `2026-09-26` and `nodejs_compat`.
5. **It starts the Worker once** with `wrangler dev`, with the project's
   [variables and secrets](#secrets-and-variables), and asks it for `/`. A
   Worker that fails as it starts (a top-level `await` that never settles,
   a module that cannot load, a server that never calls `listen`) is not
   deployed.

A folder the app serves with `app.use(express.static("public"))`, with
no path before it, is uploaded as the Worker's static files: they are
served without running the app, and count toward none of its requests or
CPU time.

What is known not to run as a Worker is found before anything is built,
and the app runs as a container instead, from a Dockerfile g1t writes,
with the reason in the build's log:

| The app | Why |
| --- | --- |
| Depends on a native addon: `better-sqlite3`, `sqlite3`, `bcrypt`, `sharp`, `canvas`, `argon2`, `puppeteer`, `playwright`, `node-pty`, `ssh2` and others | A Worker cannot load native code. |
| Is a Fastify, NestJS or Sails app | They start on timers or read their modules from disk as they start, which a Worker cannot do before its first request. |
| Accepts WebSocket connections with `socket.io`, `express-ws`, `WebSocketServer` or an `upgrade` handler | Workers do not support Node's `upgrade` event. |
| Uses `child_process`, `cluster` or `worker_threads` | A Worker cannot start processes or threads. |
| Reads or writes files while it runs: `readFile`, `writeFile`, `createReadStream`, `sendFile`, `res.render` and a view engine, `multer`'s disk storage | A Worker has no disk with the project's files. |
| Serves files from disk under a path (`app.use("/static", express.static("public"))`), from a folder that does not exist, or from more than one folder | g1t can serve one folder, at the top, for it. |
| Has a `start` script g1t cannot read (`nest start`, `pm2-runtime …`) | g1t cannot tell which file starts it. |

g1t looks for these in the app's own JavaScript and TypeScript, not in
`node_modules`, tests, `scripts`, `public` or a build's output. A Worker
that does not bundle, or does not start, also runs as a container, saying
"Could not run as a Worker: …; deploying as a container." With a
`Dockerfile` of its own, a Node.js server is built from that `Dockerfile`
as a container. To run one as a Worker whatever g1t finds, set **Build
as** to **Workers**; to run it as a container, **Container**.

### Docker deployments

Any app that runs in a container deploys as one, whatever its framework or
age: give it a `Dockerfile`, or let g1t write one. It runs on
[Cloudflare Containers](https://developers.cloudflare.com/containers/)
behind the app's Worker, at the same addresses, custom domains and
previews as any other app.

A container is the fallback, for what cannot be served as a site or run
as a Worker ([What a project is built as](#what-a-project-is-built-as)):
a Python, Go, Ruby, PHP or Rust server, a Node.js server with a
`Dockerfile` of its own or one that cannot run as a Worker, a framework
set up to need a server, or a `Dockerfile` with nothing else to serve.
There is nothing to set for those. A site or a Node.js server is built
without its `Dockerfile`; to deploy its container instead, set **Build
as** to **Container** under **Settings → Deployments**.

The build's log says which it chose and why, near its top: for example,
"Built as a static site; Dockerfile is not used (a container is only the
fallback; choose **Build as**: Container to use it)", or "Could not run as
a Worker: it depends on `better-sqlite3`, which builds native code a
Worker cannot load; deploying as a container."

g1t writes a Dockerfile for these, when there is none:

| The project has | Runs with |
| --- | --- |
| `package.json` with a `start` script, or a server package (`express`, `fastify`, `koa`, `@nestjs/core`, `@hono/node-server` and others) and a main file | `npm start`, or `node <main>`, on `node:22-slim` (or the major release in `.nvmrc` or `.node-version`), after `npm run build` when there is one |
| Next.js, Astro with `@astrojs/node`, SvelteKit with `adapter-node`, React Router or Remix | `next start` (or `node .next/standalone/server.js`, with its static files beside it, for `output: 'standalone'`), `node ./dist/server/entry.mjs`, `node build`, `react-router-serve` or `remix-serve`, after the build |
| `requirements.txt`, `pyproject.toml` or `Pipfile`, and `manage.py` (Django) | `gunicorn <project>.wsgi` on `python:3.12-slim` |
| The same, with Flask and an `app.py`, `main.py`, `server.py`, `wsgi.py` or `asgi.py` | `gunicorn <module>:app` |
| The same, with FastAPI or Starlette | `uvicorn <module>:app` |
| The same, with neither | `python <module>.py` |
| `go.mod` and one `package main`, at the top or in one folder of `cmd/` | The program, built with `golang:1.25` into an image with nothing else |
| A `Gemfile` with Rails | `rails server`, after `assets:precompile`, on `ruby:3.3-slim` |
| A `Gemfile` and a `config.ru` | `rackup` |
| `composer.json`, and `artisan` with `public/index.php` (Laravel), or an `index.php` | Apache with PHP 8.3, after `composer install` |
| `Cargo.toml` with one program and `axum`, `actix-web`, `rocket`, `warp`, `poem`, `salvo` or `tide` | The program, built with `rust:1` into `debian:bookworm-slim` |

The Dockerfile g1t writes is printed whole in the build's log. To change
how the app is built or run, commit it as `Dockerfile` and edit it. It
leaves `.git`, `node_modules`, `.venv` and `__pycache__` out of the image.

What a container gets, and what it must do:

- **Listen on `0.0.0.0` at `PORT`.** `PORT` is the port its Dockerfile's
  first `EXPOSE` names (in its last stage), else the `PORT` it sets with
  `ENV`, else `8080`. A Dockerfile g1t writes sets `HOST` and `HOSTNAME`
  to `0.0.0.0` too. The first request
  waits up to 90 seconds for it to answer there; one that never does gets
  a 503 page saying so.
- **The project's [secrets and variables](#secrets-and-variables)** are
  its environment variables, set by g1t when it starts, never baked into
  the image. The image's build gets none of them: a step that needs one
  belongs in the app's start.
- **One instance, which sleeps.** It starts on the first request, and
  stops after five minutes without one; asleep, it costs nothing, and the
  next request starts it again in a few seconds. Its disk starts from the
  image each time: keep data in a database or a bucket.
- **Its size** is **Container size** under **Settings → Deployments**:
  `lite` (the default) to `standard-4`, as [What it costs](#what-it-costs)
  lists. The image may be as large as the size's disk, 2 GB for `lite`;
  a larger image fails the build, saying how large it was. An app keeps
  the image it runs and the one before it; older ones are deleted once a
  deploy is live, and all of them when the app is taken down.
- **Built for `linux/amd64`**, with Docker, in the build's sandbox (or the
  workflow job's Docker, for [`g1t-runner deploy`](#deploying-from-a-workflow)),
  with network access as any build has. **Build command** is not used:
  the Dockerfile builds it.

What Deployments cannot run yet is on
[What g1t can't do yet](/about/limitations/#deployments).

## Previews of branches

A preview is built when a pull request is opened, when it is marked ready,
and on every push to it. Pull requests from forks are built from the
fork.

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
building anything: its outputs are `kind` (`workers`, `static`, `html`, `container` or
`none`), `install`, `build`, `output-dir`, `framework` (such as
`astro`, `nextjs` or `node`, empty when there is none), `dockerfile` and
`port` for a container, and `entry` for a Node.js server run as a Worker. A framework set up to
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
| Build as | Auto | **Auto** (found from its files, a site or a Worker before a container), **Static site**, **Workers** or **Container**; see [What a project is built as](#what-a-project-is-built-as). |
| Dockerfile | `Dockerfile` or `Containerfile` | For a container: its Dockerfile's path, inside the project. |
| Container size | `lite` | For a container: the instance it runs at, with its price an hour awake. |
| Build command | The project's own | Runs instead of `npm run build`, or before bundling a Workers project. Not used for a container. |
| Output directory | Found by itself | What a static site serves. |
| Idle days | 7 | 1 to 90. A preview no one visits this long comes down. |
| Build with a workflow | Off | Build through the deploy workflow g1t manages for the project; see [build with a workflow](#build-with-a-workflow). |

## Logs, traces and errors

Every request an app answers shows under the project's
[Observability](/guides/observability/) within seconds: its status,
duration, CPU time and the lines it wrote, with its exceptions grouped into
errors and its numbers by deployment. Nothing to set up. Each request
reaches the app with an `x-g1t-request-id` header, its id there, and a
`traceparent`, and the app is deployed with OpenTelemetry's
`OTEL_EXPORTER_OTLP_*` variables set, so an OpenTelemetry SDK in it sends
its spans to the project without configuration.

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
rather than the build; a container gets them as its environment variables
when it starts, and its image's build gets none. Secrets reach a preview only when the pull
request's author has Write or higher on the repository, whether a member
or an [outside collaborator](/guides/access-and-roles/#outside-collaborators),
or it is g1t working on its own. A preview of anyone else's pull request, such as
one from a fork or by someone with Read or Triage, is built and runs with
variables only, no secrets.

For example, a `STRIPE_KEY` secret with a Production row holding the live
key and a Preview row holding the test key gives every preview the test
key.

## What it costs

Deployments come with the
[g1t plan](/guides/usage-and-billing/#the-g1t-plan), $21 a month per
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
| A container, while it is awake, by the minute (see the sizes below) | From $0.0129 an hour (`lite`) | From $0.0155 an hour |
| Data a container sends | $0.05 a GB, at most | $0.06 a GB |

A container's price is its size's memory, disk and vCPU while it is awake,
with the Durable Object in front of it, at Cloudflare's
[Containers prices](https://developers.cloudflare.com/containers/platform/pricing/)
plus 20%. Cloudflare bills CPU only as it is used; g1t charges every vCPU
as busy while the container is awake, so a container that mostly waits
costs g1t less than it is charged. Data sent is charged at the most a GB
costs anywhere ($0.05; $0.025 in North America and Europe), since g1t
cannot tell where it went. Each minute it is awake is charged from its
start, so a container woken by one request, and stopped five minutes after
it, is charged five minutes.

| Size | vCPU | Memory | Disk, and the largest image | An hour awake | Awake all month (730 hours) |
| --- | --- | --- | --- | --- | --- |
| `lite` | 1/16 | 256 MiB | 2 GB | $0.0155 | $11.28 |
| `basic` | 1/4 | 1 GiB | 4 GB | $0.0404 | $29.46 |
| `standard-1` | 1/2 | 4 GiB | 8 GB | $0.0956 | $69.77 |
| `standard-2` | 1 | 6 GiB | 12 GB | $0.1616 | $117.95 |
| `standard-3` | 2 | 8 GiB | 16 GB | $0.2708 | $197.68 |
| `standard-4` | 4 | 12 GiB | 20 GB | $0.4880 | $356.24 |

**Settings → Deployments** shows these with the price book's prices of the
day. A container that is visited all day never sleeps, and costs the last
column; one visited for an hour a day costs about a thirtieth of it.

Builds are charged when they finish. Requests, CPU time, custom domains
and container time are counted through the month, so your limit and
**Billing** follow them as they happen, and charged once, on the first
sweep after the month ends, as one line: *Deployments in 2026-10:
1,240,000 requests, 3,100,000 CPU ms, 2 custom domains, 41.5 container
hours and 2.3 GB sent*.

A static site, or plain HTML, runs no code when it is visited: its files
are served as they are, so serving it adds no requests or CPU time. Its
builds are metered. A Workers project's code runs on every request, so its
requests and CPU time are metered too. A container's Worker is metered the
same way, and its container by the minute while it is awake.

An app that no one visits costs nothing. Previews still come down when
their pull request closes and after their idle days, to keep the list of
what is up short.

The only things that stop a workspace's apps are its own spend limit
(apps pause with a notice, and come back once there is room; a paused
container is stopped and starts no more) and the plan ending (they come
down).

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
   [GitHub Actions](/guides/actions/). The sandbox checks out
   the commit with a read-only token that expires in 30 minutes. It
   reaches the internet, as
   [workflow jobs](/guides/actions/#what-a-job-can-reach) do, and it
   stops at 30 minutes.
   When it stops, what it cost is settled against what was reserved.
3. The sandbox builds, then lists its files. g1t opens an upload with
   Cloudflare for exactly those files and hands the sandbox a key that can
   upload them and nothing else. Files Cloudflare already has are skipped.
4. The sandbox sends the Worker's code to g1t, which puts the app in
   g1t's [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
   namespace, under the name in its address. A container build goes as
   [below](#containers).
5. A request to `*.g1t.page` reaches g1t's dispatcher, which runs the app
   by the name in the hostname. Nothing else is looked up. A request to a
   custom domain reaches the same dispatcher through Cloudflare for SaaS;
   it looks the hostname up once, in a key-value store kept at the edge.

Your code never holds a Cloudflare credential, and apps are served from
`g1t.page`, not `g1t.sh`, so they share no cookies or origin with the site
you sign in to.

### Containers

1. The build finds it is a container, and asks g1t where to push its
   image (the build's `registry` step). g1t mints a login to Cloudflare's
   registry, `registry.cloudflare.com`, that can **push only** and lasts
   **15 minutes**, and names the app's own repository,
   `<account>/g1t-<app>`, with the build's id as its tag. Asked before
   anything is built, so a build that could not push is not run.
2. The sandbox starts a Docker Engine of its own (as a workflow job's),
   builds the image for `linux/amd64`, checks its size against the
   container size's disk, pushes it with that login, and reports the
   image by its digest.
3. g1t runs only an image by digest in that app's repository, and asks
   the registry, with a pull login of its own, that the digest is there.
   It puts the app's Worker in the namespace: g1t's own code, never the
   project's, with a Durable Object class that holds the container, the
   project's secrets and variables, and a token for the app to report its
   running time with. Then it creates the app's Container application
   (at most one instance, at the project's size, attached to that class),
   or rolls it out to the new image.
4. A request reaches the app's Worker through the dispatcher, as any
   app's does. The Worker hands it to the app's Durable Object, which
   starts the container if it is asleep, with the environment, waits for
   it to answer on its port, and passes the request to it. Every minute it
   is awake, the object charges the next minute ahead and reports it to g1t
   (`POST /deployments/apps/<app>/meter` on the API, with its token); five
   minutes after the last request it stops the container.
5. A preview's container comes down with its pull request, its
   application and Worker deleted together.

Why it is built this way, from Cloudflare's documentation and Wrangler's
own code (October 2026):

- **Workers for Platforms runs containers.** A user Worker in a dispatch
  namespace may bind Containers, as a Durable Object
  ([WfP bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)).
  Wrangler's `deploy --dispatch-namespace` deploys containers by finding
  the Durable Object namespace of the class in that dispatch namespace and
  creating a Container application attached to it
  (`POST /accounts/{id}/containers/applications`, with
  `durable_objects.namespace_id`), then rolling out new images
  (`…/applications/{id}/rollouts`). So each app is a Worker of its own,
  with a class of its own, isolated as every app is, and the dispatcher
  routes to it unchanged. A single host Worker of g1t's could not run every
  app's image: a Durable Object starts only the images its Worker's
  configuration names.
- **The default scheduling policy.** It takes one image and size for the
  whole application, set through the API, which suits one app per
  application; the `durable_object` policy is in beta, and needs the
  image map uploaded with the Worker.
- **Registry logins.** Cloudflare mints registry credentials with
  `POST /accounts/{id}/containers/registries/registry.cloudflare.com/credentials`
  and `{ "permissions": ["push"], "expiration_minutes": 15 }`, as Wrangler
  does for its own pushes. They cannot be held to one repository, so g1t
  holds the build to its app's: it names the repository, runs nothing but a
  digest in it, and never gives a build a login that can pull, so no build
  can read another app's image. g1t's own Cloudflare token never reaches
  the sandbox.
- **Sizes and limits.** Containers' instance types are `lite` (1/16 vCPU,
  256 MiB, 2 GB) through `standard-4` (4 vCPU, 12 GiB, 20 GB); an image
  may be as large as its instance's disk, and an account holds 50 GB of
  images ([limits](https://developers.cloudflare.com/containers/platform/limits/)).
- **Scale to zero.** Containers are billed every 10 ms while running, and
  stop being billed once asleep. The Durable Object stops its container
  itself after five minutes without a request, rather than leaving it to
  the inactivity timeout, since the object's own minute alarm, which
  meters it, would otherwise keep it awake.

## Troubleshooting

| You see | Do |
| --- | --- |
| "Deployments come with the g1t plan … and `<workspace>` does not have it" | An owner starts the g1t plan under Billing. |
| A deployment **Skipped**, saying it reached its spend limit or that new compute is paused | The build was refused before it started. Follow the link in the message: raise the spend limit, prepay, or answer the spike, on Billing. |
| "Stopped: unusual CPU use" | The build looked like it was mining. Contact support if it was a real build; see [abuse and mining](/guides/guardrails/#abuse-and-mining). |
| "found nothing to serve" | Add a `build` script, an `index.html`, a Workers config or a `Dockerfile`; or set **Output directory**. |
| "Docker deployments are switched off on this g1t" | The project is a container, and this g1t (a self-hosted one) runs none. Set **Build as** to Static site or Workers if it can be built as one. See [Docker deployments](#docker-deployments). |
| "**Build as** is Container, but this project has no Dockerfile" | Add a `Dockerfile`, or set **Dockerfile** to its path. |
| "Could not run as a Worker: …; deploying as a container" | The Node.js server cannot run as a Worker, for the reason given; it deploys as a container. See [Node.js servers as Workers](#nodejs-servers-as-workers) for what to change, or set **Build as** to **Container** to skip the attempt. |
| "Built as a … site; Dockerfile is not used" | A site is preferred to a container. Set **Build as** to **Container** to deploy the `Dockerfile` instead. |
| "The image is 2.4 GB, more than the 2.0 GB an app of its size (lite) can hold" | Make the image smaller (a slim base image, a multi-stage build), or choose a larger **Container size**. |
| A container app says "The app did not start" | It did not answer on its port within 90 seconds. Make it listen on `0.0.0.0` at `PORT`, or `EXPOSE` the port it uses in its Dockerfile. Its output is in the build's log only while it builds; run the image locally with `docker run -e PORT=8080 -p 8080:8080` to see it start. |
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

Docker deployments also need the token to have **Containers: Edit** and
a Workers Paid plan with Containers; `CONTAINERS` in
`services/deployments/wrangler.jsonc` is `on`, and `off` turns them off
for an account without Containers. See
[Docker deployments](/guides/deploy-to-cloudflare/#docker-deployments)
for what to check on a new account.

Custom domains also need Cloudflare for SaaS on the apps' zone. Turn it on
under the zone's **SSL/TLS → Custom Hostnames**, give the token **SSL and
Certificates: Edit** on the zone, and run `scripts/setup-custom-domains.sh`:
it creates the `g1t-domains` KV namespace, the fallback origin's DNS record
(`domains`, `AAAA`, `100::`, proxied) and sets it as the fallback origin.
The dispatcher's `*/*` route on the zone, in `services/pages/wrangler.jsonc`,
is what brings custom domains' traffic to it.

Without a card processor configured, every feature is on and nothing is
charged.
