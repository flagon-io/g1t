---
name: coordinate
description: Stay coordinated with other agents and people while working on a g1t issue. Use for longer work on an issue, when several agents work in one repository, or when asked to watch for overlapping changes, dependencies or merge-queue results.
argument-hint: "[issue number]"
allowed-tools: Bash(g1t:*) Bash(git:*)
---

# Coordinate on a g1t issue

g1t tells everyone working in a repository what changes around them, as
events. Follow the ones about your issue while you work, and act on them
as they come rather than finding out at merge time.

Issue: $ARGUMENTS (if empty, use the issue this session claimed).

No issue yet? The session is already recorded on g1t and shows to the
team with what it is for, so there is nothing to coordinate until the
work becomes a change others should know about (a branch to push, a pull
request). Then look for its issue first (`g1t work list`,
`g1t issue list`) and claim it with `g1t work claim N`; if there is none,
open and claim one in one step with `g1t work claim --title "…"`, which
attaches this session to it. Never open issues for questions,
exploration or trivial fixes.

1. **Follow its events in the background.** Start
   `g1t work events --follow --issue N` as a background command, and read
   its output between steps. Each line is one event. Add `--json` for one
   JSON object per line.
2. **React to what arrives:**

   | Event | What to do |
   | --- | --- |
   | `work.claimed` by someone else | Tell the person who asked you. Agree who goes on; hand off if it is not you. |
   | `work.handoff_requested` to you | `g1t work context N`, read the note, then claim it. |
   | `overlap.detected` | Another open pull request changes the same files. `g1t pr diff OTHER`, then narrow your change or agree an order on the pull requests. |
   | `dependency.changed` | Something this issue waits on changed. If `cleared`, the blockers are gone: pull the default branch and go on. If one was added, stop and say so. |
   | `integration.failed` naming your pull request | Use the `fix-integration` skill. |
   | `integration.passed` | Nothing to do; the change is landing. |
   | `session.ended`, `work.claim_expired` | A collaborator stopped. If their work blocks yours, look at what they left with `g1t work context N`. |

3. **Keep your own state true.** The session's heartbeat renews your
   claim while you work. If you change course, log why with
   `g1t session log --kind note "TEXT"`.
4. **Hand off cleanly.** When you stop before the issue is done:
   `g1t work handoff N --note "what is done, what is left, what to watch out for"`
   (add `--to LOGIN` for someone in particular). When it is done, the
   claim ends with the merge; `g1t work release N` lets go of it earlier.
5. **Stop following** when you hand off or the pull request merges: stop
   the background command.

`g1t work list` shows every active claim and session in the repository,
for when you need the whole picture.
