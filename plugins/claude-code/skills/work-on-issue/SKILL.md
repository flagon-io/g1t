---
name: work-on-issue
description: Work on a g1t issue from start to merge. Use when asked to work on, fix, implement or pick up an issue in a g1t repository (an issue number such as #42, or a g1t.sh issue link).
argument-hint: "[issue number]"
allowed-tools: Bash(g1t:*) Bash(git:*)
---

# Work on a g1t issue

The issue is the work: its description says what is wanted, its
"Definition of done" and the repository's required checks say when it is
done, `blocked_by` lists what must land first, and its pull requests are
the attempts. Other agents and people may be working in the same
repository; claims and events are how you stay out of each other's way.
Every `g1t` command takes `--json` when you need fields rather than text.

Issue: $ARGUMENTS (if empty, ask which issue, or list open ones with `g1t issue list`).

1. **Load the context.** Run `g1t work context N`. It shows the issue and
   its definition of done, who has claimed it, the sessions and pull
   requests already on it with their checks and overlaps, what blocks it,
   what it blocks, the decisions recorded so far and the last integration
   failure. Read all of it before you change anything.
2. **Check it is free to start.**
   - If it is blocked by issues that are still open, say so and stop
     unless you are asked to go on anyway.
   - If someone else holds an active claim, tell the person who asked you,
     and go on only if they say to. Two claims are allowed; they are a
     warning, not a lock.
   - If a pull request for it is already open, prefer continuing that one
     (`g1t pr checkout NUMBER`) over starting another.
3. **Claim it.** `g1t work claim N --note "what you are about to do"`. The
   claim belongs to this session and is renewed while the session is
   active.
4. **Branch.** From an up-to-date default branch, make a branch whose name
   starts with the issue number, such as `42-short-description`, so the
   session and the next one know which issue it is for.
5. **Open a draft pull request early**, as soon as there is a first commit:
   `g1t pr create --issue N --draft --fill`. Others then see your changes,
   and g1t tells you when they overlap with someone else's.
6. **Do the work.** Commit in small steps and push often. Run the same
   tests and linters the repository's workflows run before each push. Log
   a decision worth keeping with `g1t session log --kind note "TEXT"`.
7. **Watch the checks.** `g1t pr checks --watch --fail-fast`. When one
   fails, `g1t run logs --failed` says why; fix it and push again.
8. **Finish.** When the definition of done is met and the checks pass,
   `g1t pr ready --summary "what changed and why"`, then `g1t pr merge`
   when you are allowed to merge. With the merge queue on, merging adds the
   pull request to the queue; if the queue reports an integration failure,
   use the `fix-integration` skill.
9. **Let go.** If you stop before it is done, hand it off rather than
   leaving a claim to expire: `g1t work handoff N --note "where it stands,
   what is left, what to watch out for"`.
