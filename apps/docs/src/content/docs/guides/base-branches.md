---
title: Pull requests into other branches
description: Open a pull request into a branch other than the default one, change the branch a pull request merges into, and what holds there.
---

A pull request merges into its base: the repository's default branch,
unless you choose another. A release branch, a long-running feature branch
or a branch that collects several changes before they reach `main` can
each take pull requests of their own.

## Open a pull request into another branch

1. Open **Pull requests**, then **New pull request**. Or open **Compare**,
   choose the branch to merge into as **base** and yours as **compare**,
   then **Open a pull request**.
2. Beside **into**, choose the branch it should merge into.
3. Give it a title and a description, and open it.

A branch can have one open pull request into each base.

## Change the branch it merges into

You need the Write [role](/guides/access-and-roles/) or higher.

1. Open the pull request.
2. Under its title, choose the branch name after **into**.
3. Pick the branch it should merge into.

Changing the base is noted in the conversation and is a `pull.base_changed`
event. Whether it is behind, whether it merges cleanly, and its required
checks are worked out again against the new base, and a pull request in
the merge queue leaves it.

## What holds in another branch

| | Into the default branch | Into another branch |
| --- | --- | --- |
| [Required status checks](/guides/pull-requests/#required-status-checks) | Must pass | Not required |
| Required approvals | As the repository asks | Not required |
| Must be up to date | As the repository asks | No |
| [Merge queue](/guides/merge-queue/) | Joins it, when it is on | Never; it merges directly |
| Catching up | Merges the default branch in | Merges its base in |
| Its issue | Closes when it merges | Stays open |

The repository's protection settings guard the default branch, so they do
not hold for a pull request into another branch. Merging still needs the
Write role, and the default branch takes the work only through a pull
request into it, which is held to everything above.

## g1t's agent and other branches

When you assign an issue to g1t, its pull request merges into the default
branch. Change the base on its pull request and g1t works against that
branch from then on: it catches up with it, resolves conflicts with it,
and its reviewer compares the change with it. `@g1t` on such a pull
request works against its base too.

## From the API

- `base` on `POST /repos/{owner}/{name}/pulls` (`pull_request` `create`)
  opens it into that branch. Leave it out for the default branch.
- `base` on `PATCH /repos/{owner}/{name}/pulls/{number}`
  (`pull_request` `update`) changes it.
- `base` filters `GET /repos/{owner}/{name}/pulls` (`pull_request` `list`).
- A pull request's `base` names the branch it merges into.

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/web/pulls/14 \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"base": "release/1.x"}'
```

[Workflows](/guides/actions/) see the base as `github.base_ref` and
`pull_request.base.ref`, and `branches` filters on `pull_request` match it.
A base change starts `pull_request` workflows with the `edited` activity
type.

[Dependency updates](/guides/dependency-updates/) open their pull requests
into an entry's `target-branch`.
