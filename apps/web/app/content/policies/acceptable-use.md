g1t gives people and agents real computers, real network access and a place to publish. That only works if it isn't abused. This policy is part of the [Terms of Service](/policies/terms), and applies to everything on g1t: accounts, workspaces, repositories, issues and pull requests, agents and the instructions you give them, sandboxes, checks, workflows, and apps deployed to g1t.page.

**You're responsible for what your agents do**, the same as for what you do yourself. "The agent did it" doesn't make something allowed.

## Not allowed

### Cryptocurrency mining

No mining, on any plan, for any coin, in any sandbox, check, workflow, build or deployed app. That includes mining "just to test", proxies to mining pools, and anything whose purpose is to turn g1t's compute into cryptocurrency. g1t stops sandboxes that look like miners automatically, refuses commands that name known miners and pools, and reviews what ran.

### Abusing g1t itself

- Using g1t's compute, storage, bandwidth or free allowances for something other than building and running software: file hosting unrelated to a project, content delivery for other sites, scraping at scale, or as a general-purpose proxy.
- Getting around limits, caps, trials, pools, payment, or a suspension: for example, with multiple accounts or workspaces, cards that aren't yours, or by hiding what a job does.
- Interfering with g1t or other customers: overloading it, probing other workspaces, or trying to escape a sandbox, read another workspace's data, or get around guardrails, authentication or the audit log. (If you find a way, please tell us: see [responsible disclosure](/security#responsible-disclosure).)
- Automated access to g1t.sh that is heavier than an ordinary person or agent would make, other than through the API and MCP server within their limits.

### Attacking or harming others

- Malware, ransomware, phishing kits, credential stealers or anything meant to compromise systems you don't own, or a deployed app that serves them. Security research, exploit proof-of-concepts and tools for defense are welcome in repositories when they're clearly that, and not aimed at live systems without permission.
- Using sandboxes or deployed apps to attack, scan, spam or overwhelm other systems.
- Phishing, impersonating people or organizations, or deceiving people about who you are.
- Harassment, threats, doxxing (publishing someone's private information), or inciting violence.
- Sending spam, including through issues, comments, mentions or webhooks.

### Illegal or infringing content

- Anything illegal where you or g1t operate, or that facilitates illegal activity.
- Child sexual abuse material. We report it to the authorities and close the accounts involved immediately.
- Content that infringes someone else's copyright, trademark, privacy or other rights, including secrets and personal information that isn't yours to publish.
- Content that promotes terrorism or violent extremism.

## What happens when something breaks this policy

Depending on how serious it is and whether it was deliberate, we may:

- stop a sandbox, check, workflow or deployment (some of this happens automatically);
- remove or hide content;
- pause compute for a workspace, or take away a trial or credits;
- suspend or close accounts and workspaces;
- report it to the authorities, when the law requires or the harm is serious.

We'll tell you what we did and why, unless the law stops us or telling you would help someone abuse g1t. Honest mistakes happen: a build that looked like a miner, a script that ran too hard. If you think we got it wrong, write to [hey@flagon.io](mailto:hey@flagon.io) and a person will look at it.

## Reporting abuse

To report something on g1t that breaks this policy, write to [hey@flagon.io](mailto:hey@flagon.io) with links to what you found and why it's a problem. For security vulnerabilities in g1t itself, use [hey@flagon.io](mailto:hey@flagon.io) instead.
