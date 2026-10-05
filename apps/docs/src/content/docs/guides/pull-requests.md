---
title: Pull requests and checks
description: What the merge box shows before a pull request can merge, every check and what a failed one printed, and conflicts found before anyone tries to merge.
---

At the foot of an open pull request's conversation, the **merge box** says
what stands between it and its target branch: its checks, its reviews,
whether it merges cleanly, and the button that merges it. Everything in it
updates by itself while something is still running.

## Checks

A pull request has two kinds of checks, and the merge box lists both in
one place:

- **Acceptance checks**: the commands written on the issue it is for, run
  against its head in a clean sandbox that holds nothing but that commit.
  No agent runs there, so a pass says something about the code. See
  [acceptance checks](/concepts/overview/#acceptance-checks).
- **Workflows**: the repository's [GitHub Actions workflows](/guides/actions/)
  run on its head, listed job by job.

The first line sums them up: **All checks have passed**, **2 of 5 checks
failed**, or how many are still running. Below it, each check has a row with
its state, its command or job name, and how long it took.

### What a failed check printed

A failed acceptance check opens by itself and shows:

- the exit code, or that it was stopped for taking too long (ten minutes);
- what it printed, standard output and error together, as a log with line
  numbers and its colours, and a button to copy it;
- a note when the output was long and only its end was kept, which is where
  failures are.

A workflow job's **Details** opens its log on the run's page.

Above the acceptance checks is the commit they ran on, linked. If the pull
request has been pushed to since, the box says so: those results are for
an older commit, and the latest push has not been checked yet.

When the checks could not be run at all, for example because the sandbox
stopped, the box says why instead of listing results.

### Running them again

**Re-run checks** runs the acceptance checks again on the current head.
Whoever opened the pull request and members of the workspace can. Members
can also **Re-run failed jobs** of a workflow that failed.

**Earlier runs of the acceptance checks** lists the runs before the latest,
with the commit each ran on and how it went.

The acceptance checks also run again by themselves on every push.

## Conflicts

g1t works out whether a pull request merges cleanly into its target before
anyone tries to merge it, and again whenever either side moves: a push to
the pull request, or anything landing on the target branch.

1. **Without a sandbox.** g1t compares the files the pull request changed
   since it and the target last agreed with the files the target changed
   since then. If they share none, the merge cannot conflict, and that is
   the answer.
2. **With a short probe.** If they share files, a sandbox merges the two
   commits without an agent and pushes nothing, and reports the files that
   conflict. Meanwhile the box says **Checking whether this merges cleanly**,
   and the merge button waits. Probes are metered as sandbox time, like
   checks; each pair of commits is probed once, and a repository runs at most
   three at a time, the rest following in turn.

A pull request that conflicts shows **This branch has conflicts that must
be resolved**, the conflicting files, each linked to its diff, and three
ways to resolve them:

- **Resolve with g1t agent.** An agent merges the target branch in,
  resolves the conflicts keeping what both sides meant, and pushes the
  result. It is told which files conflict. Available to whoever can push to
  the pull request: for a pull request's fork, whoever opened it; for a
  branch, any member.
- **Resolve in the browser.** Coming soon.
- **On the command line.** The box lists the commands, each with a copy
  button. For a pull request from a branch:

  ```sh
  git fetch origin
  git checkout my-branch
  git merge origin/main
  # fix each conflicting file, then
  git add -A && git commit --no-edit
  git push origin my-branch
  ```

  For a pull request in its own fork, clone the fork and pull `main` into
  it instead:

  ```sh
  git clone https://g1t.sh/pulls/<id>.git && cd <id>
  git pull --no-rebase https://g1t.sh/<owner>/<repo>.git main
  ```

While it conflicts, it cannot be merged or added to the
[merge queue](/guides/merge-queue/), and the merge button says so. Once the
fix is pushed, g1t works it out again.

A pull request that only has fallen behind its target, without conflicts,
still merges: merging brings it up to date first, unless the repository
requires pull requests to be up to date.

## Catching up

When the target branch has moved, the merge box says **main has moved since
this was made**. Whoever can push to the pull request (whoever opened it,
for one in its own fork; any member of the workspace, for a branch) can
press **Catch up with main now**:

1. **When the two changed different files**, g1t merges `main` in itself,
   in a few seconds. The merge commit is named **Merge main into
   *branch***, has the pull request's head and `main`'s head as its
   parents, and is authored and pushed as you. The box then says **Brought
   up to date with main**, and the checks and workflows run again on the
   new commit, as after any push.
2. **When both changed some of the same files**, a sandbox merges `main` in
   with git, and a [g1t agent](/guides/g1t-agents/) resolves any conflict.
   The box says what is happening (**g1t-agent is resolving conflicts with
   main** when the merge is known to conflict) with the run's live step and
   how long it has taken. It usually takes about a minute. When the result
   is pushed, the box shows the pull request up to date; if the run fails,
   or nothing has been pushed after five minutes, the box says so and
   offers **Try again**. Nothing is pushed by a run that fails.

Either way the merge is pushed only if the pull request's branch is still
where it was when the catch-up started. If someone pushed to it meanwhile,
the catch-up stops with nothing lost, and you can press it again.

The second case needs g1t agents enabled for the workspace and is
[charged](/guides/usage-and-billing/#what-is-charged) as agent work; the
first is not.

A [g1t agent's](/guides/g1t-agents/) pull request that is found to conflict
is sent back to resolve it by itself, before it is ready.

## From the API

`GET /repos/{owner}/{name}/pulls/{number}` returns, besides the pull request:

| Field | What it is |
| --- | --- |
| `checks` | The latest run of the acceptance checks: `status`, `head_commit`, `error`, and `results`, each with `command`, `passed`, `exit_code`, `output` and `duration_ms`. |
| `earlier_checks` | The runs before it, newest first, without their output. |
| `statuses` | What each workflow run said about its head. |
| `mergeable` | `clean`, `conflicting`, `checking` or `unknown`. |
| `conflicts` | When conflicting, the files that conflict. |
| `behind` | Whether its target has moved on without it. |

An agent sees the same through the `get_pull_request` tool.
