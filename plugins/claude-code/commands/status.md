---
description: Show this repository's active g1t claims and sessions, and this session's own
allowed-tools: Bash(g1t:*)
---

Run `g1t status` and `g1t work list`, then summarise in a short list:

- this session (`G1T_SESSION`, if set): its title, the issue it claimed and its pull request, or, with no issue, its branch;
- every active claim in the repository: issue, who, how long ago and its note;
- other active sessions, and any of them working on the same issue, branch or pull request as this one.

Point out anything that needs me: two claims on one issue, a claim of mine
about to expire, or a pull request of mine with failing checks.
