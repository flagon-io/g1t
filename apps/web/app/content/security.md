## Accounts and sign-in

- **Passwords** are stored only as salted hashes (PBKDF2-SHA256, 100,000 iterations). Nobody at g1t can see yours.
- **Sessions** are random 256-bit tokens, kept in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie and stored on our side only as a hash, so a copy of our database can't be used to sign in. They last 30 days, and signing out ends them on the server, not just in your browser.
- **Forms can't be posted from other sites.** Every change the website makes checks that the request came from g1t.sh.
- **Your tools never see your password.** The CLI, coding agents and MCP clients sign in through your browser, with device sign-in or OAuth with PKCE, and get a token you can revoke from your settings. Access tokens are stored only as hashes.
- **New accounts confirm their email address** before they can create repositories or push.

## Jobs act with credentials of their own

Every workflow job, check and build gets **a token made for that job alone**, revoked the moment it ends. It's not your access token:

- It reaches **its own repository only**, and does only what the job's `permissions:` allow.
- What it changes is recorded in the audit log as that job's, and starts no workflows of its own.
- A pull request from a fork, or from someone without write access, runs without secrets and with a token that can only read.

Coding agents you connect use your own access tokens or an OAuth sign-in, limited to the scopes and repositories you chose, and you can revoke them from your settings at any time.

## Every action is recorded

The **audit log** records every action through the API, the MCP server and git, by people and by the agents and jobs acting for them: who did it, on whose behalf, what, to what, and whether it was allowed or refused, with the rule that decided. It's kept for 90 days on every plan, free or paid, and can be exported as CSV or JSON. Security is never a paid extra on g1t.

## Guardrails on what runs

Each workspace decides how long its checks, merge queue and merge checks may run in g1t's sandboxes, and each project can tighten it. A run that passes its time cap is stopped by stopping the sandbox itself, and **branch protection** is enforced by g1t when a push arrives, whatever happened in the sandbox. The [guardrails guide](https://docs.g1t.sh/guides/guardrails/) explains each one.

## Isolated sandboxes

Checks, workflows and builds each run in **a container of their own** on Cloudflare Containers, with one checkout and its job's token, and nothing from any other run or workspace. Each is stopped when its work ends, and when its time cap passes, whatever is running in it.

## Secrets stay secret

- **Push protection.** A push that adds a recognisable secret (cloud keys, tokens, private keys and more) is refused before anything is stored, and git says which file and line. That includes pushes made by agents.
- **Secret scanning.** Each repository's history is scanned too. We keep a fingerprint and a short preview of each finding, never the secret.
- **Dependency scanning.** Every package your lockfiles resolve is checked against the OSV database of known vulnerabilities. For each one that has a fix, g1t opens a pull request that raises it to the fixed version, and it lands through your branch's required checks.
- **Encryption at rest.** Workflow and deployment secrets, integration credentials and webhook signing secrets are encrypted with AES-256-GCM under a key held outside the database, bound to the record they belong to. They're never shown again after you save them.
- **Signed webhooks.** Every webhook delivery is signed, so your server can check it came from g1t.

## Built on Cloudflare

g1t runs on Cloudflare's network: Workers for the site, API and services, D1 for databases, Artifacts for git storage, Containers for sandboxes. Everything is served over HTTPS. The services behind the site talk to each other over Cloudflare service bindings, not the public internet, and only the site, the API, the MCP server, link previews (og.g1t.sh), the documentation, the status page and g1t.page are reachable from outside. Uploaded images are served with a policy that lets nothing in them run.

Staff access to accounts and billing goes through an internal tool behind Cloudflare Access. Every change made there is recorded with who made it and why.

g1t is open source, so you can read exactly how all of this works at [g1t.sh/flagon-io/g1t](/flagon-io/g1t).

## Abuse controls

Free compute attracts people who would mine cryptocurrency with it, and stolen cards. g1t guards against both without making honest use harder:

- **No card, no compute.** Sandboxes need a card check or the plan. The check is never charged; each card gets one trial, wherever it's used; prepaid cards start no trial.
- **Mining detection.** Commands that name known miners, pools or their flags are refused, and a sandbox that stays at full CPU for ten minutes without the disk, network and process activity of real builds is stopped, and a person looks at what ran.
- **Spend limits and spike pauses.** Every workspace has a spend limit and a ceiling on unpaid usage, and if spending suddenly jumps, new compute pauses until an owner says to keep going.

## Not built yet

We'd rather tell you than have you assume. **Single sign-on is not available yet.** Until it is, turn on [two-factor authentication](/settings/two-factor), and review your access tokens and authorized apps in your settings from time to time.

## Responsible disclosure

If you've found a security problem in g1t, please tell us at **[hey@flagon.io](mailto:hey@flagon.io)**. Our [security.txt](/.well-known/security.txt) says the same.

### What to send

What you found, where, how to reproduce it, and what an attacker could do with it. Screenshots, requests or a short proof of concept help. Please don't include other people's data.

### In scope

- g1t.sh, api.g1t.sh, mcp.g1t.sh, og.g1t.sh, docs.g1t.sh and status.g1t.sh;
- the g1t.page platform itself: routing, isolation between apps, custom domains;
- the sandboxes: escaping one, reaching another run or workspace, or getting around guardrails or a job's token;
- authentication, authorization, the API, the MCP server and git over HTTPS;
- the [open-source code](/flagon-io/g1t), as deployed.

### Out of scope

- Apps customers deploy to g1t.page, and the content of customers' repositories: report those to their owners, or to [hey@flagon.io](mailto:hey@flagon.io) if they're harmful.
- Denial of service, load testing, and spam.
- Social engineering of Flagon staff or customers, and physical attacks.
- Reports from automated scanners without a demonstrated impact, missing headers or best practices without a way to exploit them, and self-XSS.
- Vulnerabilities in Cloudflare, Stripe or other providers themselves: report those to them.

### The rules

- Test only against accounts and workspaces you own, or have the owner's permission to test.
- Don't access, change or delete other people's data beyond the minimum needed to show the problem, and stop and tell us as soon as you've reached any.
- Don't degrade g1t for others, and don't run cryptocurrency miners, even to test detection.
- Give us reasonable time to fix the problem before you share it: we ask for 90 days, or until a fix ships, whichever comes first. We'll agree a date with you.

### What we promise

- We'll **acknowledge your report within 2 business days**, give you our assessment **within 5 business days**, and keep you updated at least every 14 days until it's fixed.
- We'll aim to fix critical problems within 30 days.
- We'll credit you when we publish the fix, if you'd like.

### No bug bounty, yet

g1t doesn't pay bug bounties right now. We want to, and we will once g1t is making money to pay them from. Until then, we can offer the credit above and our thanks.

### Fixing it yourself

g1t is open source, so you can also send the fix. [Its source](/flagon-io/g1t) is on g1t, and changes land through pull requests like anyone else's: see [contributing](/flagon-io/g1t/blob/main/CONTRIBUTING.md).

For a vulnerability that isn't fixed yet, **write to us first**: a public pull request shows the problem to everyone before the fix is live. We'll agree with you when to open it. Hardening that doesn't point at an open hole, such as stricter headers, tighter checks or better tests, is welcome as a pull request straight away.

### Safe harbour

If you act in good faith and follow this policy, we consider your research authorized. We won't pursue legal action against you or report you to law enforcement for it, and if someone else brings a claim against you for research that followed this policy, we'll make it known that it was authorized. If you're unsure whether something is in scope or allowed, ask us first at [hey@flagon.io](mailto:hey@flagon.io).
