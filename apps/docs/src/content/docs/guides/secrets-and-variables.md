---
title: Secrets and variables
description: One list of keys and values for workflows and deployments. Each row says which environments it applies to and who reads it.
---

A [project](/guides/projects/) and a workspace each have one list of
secrets and variables.
Workflows and deployments both read from it; each row says whether one,
the other or both do, and which environments it applies to.

| Where | Page | Who sees and changes it |
| --- | --- | --- |
| A project | **Settings → Secrets and variables**, `g1t.sh/<workspace>/<project>/settings/secrets` | People with the Admin [role](/guides/access-and-roles/) on its repository |
| A workspace | **Settings → Secrets and variables**, `g1t.sh/<workspace>/-/secrets` | Owners |

Seeing the list needs the same as changing it: a project's rows, config
values included, are for Admins of its repository, and the page is not
shown to anyone else.

## A row

| Field | |
| --- | --- |
| **Type** | **Secret**: sealed when saved and never shown again, hidden in logs. For passwords, API keys and tokens. **Config**: readable by whoever may see the list. For values that are not sensitive. Config can be changed to a secret; a secret can never become config. |
| **Key** | Letters, digits and underscores, upper-cased: `STRIPE_KEY`. Keys starting with `G1T_` or `GITHUB_` are g1t's own. |
| **Value** | Up to 48 KB. |
| **Note** | Optional: where to rotate it, or who to ask. |
| **Environments** | **All environments**, or only some: **Production**, **Preview**, or any name a workflow job uses in `environment:`, such as `staging`. |
| **Available to** | **Workflows**, **Deployments**, or both (the default). |
| **Projects** | A workspace's row only: every project, or the ones you choose. |

### A value per environment

A key can have one row per environment, so production and previews use
different values. For example, Stripe's live key in production and its
test key everywhere else:

| Key | Type | Environments | Value |
| --- | --- | --- | --- |
| `STRIPE_KEY` | Secret | Production | `sk_live_…` |
| `STRIPE_KEY` | Secret | Preview | `sk_test_…` |

Two rows of the same key and type cannot apply to the same environment.
A key can also have a row for all environments alongside rows for some:
the rows for some win where they apply.

### Adding many at once

Paste the contents of a `.env` file into **Key** when adding. Each
`KEY=value` line becomes a row with the type, environments and readers you
choose; blank lines and `#` comments are skipped.

## Who reads what

| Reader | Reads | Environment it asks for |
| --- | --- | --- |
| A workflow job | Rows available to Workflows: secrets as `${{ secrets.KEY }}`, config as `${{ vars.KEY }}` | The job's `environment:`, if it has one |
| A deploy build | Rows available to Deployments, as environment variables | `production` or `preview` |
| A running app | The same rows, as bindings: `env.KEY` (a secret as a secret binding) | `production` or `preview` |
| An agent, acceptance checks, the merge queue | Nothing | |

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
- pull requests from g1t's agents.

Anyone else's pull request, such as one from a fork or by someone with
Read or Triage (who may open one on a private repository too), runs its
workflows, and builds its preview, with config only: no secrets, and an
empty `G1T_TOKEN`.

## G1T_TOKEN

Every trusted workflow job gets `${{ secrets.G1T_TOKEN }}`: a token of the
workspace's own for the run, which acts on g1t as the workspace and expires
when the job could no longer be running. `${{ secrets.GITHUB_TOKEN }}` and
`${{ github.token }}` are the same token, so workflows written for GitHub
work unchanged.

```yaml
- name: Open an issue when the nightly build fails
  if: failure()
  run: |
    curl -X POST https://api.g1t.sh/repos/${{ github.repository }}/issues \
      -H "Authorization: Bearer ${{ secrets.G1T_TOKEN }}" \
      -d '{"title":"Nightly build failed"}'
```

`G1T_TOKEN` can read secrets' names but never change secrets or variables,
so a workflow cannot rewrite what it runs with. Neither can any workspace
access token: use a person's token, or the site.

## From the API

The routes are GitHub's, and calls written for GitHub work unchanged: a
key named without an `id` or `environments` is the key's row for all
environments.

| Tool | Route |
| --- | --- |
| `list_actions_secrets` | `GET /repos/{owner}/{repo}/actions/secrets` |
| `set_actions_secret` | `PUT /repos/{owner}/{repo}/actions/secrets/{key}` |
| `delete_actions_secret` | `DELETE /repos/{owner}/{repo}/actions/secrets/{key}` |
| `list_actions_variables` | `GET /repos/{owner}/{repo}/actions/variables` |
| `set_actions_variable` | `POST /repos/{owner}/{repo}/actions/variables`, `PATCH …/variables/{key}` |
| `delete_actions_variable` | `DELETE /repos/{owner}/{repo}/actions/variables/{key}` |

A workspace's are under `/workspaces/{workspace}/actions/secrets` and
`…/variables`. Beyond GitHub's fields, a row takes:

| Field | |
| --- | --- |
| `id` | The row to change or remove, from a list. |
| `available_to` | `["workflows"]`, `["deployments"]` or both. `availableTo` works too. |
| `environments` | `["production"]`, `["preview", "staging"]`; `[]` for all. |
| `projects` | A workspace's row: project names; `[]` for every one. (`repositories` is read the same way.) |
| `note` | Where to rotate it, or who to ask. |

```sh
curl -X PUT https://api.g1t.sh/repos/acme/web/actions/secrets/STRIPE_KEY \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -d '{"value":"sk_live_…","environments":["production"],"available_to":["deployments"]}'
```

Unlike GitHub's, a secret is sent as plain `value` over HTTPS, not
encrypted to a public key.
