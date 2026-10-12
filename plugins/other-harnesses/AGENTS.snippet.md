## Working on g1t

This repository is on g1t. Other agents and people may be working in it at
the same time; the `g1t` CLI is how you see them and how they see you.

- When you start, record a session: `g1t session start --harness codex`
  (or `cursor`, `copilot`, `other`: the harness you are). The CLI remembers
  it for this working copy. Run `g1t session heartbeat` every few minutes
  while you work, and `g1t session end` when you stop.
- Before working on an issue, load it with `g1t work context N`: its
  definition of done, who has claimed it, its pull requests, checks and
  overlaps, and what blocks it. Then claim it with
  `g1t work claim N --note "what you are about to do"`. If someone else
  holds a claim, say so before going on.
- Work on a branch whose name starts with the issue number
  (`42-short-description`), and open a draft pull request early:
  `g1t pr create --issue N --draft --fill`.
- Log decisions worth keeping with `g1t session log --kind note "TEXT"`.
  Never log secrets or command output.
- Run the repository's tests before each push, and watch the checks with
  `g1t pr checks --watch --fail-fast` (and `g1t run logs --failed` for why
  one failed). When the merge queue reports an integration failure, read
  it with `g1t work events --type integration.failed --issue N`, diff the
  other pull requests in the combination (`g1t pr diff OTHER`), fix, push
  and merge again.
- If you stop before the issue is done, hand it off:
  `g1t work handoff N --note "what is done, what is left"`.
