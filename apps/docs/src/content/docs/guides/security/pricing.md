---
title: What's free and what's paid
description: Which security features are free everywhere, which are free on public repositories, and Security and quality, which comes with the g1t plan for private ones.
---

Keeping secrets out of repositories and vulnerable dependencies out of
production is free, everywhere. The rest of the security suite is free on
public repositories and comes with the g1t plan, as **Security and
quality**, on private ones.

| Feature | Public repositories | Private repositories |
| --- | --- | --- |
| Secret scanning and push protection | Free | Free |
| Bypassing push protection with a reason | Free | Free |
| Vulnerability alerts | Free | Free |
| Security updates | Free | Free |
| Dependency graph and SBOM | Free | Free |
| Custom patterns | Free | With the plan |
| Validity checks | Free | With the plan |
| Delegated bypass | Free | With the plan |
| Code scanning | Free | With the plan |
| Dependency review | Free | With the plan |
| Security overview | Free | With the plan |
| Fix with g1t | Agent usage | Agent usage |

## Security and quality

Security and quality has no price of its own. It is on for every private
repository of a workspace on the [g1t plan](/guides/usage-and-billing/#the-g1t-plan),
and what it runs is charged like everything else g1t runs: security scans
at what they cost g1t plus 20%, from the plan's included usage first. There
is nothing to turn on.

A Security and quality subscription a workspace has at Stripe is ended by g1t,
without a charge for the next month. Workspaces whose billing g1t covers,
and an enterprise's workspaces, have it included.

Without the plan, a private repository's paid features say what they need
and who can start the plan; nothing is started without an owner choosing
it.

## Fixes are agent usage

**Fix with g1t** puts g1t's agent on an issue. Its run is charged as any
agent's: the model at the provider's price with the agent rate, and sandbox
time at cost plus 20%, from the plan's included usage first. See [Usage and billing](/guides/usage-and-billing/).

Scanning itself (history scans and dependency reads) is metered as before,
and covered by g1t on free workspaces.
