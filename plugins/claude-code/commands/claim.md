---
description: Claim a g1t work item for this session and load its work context, or open one for the work in hand and claim it
argument-hint: "<work item number> [note] | <title of a new work item>"
allowed-tools: Bash(g1t:*)
---

Claim a g1t work item for this session: $ARGUMENTS

If the first argument is a work item number:

1. Run `g1t work view $1` and read it: the definition of done, the
   repositories it is linked to and which have landed, who else has
   claimed it, its pull requests and what blocks it.
2. Run `g1t work claim $1`, adding `--note "..."` with the rest of the
   arguments if there are any.
3. Tell me in a few lines what the work item asks for, which repositories
   it still needs to land in, whether anyone else holds a claim on it (the
   claim command lists them), and anything that blocks it. If someone else
   is on it, ask me before starting work.

If there is no number (or no arguments), this is the work in hand, which
has no work item yet:

1. Look for a work item that already covers it: `g1t work list`. If one
   does, claim that one as above.
2. Otherwise run `g1t work claim --title "TITLE"`, with the arguments as the
   title (or, with none, a short title for what this session is doing), and
   `--body "..."` saying what the change is. It opens the work item in this
   repository's workspace, with this repository as its origin, claims it
   for this session and attaches the session to it.
3. Tell me the work item's number and title.
