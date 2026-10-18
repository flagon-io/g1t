---
title: Secrets and variables
description: One list of keys and values for workflows and deployments. Each row says which environments it applies to and who reads it.
---

A [project](/guides/projects/) and a workspace each have one list of
secrets and variables.
Workflows and deployments both read from it; each row says whether one,
the other or both do, and which environments it applies to.

| Where       | Page                                                                                  | Who sees and changes it                                                   |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A project   | **Settings → Secrets and variables**, `g1t.sh/<workspace>/<project>/settings/secrets` | People with the Admin [role](/guides/access-and-roles/) on its repository |
| A workspace | **Settings → Secrets and variables**, `g1t.sh/<workspace>/-/secrets`                  | Owners                                                                    |

Seeing the list needs the same as changing it: a project's rows, config
values included, are for Admins of its repository, and the page is not
shown to anyone else.

A workflow that deploys to AWS, Google Cloud or Azure needs no cloud key
here: it can sign in with the job's short-lived
[OIDC token](/guides/actions/#oidc-tokens) instead.

## A row

| Field            |                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Type**         | **Secret**: sealed when saved and never shown again, hidden in logs. For passwords, API keys and tokens. **Config**: readable by whoever may see the list. For values that are not sensitive. Config can be changed to a secret; a secret can never become config. |
| **Key**          | Letters, digits and underscores, not starting with a digit, upper-cased: `STRIPE_KEY`. Keys starting with `G1T_` or `GITHUB_` are g1t's own.                                                                                                                       |
| **Value**        | Up to 48 KB.                                                                                                                                                                                                                                                       |
| **Brokered**     | A secret only: the hosts it is for. Jobs get a stand-in, and g1t fills in the value on their requests to those hosts. See [brokered secrets](#brokered-secrets).                                                                                                   |
| **Note**         | Optional: where to rotate it, or who to ask.                                                                                                                                                                                                                       |
| **Environments** | **All environments**, or only some: **Production**, **Preview**, or any name a workflow job uses in `environment:`, such as `staging`.                                                                                                                             |
| **Available to** | **Workflows**, **Deployments**, or both (the default).                                                                                                                                                                                                             |
| **Projects**     | A workspace's row only: every project, or the ones you choose.                                                                                                                                                                                                     |

### A value per environment

A key can have one row per environment, so production and previews use
different values. For example, Stripe's live key in production and its
test key everywhere else:

| Key          | Type   | Environments | Value       |
| ------------ | ------ | ------------ | ----------- |
| `STRIPE_KEY` | Secret | Production   | `sk_live_…` |
| `STRIPE_KEY` | Secret | Preview      | `sk_test_…` |

Two rows of the same key and type cannot apply to the same environment.
A key can also have a row for all environments alongside rows for some:
the rows for some win where they apply.

### Adding many at once

Paste the contents of a `.env` file into **Key** when adding. Each
`KEY=value` line becomes a row with the type, environments and readers you
choose; blank lines and `#` comments are skipped.

## Who reads what

| Reader                   | Reads                                                                                     | Environment it asks for                 |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| A workflow job           | Rows available to Workflows: secrets as `${{ secrets.KEY }}`, config as `${{ vars.KEY }}` | The job's `environment:`, if it has one |
| A deploy build           | Rows available to Deployments, as environment variables                                   | `production` or `preview`               |
| A running app            | The same rows, as bindings: `env.KEY` (a secret as a secret binding)                      | `production` or `preview`               |
| The merge queue's builds | Nothing                                                                                   |                                         |

For each key, a reader gets the row for its environment if there is one,
else the row for all environments. A row only for other environments gives
it nothing.

A project's row overrides its workspace's of the same key. The project's
list shows the workspace's rows that reach it, marked
**Workspace**, until it sets the key itself.

A running app's rows are bound by g1t when it puts the app up; they never
pass through the build's sandbox. A row of a Workers project's own
`vars` with the same name is replaced.

## Who gets secrets

Secrets go only to trusted runs:

- pushes, schedules, manual runs and the merge queue;
- pull requests whose author has the Write [role](/guides/access-and-roles/)
  or higher on the repository, a member or an
  [outside collaborator](/guides/access-and-roles/#outside-collaborators);
- pull requests g1t opened on its own, such as a security update.

Anyone else's pull request, such as one from a fork or by someone with
Read or Triage (who may open one on a private repository too), runs its
workflows, and builds its preview, with config only: no secrets, and a
`G1T_TOKEN` that can only read. Its runs may first wait for someone with
Write to [approve them](/guides/actions/#pull-requests-from-outside).

A job that names an environment gets that environment's secrets only once
the environment's [protection rules](/guides/actions/#environments) let it
through: required reviewers, a wait timer, and which branches may deploy.

## Brokered secrets

A secret a job uses only to call an API need not enter the job at all.
Broker it, and the job gets a stand-in in its place: a token such as
`g1tsec_3f9c…` (48 random characters after the prefix), made for that job
and that secret alone. As the job's requests leave its sandbox, g1t puts
the real value in place of the stand-in on HTTPS requests to the hosts
the secret is for; never over plain HTTP, where it would cross the
internet readable. Code in the job, a compromised dependency included, can
read only the stand-in, which works nowhere else and stops working when
the job ends.

To broker a secret:

1. Open **Settings → Secrets and variables**, and add or edit the secret.
2. Under **Brokered**, tick **Only for these hosts**.
3. List the hosts it is for, one per line: `registry.npmjs.org`, or
   `*.example.com` for every subdomain of `example.com` (not
   `example.com` itself; list both if you need both).
4. Save.

Workflows use it as they would any secret: `${{ secrets.NPM_TOKEN }}` in an
`Authorization` header, an `.npmrc`, or a tool's settings.

```yaml
- run: npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Where the value is filled in

| In the request         |                                                                               |
| ---------------------- | ----------------------------------------------------------------------------- |
| Any header             | As it is: `Authorization: Bearer …`, `Authorization: token …`, `X-Api-Key: …` |
| `Authorization: Basic` | Decoded, filled in, and encoded again, so `user:$TOKEN` works                 |
| The query string       | `?key=…`, encoded for the URL                                                 |
| The path and the body  | Never: the stand-in goes as it is                                             |

A request to a host the secret is not for goes out with the stand-in,
which is useless to whoever receives it, and the job's log says so once:
`NPM_TOKEN was sent to example.com, which it is not for, so g1t did not
fill it in.`

If an answer echoes the value back, it is swapped for the stand-in again
in the answer's headers, and in its body when that is plain text (JSON,
XML, text) of at most 256 KB sent uncompressed. A request with a filled-in
value is not followed through redirects outside the sandbox: the job
follows them itself, and each is filled in only for the secret's hosts.

### Where it works

- **Workflow jobs on g1t's machines.** A job that may be given a
  brokered secret sends its HTTP and HTTPS through g1t's runner Worker,
  which fills the value in and sends every request on, to any host, and
  the job trusts the certificate its HTTPS is re-signed with. Other jobs'
  requests go straight out. Other protocols are not affected.
- **Self-hosted runners on Linux and macOS**, in Docker, in the desktop
  app's sandbox, or directly on the computer: the job's requests to the
  secret's hosts go through g1t, which fills the value in, so it never
  reaches your computer. See
  [on a self-hosted runner](#on-a-self-hosted-runner).
- **Self-hosted runners whose jobs run on Windows** (Windows Sandbox, or
  directly on Windows): not yet. A job there gets the stand-in, never the
  value, and its log warns that requests using it will not be signed in.
  So does a job on a runner from before brokering. Keep a separate,
  unbrokered secret for jobs that must run there.
- **Deployments** never read a brokered secret: a running app needs the
  value itself. A brokered secret is available to workflows only.
- **Security updates' private registries** do not get a brokered secret.

The value is masked in the job's log as any secret is, should it ever
appear there, and so is the stand-in.

### On a self-hosted runner

A self-hosted runner's traffic does not leave through g1t, and g1t never
sends a brokered value to a computer it does not run. So the runner
brings the requests that need the value to g1t instead:

1. The job gets the stand-in, as on g1t's machines, and the runner is
   told which hosts each stand-in is for. It is never told a value.
2. The job's steps get `HTTPS_PROXY` pointing at a proxy the runner runs
   for that job on `127.0.0.1`. HTTPS to any host the job's brokered
   secrets are not for passes through it as a plain tunnel, which the
   runner never sees inside.
3. HTTPS to one of those hosts is opened with a certificate the runner
   makes for that host. It comes from a certificate authority made for
   that job alone, which can sign for the brokered hosts and no others,
   and whose key is never written to disk. The steps trust it through the
   same variables as on g1t's machines (`SSL_CERT_FILE`,
   `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
   `PIP_CERT`, `GIT_SSL_CAINFO`, `CARGO_HTTP_CAINFO`), each pointing at
   what it pointed at before with the job's certificate added.
4. A request on that connection that carries one of the job's stand-ins
   goes to g1t with the job's token. g1t fills the value in as described
   above, sends the request without following redirects, and sends back
   the answer, with the value swapped back for its stand-in in its headers
   and in any text body, whatever its size. A request without a stand-in
   goes straight to the host.

g1t relays only a request that carries one of the job's own stand-ins,
over HTTPS, to one of that secret's hosts, and only while the job runs,
with the token the job holds now. Anything else is refused, and the job's
log says so once. The log's first lines name each brokered secret and the
hosts its requests go to g1t for.

Requests to brokered hosts take the longer way, through g1t, so they are
a little slower, and have limits:

| Limit                            |                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A request's body                 | 32 MB                                                                                                                    |
| An answer's body                 | 1 GB                                                                                                                     |
| One request, its answer included | 10 minutes                                                                                                               |
| HTTP versions                    | HTTP/1.1 between the job and the runner; plain HTTP is never filled in, and `HTTP_PROXY` is left as your computer has it |

What a self-hosted runner does not cover:

- **Jobs that run on Windows**, as above.
- **Containers a step starts**: a Docker action, `services:`, or
  `docker run` in a step. They do not get the job's proxy, so their
  requests carry the stand-in as it is.
- **A computer that sets its own `HTTPS_PROXY`.** The runner does not
  chain proxies: its jobs get the stand-in and the warning.
- **Tools that ignore `HTTPS_PROXY`** or bring their own trusted
  certificates send the stand-in as it is. npm and most other package
  managers, `curl`, `git`, Cargo, Python's `requests` and Go use it.
  Node.js's own `fetch` and `https` use it in the releases that read
  `NODE_USE_ENV_PROXY`, which the runner sets.

### What brokering cannot cover

A secret the job itself must read cannot be brokered. Keep these as
ordinary secrets:

- passwords for a database or service reached over raw TCP rather than
  HTTP, such as PostgreSQL or Redis;
- signing keys (code signing, GPG, SSH, a release's private key), which
  the job uses to sign rather than sends;
- keys to files the job decrypts;
- tests that need the real value inside the job;
- a value sent in a request's body or path, such as an OAuth client
  secret posted in a form.

A brokered value is at least 8 characters, so it is not found inside
other secrets by chance.

## G1T_TOKEN

Every workflow job gets `${{ secrets.G1T_TOKEN }}`: a token for that job
alone, which reaches its repository only, can do what the job's
`permissions:` say, and stops working when the job ends.
`${{ secrets.GITHUB_TOKEN }}` and `${{ github.token }}` are the same token,
so workflows written for GitHub work unchanged. See
[the job's token](/guides/actions/#the-jobs-token).

```yaml
# On the job: permissions: { work: write }
- name: Open a work item when the nightly build fails
  if: failure()
  run: |
    curl -X POST https://api.g1t.sh/workspaces/${{ github.repository_owner }}/work \
      -H "Authorization: Bearer ${{ secrets.G1T_TOKEN }}" \
      -d '{"title":"Nightly build failed","repo":"${{ github.repository }}"}'
```

`G1T_TOKEN` can neither list nor change secrets or variables, so a
workflow cannot read or rewrite what it runs with. No workspace access
token can change them either: use a person's token, or the site.

## From the API

The routes are GitHub's, and calls written for GitHub work unchanged: a
key named without an `id` or `environments` is the key's row for all
environments.

| MCP (`secret` tool) | Route                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `list_secrets`      | `GET /repos/{owner}/{repo}/actions/secrets`                               |
| `set_secret`        | `PUT /repos/{owner}/{repo}/actions/secrets/{key}`                         |
| `delete_secret`     | `DELETE /repos/{owner}/{repo}/actions/secrets/{key}`                      |
| `list_variables`    | `GET /repos/{owner}/{repo}/actions/variables`                             |
| `set_variable`      | `POST /repos/{owner}/{repo}/actions/variables`, `PATCH …/variables/{key}` |
| `delete_variable`   | `DELETE /repos/{owner}/{repo}/actions/variables/{key}`                    |

A workspace's are under `/workspaces/{workspace}/actions/secrets` and
`…/variables`. Beyond GitHub's fields, a row takes:

| Field            |                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | The row to change or remove, from a list.                                                                                                        |
| `available_to`   | `["workflows"]`, `["deployments"]` or both. `availableTo` works too.                                                                             |
| `environments`   | `["production"]`, `["preview", "staging"]`; `[]` for all.                                                                                        |
| `projects`       | A workspace's row: project names; `[]` for every one. (`repositories` is read the same way.)                                                     |
| `note`           | Where to rotate it, or who to ask.                                                                                                               |
| `brokered_hosts` | A secret's: `["registry.npmjs.org"]`, `["*.example.com"]` to [broker it](#brokered-secrets); `[]` stops brokering it. Listed rows return it too. |

```sh
curl -X PUT https://api.g1t.sh/repos/acme/web/actions/secrets/STRIPE_KEY \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -d '{"value":"sk_live_…","environments":["production"],"available_to":["deployments"]}'
```

A secret is sent as plain `value` over HTTPS, not encrypted to a public
key first.
