---
title: What's free and what's paid
description: Which security features are free everywhere, which are free on public repositories, and the Security and quality activation for private ones.
---

Keeping secrets out of repositories and vulnerable dependencies out of
production is free, everywhere. The rest of the security suite is free on
public repositories and part of the **Security and quality** activation on
private ones.

| Feature | Public repositories | Private repositories |
| --- | --- | --- |
| Secret scanning and push protection | Free | Free |
| Bypassing push protection with a reason | Free | Free |
| Vulnerability alerts | Free | Free |
| Security updates | Free | Free |
| Dependency graph and SBOM | Free | Free |
| Custom patterns | Free | Activation |
| Validity checks | Free | Activation |
| Delegated bypass | Free | Activation |
| Code scanning | Free | Activation |
| Dependency review | Free | Activation |
| Security overview | Free | Activation |
| Fix with g1t | Agent usage | Agent usage |

## The Security and quality activation

The activation is a monthly price per workspace, never per person, in the
workspace's own Stripe subscription: $10 a month today. Its price is in
g1t's price book, on [g1t.sh/pricing](https://g1t.sh/pricing), with
the plan's; any change to it is announced there first. It does not need the
plan, and the plan does not include it.

An owner turns it on:

1. Open the workspace's **Billing** page, `g1t.sh/<owner>/-/billing`.
2. Under **Security and quality**, choose **Turn on Security and quality**.
3. Pay on Stripe's page, or at once with the card already checked.

**Turn off at the period's end** ends it when the month paid for ends:
nothing more is charged, and the paid features stop on private repositories
then. Alerts already found stay. Workspaces whose billing g1t covers, and
an enterprise's workspaces, have it included.

Without it, a private repository's paid features say what they need and
who can turn it on; nothing is turned on without an owner choosing it.

## Fixes are agent usage

**Fix with g1t** puts g1t's agent on an issue. Its run is charged as any
agent's: sandbox time and model tokens at cost plus 20%, from the plan's
included usage first. See [Usage and billing](/guides/usage-and-billing/).

Scanning itself (history scans and dependency reads) is metered as before,
and covered by g1t on free workspaces.
