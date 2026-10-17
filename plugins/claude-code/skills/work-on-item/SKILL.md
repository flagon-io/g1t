---
name: work-on-item
description: Work on a g1t work item from start to merge. Use when asked to work on, fix, implement or pick up a work item (or an old issue) in a g1t workspace or repository (a number such as #42, or a g1t.sh work item link).
argument-hint: "[work item number]"
allowed-tools: Bash(g1t:*) Bash(git:*)
---

# Work on a g1t work item

The work item is the work: its description says what is wanted, its
"Definition of done" and each repository's required checks say when it is
done, its target repositories say where it has to land, `blocked_by` lists
what must land first, and its pull requests are the attempts. A work item
belongs to the workspace, not to one repository, and its number is unique
in the workspace. Other agents and people may be working on it at the same
time; claims and events are how you stay out of each other's way. Every
`g1t` command takes `--json` when you need fields rather than text.

Work item: $ARGUMENTS (if empty, ask which work item, or list open ones with `g1t work list`).

If the work you were asked for has no work item yet and has become a
change others should know about, look for one first (`g1t work list`). If
there is none, `g1t work claim --title "…"` (with `--body "…"` for the
details) opens it in this repository's workspace and claims it for this
session in one step, attaching the session to it: start at step 4 with
its number. Questions, exploration and trivial fixes need no work item;
the session is already recorded on g1t.

1. **Load the context.** Run `g1t work view N`. It shows the work item and
   its definition of done, the repositories it is linked to (its origin,
   its targets and the ones already touched) and which of them have
   landed, who has claimed it, the sessions and pull requests already on
   it with their checks and overlaps, what blocks it, what it blocks, the
   decisions recorded so far and the last integration failure. Read all
   of it before you change anything.
2. **Check it is free to start, and who else is on it.**
   - Its sessions include subagents: if you are one of several agents on
     this work item (siblings started by the same session, or other
     people's), run `g1t session list --item N --subagents` and read what
     each is doing and has touched (`g1t session view ID`). Take a part
     nobody has, and say which in your claim's note. Before editing a
     shared file, `g1t session list --path FILE` says who else touched it.
   - If it is blocked by work items that are still open, say so and stop
     unless you are asked to go on anyway.
   - Another claim does not block complementary work. Compare scopes and
     proceed on a separate part (another target repository is a natural
     one). If scopes or interfaces overlap, record an agreement about
     ownership or order before editing that part.
   - If a pull request for it is already open in this repository, prefer
     continuing that one (`g1t pr checkout NUMBER`) over starting another.
   - If it has no target in this repository yet and the work belongs here,
     link it: `g1t work link N --role target`.
3. **Claim it with a concrete scope.** Use a note containing `Scope:`
   (repositories, files, components), `Interfaces:` (contracts you
   change), `Depends on:` (work that must land first), and `Checks:` (how
   you will verify it):
   `g1t work claim N --note "Scope: ...; Interfaces: ...; Depends on: ...; Checks: ..."`. The
   claim belongs to this session (a subagent's to its own session) and is
   renewed while the session is active. Its answer lists the other claims
   on the work item, siblings' included: read them. If g1t later reports
   an overlap (`overlap.detected`) with another session, agree who changes
   the file before going on; `g1t work events --follow --item N` keeps
   you told.
   Without the CLI, g1t's MCP server does the same: `work_item` with action
   `work`, `claim` and `release`, and `session` with action `list`.
4. **Branch.** From an up-to-date default branch, make a branch whose name
   starts with the work item's number, such as `42-short-description`, so
   the session and the next one know which work item it is for.
5. **Open a draft pull request early**, as soon as there is a first commit:
   `g1t pr create --item N --draft --fill`. Others then see your changes,
   and g1t tells you when they overlap with someone else's.
6. **Do the work.** Commit in small steps and push often, with the
   trailer `G1t-Session: $G1T_SESSION` on each commit
   (`git commit --trailer "G1t-Session: $G1T_SESSION"`) so g1t ties the
   commits to this session. Run the same
   tests and linters the repository's workflows run before each push. Log
   a decision worth keeping with `g1t session log --kind note "TEXT"`.
7. **Watch the checks.** `g1t pr checks --watch --fail-fast`. When one
   fails, `g1t run logs --failed` says why; fix it and push again.
8. **Finish.** When this repository's part is done and the checks pass,
   `g1t pr ready --summary "what changed and why"` (add a screenshot with
   `--attach shot.png`, or upload one with `g1t attach FILE` and paste the
   Markdown it prints; never commit an image just to link it), then
   `g1t pr merge` when you are allowed to merge. With the merge queue on, merging adds the
   pull request to the queue; if the queue reports an integration failure,
   use the `fix-integration` skill. The merge marks this repository as
   landed on the work item, and the work item closes once every target
   repository has landed (or at once, when it has no targets). A pull
   request that does only part of this repository's share says
   `Part of #N` in its description instead, and lands nothing. Where you
   commit straight to the default branch instead, the commit that finishes
   this repository's part says `Closes #N` in its message (`Fixes` and
   `Resolves` work too); a bare `(#N)` only links the work item, and it
   stays open.
9. **Let go.** If you stop before it is done, hand it off rather than
   leaving a claim to expire: `g1t work handoff N --note "where it stands,
   what is left, what to watch out for"`. Name any target repository it
   has not landed in yet.
