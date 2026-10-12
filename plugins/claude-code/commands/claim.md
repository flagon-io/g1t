---
description: Claim a g1t issue for this session and load its work context
argument-hint: "<issue number> [note]"
allowed-tools: Bash(g1t:*)
---

Claim g1t issue $1 for this session.

1. Run `g1t work context $1` and read it: the definition of done, who else
   has claimed it, its pull requests and what blocks it.
2. Run `g1t work claim $1`, adding `--note "..."` with the rest of these
   arguments if there are any: $ARGUMENTS
3. Tell me in a few lines what the issue asks for, whether anyone else holds
   a claim on it (the claim command lists them), and anything that blocks
   it. If someone else is on it, ask me before starting work.
