---
title: Security
description: How g1t keeps secrets out of your repositories, finds vulnerable dependencies, and has an agent land the upgrades that fix them.
---

Every project has a **Security** page at `g1t.sh/<owner>/<project>/security`.
It shows what g1t has found, and what is being done about each finding:

- **Secrets.** A push that adds a key or a token is refused before it lands,
  and each repository's history is scanned once, in the background.
- **Dependencies.** Every package your lockfiles resolve is checked against
  the [OSV](https://osv.dev) database of known vulnerabilities. Each
  vulnerable package that has a fix gets an upgrade issue, and a g1t agent
  lands the upgrade through the usual pull request, checks, review and merge
  queue.

Findings are the workspace's to fix, so the Security page needs a
[role](/guides/access-and-roles/) on the repository, whether the project
is public or private:

| | Needs |
| --- | --- |
| See findings, **Re-scan now** | Write |
| **Upkeep agents** on or off | Maintain |
| **Allow**, **Resolve** or **Reopen** a secret | Admin |

Someone with Read or Triage is told the page needs Write. The workspace's
own page, `g1t.sh/<owner>/-/security`, lists the open findings of every
project the member can see them on, most severe first.

## The overview

The top of the page counts open findings by severity: critical, high,
medium, low and unrated. A secret that is open, or that stopped a push,
counts as critical. Below the counts:

- **Re-scan now** reads the dependencies again at once and scans the
  history again from the start.
- **Upkeep agents** turns upgrade issues on or off for the project. It is on
  unless someone turns it off. With it off, findings are still listed, and
  nothing is opened for them.

The **Secrets** and **Dependencies** tabs list each finding with its status
and the issue or pull request fixing it.

## Secret scanning

g1t looks for credentials whose format their issuer made recognisable, so a
match is nearly always a real secret or a fake made to look like one:

| What | What it looks like |
| --- | --- |
| AWS access keys | `AKIA` or `ASIA` and 16 more characters |
| AWS secret access keys | 40 characters on a line that names an AWS secret |
| GitHub tokens | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
| GitLab tokens | `glpat-`, `gloas-`, `glrt-`, `glptt-`, `gldt-` |
| Stripe live keys | `sk_live_`, `rk_live_` (test keys are left alone) |
| Slack | `xoxb-`, `xoxp-` and other tokens, and incoming webhook addresses |
| Google API keys | `AIza` and 35 more characters |
| Anthropic API keys | `sk-ant-` |
| OpenAI API keys | `sk-proj-`, `sk-svcacct-`, `sk-admin-`, and older `sk-` keys |
| Private keys | A PEM `BEGIN … PRIVATE KEY` header followed by the key |
| Service-role JWTs | A JWT whose claims carry `service_role` |
| npm tokens | `npm_` |
| g1t tokens | `g1t_` and 40 hex characters |
| SendGrid keys | `SG.` and two dotted parts |

Placeholders such as `ghp_xxxxxxxx…` are not reported. Lockfiles, and files
under `node_modules/` and `vendor/`, are not scanned.

g1t never stores a secret it finds. It keeps a fingerprint, so it can
recognise the same secret again, and a short preview, such as `AKIA…`, so
you can recognise it.

### Push protection

When a push over HTTPS adds a secret, g1t refuses the whole push and nothing
is stored. Only the lines the push adds are checked, so a secret that is
already in the repository does not block every later push to the same file.
This applies to every push, including the pushes g1t's agents make to their
pull requests.

Git shows why, file and line:

```text
$ git push
remote: g1t found a secret in this push, so nothing was pushed.
remote:
remote:   config/prod.env:3  an AWS access key  (commit 4807077)
remote:
remote: Take the secret out of the commit that adds it (git commit --amend, or
remote: git rebase -i for an older commit), rotate it if it was ever real, and
remote: push again.
remote:
remote: If it is not a real secret, such as a test fixture:
remote:   - add g1t:allow-secret in a comment on its line, or
remote:   - allow it once at https://g1t.sh/acme/rocket/security?tab=secrets&finding=sec_…
remote:     Allowing is recorded with your name, then the same push goes through.
To https://g1t.sh/acme/rocket.git
 ! [remote rejected] main -> main (secret found: config/prod.env:3 has an AWS access key)
```

To fix a real secret:

1. Remove it from the commit that adds it: `git commit --amend` for the last
   commit, `git rebase -i` for an older one.
2. Rotate it with whoever issued it. Once a secret has been on any machine
   but yours, treat it as known.
3. Push again.

### Allowing a false positive

A fake key in a test, or an example in documentation, is still reported, on
purpose: it looks exactly like a real one. Two ways to let it through:

- **Mark the line.** Put `g1t:allow-secret` anywhere on the line, usually in
  a comment. The line is never reported, in any push or in history.

  ```ts
  const FIXTURE_KEY = "AKIA…"; // g1t:allow-secret
  ```

- **Allow it once.** Open the link in git's message (or the finding on the
  **Secrets** tab), choose **Allow**, and say why. g1t records who allowed
  it and why. Then push again, unchanged: that secret no longer stops a push
  to this project.

Allowing needs the Admin [role](/guides/access-and-roles/) on the repository. Someone else
pushing to a pull request's fork sees the same message and asks someone
who has it.

### Secrets in history

The first time g1t sees a repository (when it is created, on its next push
to the default branch, or when its Security page is first opened) it scans
the default branch's history in the background, a page of commits at a
time, comparing each commit with its first parent. The page shows how far
it has got. Scanning is metered to the workspace like other usage, and it
pauses if the workspace reaches its spending limit.

A secret found in history is **Open**: it is in the repository, and anyone
who could clone it may have it. Rotate it, then choose **Resolve** and say
what you did. Removing it from the code is not enough, since it stays in
history.

| Status | Meaning |
| --- | --- |
| Open | In the repository's history. Rotate it, then resolve it. |
| Push blocked | A push carrying it was refused, so it never landed. |
| Allowed | Someone said it is not a real secret; pushes carrying it go through. |
| Resolved | Someone rotated or removed it. |

**Reopen** undoes an allow or a resolve.

## Dependency upkeep

g1t reads these lockfiles on the default branch, up to four directories
deep, skipping `node_modules`, `vendor`, `target`, `dist` and `build`:

| Ecosystem | Files |
| --- | --- |
| npm | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| Cargo | `Cargo.lock` |
| Go | `go.mod` (or `go.sum` where there is no `go.mod`) |
| Python | `poetry.lock`, and pinned lines (`name==1.2.3`) in `requirements.txt` |

It reads them on every push to the default branch and again every day, and
asks OSV about every package at the exact version locked. Each advisory
found is listed with its id (its GHSA id when it has one), severity, the
version that fixes it, and the lockfile that resolves the vulnerable
version. A vulnerability that a later scan no longer finds is marked fixed.

### Upgrade issues

With **Upkeep agents** on, each vulnerable package that has a fixed version
gets one issue, labelled `dependencies` and `security`, such as:

> Upgrade lodash to 4.17.21: fixes GHSA-35jh-r3h4-6jhm

The issue lists every advisory it fixes, and the target is the lowest
version that fixes all of them. It ends with a **Definition of done**: no
lockfile resolves a vulnerable version and the tests still pass, followed
by the commands that show it, each as "`command` passes.":

- a command per lockfile that fails while the lockfile still resolves the
  vulnerable version, and
- the project's tests, run in the lockfile's directory by its package
  manager:

  | Lockfile | Tests |
  | --- | --- |
  | `package-lock.json` | `npm ci && npm test --if-present` |
  | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile && pnpm test --if-present` |
  | `yarn.lock` | `yarn install`, then `yarn test` |
  | `Cargo.lock` | `cargo test --locked` |
  | `go.mod`, `go.sum` | `go test ./...` |

  Python projects get the lockfile command only, since there is no one way
  to run their tests.

The definition of done tells the agent and its reviewer what to verify. The
pull request merges on the repository's
[required status checks](/guides/pull-requests/#required-status-checks),
as any other does.

g1t puts its agent on the first new upgrade at once and queues the rest,
which start as the project has room for more agents. The agent upgrades the
package, changes whatever code the upgrade breaks, and opens a pull request
that goes through checks, review and the merge queue like any other. When it
merges, the next scan finds the vulnerability fixed.

g1t opens at most eight upgrade issues per scan, most severe first, and
never a second issue for a package while one is open. If you close an
upgrade issue as not planned, g1t does not open it again. If agents cannot
run in the workspace, the issue stays open with a comment saying why, for
you to assign once they can, or to upgrade by hand.

Turn **Upkeep agents** off on the Security page to stop new upgrade issues
for a project. Issues already open are left as they are.
