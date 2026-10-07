---
title: Run g1t yourself
description: Start the core forge on your own machine with Docker Compose.
---

g1t is MIT licensed. You can run the core forge on your own machine:
accounts, workspaces, repositories, git over HTTP, issues and pull
requests, the site to browse them, and the REST API and MCP server. Your
repositories are plain bare git repositories on a Docker volume.

This is an early version. It is for trying g1t out and for small teams on
a private network, not yet for an installation on the open internet.

## What works and what is off

| Feature | Self-hosted |
| --- | --- |
| Sign up, sign in, email confirmation | Works. Mail goes to the bundled Mailpit inbox. |
| Workspaces, members, access tokens | Works |
| Repositories: create, push and clone over HTTP, browse code, commits | Works. A fresh clone's pack is kept in the bundled MinIO, so the next clone of the same commit is served from there. |
| Issues, comments, labels | Works |
| Pull requests from a branch or from a fork, merged onto the default branch | Works, when the pull request is up to date with the default branch. Bringing one up to date first needs g1t's agent, which is off. |
| The merge queue | Takes pull requests and shows them waiting. Testing and landing them needs g1t's agent, which is off: take a pull request out of the queue, or turn the queue off, to merge it. |
| [The REST API](/reference/api/), OAuth and [MCP](/reference/mcp/) | Work, on a port of their own: `http://localhost:8789`, with the MCP server at `http://localhost:8789/mcp` |
| [Container images](/guides/containers/): `docker login`, push and pull at your `PUBLIC_URL` | Works, kept in the bundled MinIO, with no limit on a layer's size or on pulls |
| Site search | Works |
| A status page of your own | Works, at `http://localhost:8788` ([below](#the-status-page)) |
| Webhooks, integrations | Work, retries included |
| Sign in with GitHub, import from GitHub | Off until you register a GitHub App of your own ([below](#sign-in-with-github-and-import-from-github)). Mirrors sync on GitHub's webhook once GitHub can reach your API, and with **Sync now** either way. |
| g1t's agent: changes, plans and reviews | Off |
| Context hub search | Off |
| Deployments on `g1t.page` | Off |
| Billing | Off. Nothing is charged, and no usage limit stops work. |
| Git over SSH and the `g1t` CLI | Not available yet |
| Scheduled jobs | Run on their schedules inside the g1t container: webhook retries, purging deleted repositories, the packages sweep, security sweeps, audit log retention and access request summaries. Actions schedules (`on: schedule`) are not run. |

What hosted g1t cannot do yet either is on
[What g1t can't do yet](/about/limitations/).

## Before you start

- Docker with Compose v2 (`docker compose version`).
- About 4 GB of free disk space for the images.
- Ports 8787, 8788, 8789 and 8025 free on your machine.

## Start g1t

1. Get the source:

   ```sh
   git clone https://g1t.sh/flagon-io/g1t.git
   cd g1t
   ```

2. Build and start it. The first build compiles every service and takes a
   while:

   ```sh
   docker compose -f deploy/self-host/docker-compose.yml up --build -d
   ```

3. Open [http://localhost:8787](http://localhost:8787) and create an
   account.
4. Open the Mailpit inbox at [http://localhost:8025](http://localhost:8025)
   and follow the link in the confirmation email.
5. Create a workspace, then a repository.

## Push and clone

The remote is the site's address, then the workspace and repository:

```sh
git remote add origin http://localhost:8787/<workspace>/<repo>.git
git push -u origin main
```

Git asks for a username and password: use your g1t username and password,
or an access token, as described in [Git](/guides/git/#authentication).
Public repositories clone without signing in:

```sh
git clone http://localhost:8787/<workspace>/<repo>.git
```

## Use the API and MCP

The API answers at `http://localhost:8789`, the same routes as
`https://api.g1t.sh` (see the [API reference](/reference/api/)). Make an
access token under **Settings → Access tokens**, then:

```sh
curl -H "Authorization: Bearer $G1T_TOKEN" http://localhost:8789/user
```

The MCP server is at `http://localhost:8789/mcp`. Connect an agent to it
as [Bring your own agent](/guides/bring-your-own-agent/) shows, with this
address in place of `https://mcp.g1t.sh`:

```sh
claude mcp add --transport http g1t http://localhost:8789/mcp
```

Applications that sign people in with OAuth find everything at
`http://localhost:8789/.well-known/oauth-authorization-server`: the issuer
is the API's address, and people approve on your site, at
`PUBLIC_URL/oauth/authorize`. The site's clone box, agent setup and
access token examples show your own addresses.

## Check an installation

`deploy/self-host/smoke.sh` checks an installation from end to end:

1. It signs up a new account, confirms it through Mailpit, makes a
   workspace and a repository, pushes and clones (twice, the second from
   the clone pack cache), opens an issue and reads the code back through
   the site.
2. It makes an access token and calls the API, the OAuth metadata and the
   MCP server with it.
3. It opens a pull request from a branch and one from a fork, through the
   API, and merges both onto `main`.
4. It turns the merge queue on, merges a pull request into it, takes it
   out again, and merges it with the queue off.

```sh
bash deploy/self-host/smoke.sh
```

To also run every scheduled job once, give it the command that does so
inside the container:

```sh
SCHEDULER_ONCE="docker compose -f deploy/self-host/docker-compose.yml exec -T g1t \
  node deploy/self-host/scheduler.mjs --once /data/generated/schedules.json" \
  bash deploy/self-host/smoke.sh
```

It prints `All checks passed` when every step worked. It needs `curl`,
`git` and `node`.

## Settings

Set these in the environment, or in a `.env` file next to
`docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8787` | The address people use. Links in email, clone addresses and the site's link previews point here. |
| `G1T_PORT` | `8787` | The port the site is published on |
| `API_PORT` | `8789` | The port the API and the MCP server are published on |
| `API_URL` | `PUBLIC_URL`'s host on `API_PORT` | The address of the API, as people and applications reach it. It is also the OAuth issuer. Set it when the API is behind a proxy, for example `https://api.git.example.com`. |
| `MCP_URL` | `API_URL/mcp` | The address of the MCP server. |
| `MAILPIT_PORT` | `8025` | The port of the Mailpit inbox |
| `MAIL_FROM` | `g1t <noreply@localhost>` | The sender of g1t's email |
| `MAIL_URL` | `http://mailpit:8025` | The Mailpit server g1t sends mail through |
| `REGISTRATION_MODE` | `open` | `open`: anyone can make an account. `invite`: every new account needs an [invite](/guides/authentication/#invites), as on g1t.sh. |
| `INVITES_PER_USER` | `5` | How many invites each person can have out, while `REGISTRATION_MODE` is `invite` |
| `WAITLIST_NOTIFY_EMAIL` | (none) | Where a summary of new access requests goes, at most every 15 minutes. Empty sends none; requests still wait for you in the database. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the bundled MinIO, bucket `g1t-packages` | Where packages' files are kept: any S3-compatible store. Change the two keys before first start; MinIO is made with them. |
| `S3_PUBLIC_ENDPOINT` | (none) | The store's address as clients reach it. When set, large layers are downloaded from it directly with a signed URL. |
| `PACK_S3_BUCKET` | `g1t-git-packs` | The bucket on the same store that packs for fresh clones are kept in, so the next clone of the same commit is not built again. The bundled MinIO deletes packs after 7 days; on another store, give the bucket a rule that expires objects under `packs/` and unfinished multipart uploads. |
| `MINIO_IMAGE` | `pgsty/minio:latest` | The MinIO server image the bundled store runs. MinIO no longer publishes its own images; this is a community build of the same server. |
| `BACKUP_S3_BUCKET` | `g1t-backups` | The bucket on the same store that nightly repository backups (a `git bundle` of each repository whose branches or tags changed) are kept in. The bundles are cut by g1t's runner, which this installation does not run yet, so the bucket stays empty for now: copy the volumes, as below. |
| `STATUS_PORT` | `8788` | The port the status page is published on |
| `STATUS_PROBE_REPO` | (none) | A public repository, `workspace/repo`, whose branches the status page lists every minute as a clone would. Empty: git is not checked. |
| `INVITE_STAFF_WORKSPACES` | (none) | Workspace slugs, comma separated, whose owners can make invites without a limit. Set it to your own workspace before you switch to `invite`, so someone can invite the first people. |

## The status page

The `status` service runs the same status page as
[status.g1t.sh](/guides/status/), in a process of its own, so it keeps
answering when the site does not. Open
[http://localhost:8788](http://localhost:8788).

Every minute it loads the site's sign-in page from inside Compose, and,
with `STATUS_PROBE_REPO` set, lists that repository's branches. It keeps
90 days of history on its own volume, `g1t-status`. Parts an installation
of your own does not check (the API, MCP, docs, deployments, the model
proxy and billing) are left off its page.

The links to **Status** in the site's footer and account menu still point
to status.g1t.sh; pointing them at your own status page is not a setting
yet.

To deliver email to real inboxes, have Mailpit relay it through your SMTP
server. The settings are in `docker-compose.yml`, under `mailpit`.

Sign-in cookies are marked `Secure`. Browsers accept them on
`http://localhost`. On any other address, put g1t behind HTTPS (a reverse
proxy such as Caddy or nginx with a certificate) and set `PUBLIC_URL` to
the `https://` address.

## Sign in with GitHub and import from GitHub

g1t.sh's GitHub App works only for g1t.sh. To offer **Continue with
GitHub** and **Import from GitHub** on your own g1t, register an app of
your own. Without one, neither button appears.

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New
   GitHub App** (or the same under an organization's settings).
2. Fill it in, with `PUBLIC_URL` standing for your g1t's address:

   | Setting | Value |
   | --- | --- |
   | Callback URL | `PUBLIC_URL/auth/github/callback` |
   | Expire user authorization tokens | On |
   | Request user authorization (OAuth) during installation | Off |
   | Enable Device Flow | Off |
   | Setup URL | `PUBLIC_URL/integrations/github/setup` |
   | Redirect on update | On |
   | Webhook | On, with the URL `API_URL/hooks/github` and a secret you choose, once GitHub can reach your API. Otherwise off: mirrors then sync with **Sync now**. |
   | Repository permissions | Contents: Read and write; Metadata: Read; Issues: Read |
   | Account permissions | Email addresses: Read |

3. Create it, then on its page note the **App ID**, the **Client ID** and
   the slug (the last part of its public address,
   `github.com/apps/<slug>`). Generate a **client secret** and a **private
   key**, which downloads a `.pem` file.
4. Set these before starting g1t, in the environment or in `.env`:

   | Variable | Value |
   | --- | --- |
   | `GITHUB_APP_ID` | The App ID |
   | `GITHUB_APP_SLUG` | The slug |
   | `GITHUB_APP_CLIENT_ID` | The Client ID |
   | `GITHUB_APP_CLIENT_SECRET` | The client secret |
   | `GITHUB_APP_PRIVATE_KEY` | The `.pem` file's contents, as downloaded. Line breaks may be written as `\n`. |
   | `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret, if the webhook is on |

5. Restart g1t: `docker compose -f deploy/self-host/docker-compose.yml up -d`.

g1t makes its own key for the GitHub tokens it keeps (`IDENTITY_KEY`, in
the `g1t-data` volume) on first start. What the app can do, and what comes
across from GitHub, is in [GitHub](/guides/github/).

## Where your data lives

| Volume | Holds |
| --- | --- |
| `g1t_g1t-data` | Accounts, workspaces, issues and every other record, as SQLite files; the keys that seal stored secrets (`keys.env`) |
| `g1t_g1t-git` | Your repositories, one bare git repository each |
| `g1t_g1t-packages` | Container images' layers and other package files, the `g1t-backups` bucket and the clone packs in `g1t-git-packs` (MinIO) |
| `g1t_g1t-secrets` | The key the site and the git store share |

To back up, stop g1t and copy the volumes:

```sh
docker compose -f deploy/self-host/docker-compose.yml stop
docker run --rm -v g1t_g1t-data:/data -v g1t_g1t-git:/git -v "$PWD":/backup \
  debian:bookworm-slim tar czf /backup/g1t-backup.tgz /data /git
docker compose -f deploy/self-host/docker-compose.yml start
```

Keep `keys.env` with the backup. Without it, saved webhook, integration and
Actions secrets cannot be opened.

## Upgrade

Pull the new source and rebuild. Database changes are applied on start,
and changes already applied are skipped:

```sh
git pull
docker compose -f deploy/self-host/docker-compose.yml up --build -d
```

## Stop and remove

```sh
docker compose -f deploy/self-host/docker-compose.yml down        # keeps your data
docker compose -f deploy/self-host/docker-compose.yml down -v     # deletes it
```
