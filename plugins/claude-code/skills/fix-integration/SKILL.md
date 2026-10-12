---
name: fix-integration
description: Fix a g1t pull request that failed when the merge queue tested it together with other pull requests (an integration.failed event). Use when g1t reports an integration failure, or a queued pull request was removed from the merge queue because a combined check failed.
argument-hint: "[pull request number]"
allowed-tools: Bash(g1t:*) Bash(git:*)
---

# Fix an integration failure

The merge queue tests pull requests together, in queue order. A pull
request can pass on its own and still fail once another one is merged
with it. g1t then records an `integration.failed` event naming the pull
request it holds responsible, the combination it tested (the pull requests
merged together, in order), the failing check and its link, whether it
bisected the combination to find the culprit, and the suspects when it
could not tell. When nothing was ahead of it, the default branch itself
moved: `landed` lists the pull requests merged into it since your branch
left it, newest first, and one alone is the likely cause.

Pull request: $ARGUMENTS (if empty, use the current branch's pull request).

1. **Read what failed.** `g1t work events --type integration.failed --json`
   for the event (narrow it with `--issue N`), and `g1t work context N` for
   the issue, which shows the last integration failure, the pull requests
   on it and the decisions so far.
2. **Open the failing check's log** from the event's check link, or with
   `g1t run logs --failed` on that run. Find the first real error.
3. **Read the other pull requests in the combination**, or in `landed`
   when the combination is yours alone.
   `g1t pr diff OTHER` for each one, and look for what
   meets your change: the same function changed two ways, a renamed or
   removed name you still use, a migration, a fixture or a test that
   assumes the old behaviour.
4. **Reproduce it locally.** Merge the default branch and the other pull
   requests' branches into a scratch branch in the same order, and run the
   failing check's command. For a `landed` failure, merging the default
   branch as it is now into yours is enough.
5. **Fix it on your branch.** Change only what the failure needs. If the
   right fix belongs in the other pull request, say so on it
   (`g1t pr comment OTHER`) instead of working around it, and tell the
   person who asked you.
6. **Push, then queue again.** Push the fix, wait for `g1t pr checks
   --watch` to pass, and merge again with `g1t pr merge`, which puts it
   back in the queue.
7. **Leave a record.** `g1t session log --kind note "Integration failure
   with #OTHER: CAUSE. Fixed by CHANGE."` so the next person can see why
   the change looks the way it does.

If the event says the failure was not bisected and lists several
suspects, check that yours really is one before changing anything: run the
check on your branch with only the default branch merged in.
