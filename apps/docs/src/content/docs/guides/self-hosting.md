---
title: Run g1t yourself
description: Start the core forge on your own machine with Docker Compose.
---

g1t is MIT licensed. You can run the core forge on your own machine:
accounts, workspaces, repositories, git over HTTP, issues and pull
requests, and the site to browse them. Your repositories are plain bare
git repositories on a Docker volume.

This is an early version. It is for trying g1t out and for small teams on
a private network, not yet for an installation on the open internet.

## What works and what is off

| Feature | Self-hosted |
| --- | --- |
| Sign up, sign in, email confirmation | Works. Mail goes to the bundled Mailpit inbox. |
| Workspaces, members, access tokens | Works |
| Repositories: create, push and clone over HTTP, browse code, commits | Works |
| Issues, comments, labels | Works |
| Site search | Works |
| Webhooks, integrations | Run, but scheduled retries do not (see below) |
| g1t agents, plans, reviews by agents | Off |
| Context hub search | Off |
| Deployments on `g1t.page` | Off |
| Billing | Off. Nothing is charged, and no usage limit stops work. |
| Git over SSH, the REST API, MCP and the `g1t` CLI | Not available yet |
| Scheduled jobs (webhook retries, Actions schedules) | Not run yet |

## Before you start

- Docker with Compose v2 (`docker compose version`).
- About 4 GB of free disk space for the images.
- Ports 8787 and 8025 free on your machine.

## Start g1t

1. Get the source:

   ```sh
   git clone https://g1t.sh/syntaqx/g1t.git
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

## Check an installation

`deploy/self-host/smoke.sh` signs up a new account, confirms it through
Mailpit, makes a workspace and a repository, pushes, clones, opens an issue
and reads the code back through the site:

```sh
bash deploy/self-host/smoke.sh
```

It prints `All checks passed` when every step worked.

## Settings

Set these in the environment, or in a `.env` file next to
`docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8787` | The address people use. Links in email point here. |
| `G1T_PORT` | `8787` | The port the site is published on |
| `MAILPIT_PORT` | `8025` | The port of the Mailpit inbox |
| `MAIL_FROM` | `g1t <noreply@localhost>` | The sender of g1t's email |
| `MAIL_URL` | `http://mailpit:8025` | The Mailpit server g1t sends mail through |

To deliver email to real inboxes, have Mailpit relay it through your SMTP
server. The settings are in `docker-compose.yml`, under `mailpit`.

Sign-in cookies are marked `Secure`. Browsers accept them on
`http://localhost`. On any other address, put g1t behind HTTPS (a reverse
proxy such as Caddy or nginx with a certificate) and set `PUBLIC_URL` to
the `https://` address.

## Where your data lives

| Volume | Holds |
| --- | --- |
| `g1t_g1t-data` | Accounts, workspaces, issues and every other record, as SQLite files; the keys that seal stored secrets (`keys.env`) |
| `g1t_g1t-git` | Your repositories, one bare git repository each |
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
