This policy explains what information g1t collects, why, where it goes, how long we keep it, and what you can do about it. It covers g1t.sh, api.g1t.sh, mcp.g1t.sh, docs.g1t.sh, g1t.page and the agents and sandboxes g1t runs. g1t is run by Flagon, Inc. ("Flagon", "we"), which is responsible for your information.

The short version: we collect what we need to run a git platform for you and your agents, we don't sell it, we don't advertise, we don't use your private content to train AI models, and the only analytics on g1t.sh counts how pages are used without reading what is in your workspaces.

## What we collect

### Your account

| What | Why |
| --- | --- |
| Username and email address | To identify you, sign you in, and reach you about your account. Your username is public; your email address is not. |
| Password | To sign you in. We store only a salted hash of it (PBKDF2-SHA256), never the password itself. |
| Profile: name, bio, location, website, pronouns and time zone, if you add them | Shown on your public profile, and your local time on the card over your name. All optional. |
| Avatar, if you upload one | Shown next to your name. Stored by its content's hash and served publicly at `g1t.sh/avatars/…`. |
| Sessions, access tokens, SSH keys, and apps you've approved through sign-in with g1t | To keep you signed in and let your tools act for you. Session and token secrets are stored only as hashes. |
| Whether your email address is confirmed | Unconfirmed accounts can't create repositories or push. |

### Your workspaces and content

- **Workspaces**: name, address, description and icon; members and their roles; settings, guardrails, integrations and webhooks.
- **Repositories**: everything you push, with its history, and what it holds, including any personal information in commit authors and files.
- **Issues, pull requests, reviews, comments, plans and labels**, with who wrote them and when.
- **Secrets and variables, integration credentials and webhook signing secrets.** Secrets are encrypted at rest (AES-256-GCM) and never shown again after you save them.
- **Memory and the context hub**: what agents and members record for the workspace to remember.
- **Deployments**: the apps you deploy, their builds and logs, and a screenshot of each production site for your project's overview.

### What agents do

When an agent runs, we keep a **session**: what it was asked, the steps it took, the tools it called, what it wrote, which model it used, what it cost, and how the run ended. Run credentials and model keys are removed from what is recorded. A session is as visible as its project: **on a public project, anyone can read it**. Workflow and check logs are kept the same way.

To catch cryptocurrency mining, every sandbox samples its own CPU use, disk and network activity, and the command lines of the processes it runs. These measurements are used only for abuse detection.

### The audit log

Every action through the API, the MCP server and git is recorded in your workspace's audit log: who did it (a person, or an agent on a person's behalf), what they did, to what, through which surface, whether it was allowed, and under which rule. The audit log does not store IP addresses. It is kept for **90 days**, then deleted. Members can read and export it.

### Billing

Payments are handled by Stripe. **Card numbers never reach g1t.** From Stripe we keep the workspace's customer reference, the card's brand, last four digits and expiry date, whether it is a prepaid card, and a fingerprint of the card that Stripe gives us, so that each card gets only one trial. Your billing email, address and tax ID are held by Stripe. We keep the workspace's statement: usage, charges, credits, payments and invoices.

### How the site is used

On g1t.sh, our analytics provider HeyCatch records page views, clicks and the page each happened on, with your browser and device type, your IP address (which it uses to estimate your country and city) and the site that sent you. We use it to learn which pages help people and where they get stuck.

- **On the public pages** (the home page, pricing, Explore, signing up and signing in, support, security and these policies) it receives the page's address and the text of what you click.
- **Everywhere else** your browser removes names before anything is sent: an address such as `g1t.sh/acme/web/pull/12` is sent as `/:name/:name/pull/:n`, and page titles and the text, links and attributes of what you click are left out. Nothing from your repositories, issues, pull requests or chat is sent.
- **If you're signed in**, it receives your account's internal id, so your visits count as one person. Not your username, email address or name.
- **Never**: recordings of your screen or session, what you type, or error reports.
- **Query strings** are removed, except campaign tags (`utm_…`).

If your browser sends Do Not Track, nothing is recorded. A g1t you run yourself sends nothing to HeyCatch.

### When you write to us

If you email support, security, privacy or billing, we keep the conversation, so we can help you and remember what we said.

### Technical information

Our hosting provider, Cloudflare, sees every request to g1t, including your IP address, browser and the address you visited, to deliver it and to protect g1t from attacks. Our servers keep request logs for debugging and security in Cloudflare Workers Logs, which deletes them after 7 days.

## Cookies and browser storage

g1t uses the cookies it needs to work, and one analytics cookie. There are **no advertising or cross-site tracking cookies**.

| Cookie | What it's for | How long |
| --- | --- | --- |
| `g1t_session` | Keeps you signed in. HttpOnly and Secure; set only when you sign in. | 30 days, or until you sign out |
| `g1t_ws` | Remembers which workspace you last chose, so the sidebar opens on it. | 1 year |
| `g1t_seen` | Remembers when you last looked at mission control, so it can show what's new since. | 1 year |
| `g1t_tz` | Your browser's time zone, so mission control's greeting and days fit your day. | 1 year |
| `ph_…_posthog` | Set by HeyCatch's analytics on g1t.sh: a random id for your browser, so its visits count as one visitor ([above](#how-the-site-is-used)). | 1 year |

Cloudflare may set its own security cookies (such as `__cf_bm`) to tell people from bots when g1t is under attack.

The site also keeps a few preferences in your browser's local storage, which never leave your device: which coding agent you set up with, how you like diffs shown, and checklist items you've dismissed. HeyCatch keeps a copy of its analytics id there too, which is sent with each analytics event.

**Fonts.** g1t.sh and docs.g1t.sh serve their typefaces themselves, so loading a page asks no one else for them.

## How we use it

We use your information to:

- run g1t: sign you in, store and show your content to the people allowed to see it, run the agents, checks and deployments you ask for;
- keep g1t secure and fair: detect abuse, mining and fraud, enforce limits, and investigate problems;
- bill workspaces and keep the records the law requires;
- send you the email g1t needs to: confirming your address, resetting your password, billing alerts and receipts, answers to requests you made, and important changes to g1t or these policies. **We don't send marketing email**;
- answer you when you write to us;
- improve g1t, using our own records of how it is used and the site analytics [above](#how-the-site-is-used). We don't use your private content to train AI models.

If you're in the European Economic Area or the United Kingdom, our legal bases are: **performing our contract with you** (running the service you signed up for), **our legitimate interests** (keeping g1t secure, preventing abuse, and improving it, balanced against your rights), and **legal obligations** (such as keeping tax records).

**We don't sell your personal information, and we don't share it for advertising.**

## Who we share it with

We share information only to run g1t, at your direction, or when the law requires it.

- **Service providers ("subprocessors")** that run parts of g1t for us, under contracts that limit them to doing so: Cloudflare (hosting, storage, databases, sandboxes, email, search and the AI gateway), Stripe (payments), Anthropic (the model behind hosted agents) and HeyCatch (site analytics). The [subprocessors](/policies/subprocessors) page lists them and what each receives.
- **Services you connect.** When you connect your own model provider, an issue tracker, error tracking or a webhook, or let your sandboxes reach a host, we send them what that connection needs, because you asked us to.
- **Other people on g1t**, as your settings allow: your workspace's members, and everyone for public projects and your public profile.
- **Vulnerability databases.** To find vulnerable dependencies, we send the names and versions of packages in your lockfiles to OSV.dev, an open database run by Google. Nothing else about you or your repository is sent.
- **The law.** We disclose information when we must by law, such as a valid court order, and when we need to protect the rights, property or safety of our users, the public or Flagon. Where we can, we tell you first.
- **A change of ownership.** If Flagon or g1t is acquired or merged, your information would go to the new owner under this policy, and we'll tell you first.

## How long we keep it

| What | How long |
| --- | --- |
| Your account, profile and content | While your account or workspace exists. Deleted within 30 days of deleting it. |
| Agent sessions and logs | As long as their project, unless you delete them. |
| The audit log | 90 days. |
| Billing records | As long as tax and accounting law requires. |
| Email to us | As long as we need it to help you, then deleted. |
| Request logs | 7 days. |
| Database history | g1t's databases keep 30 days of point-in-time history (Cloudflare D1 Time Travel), so deleted data leaves it within 30 days. |

Some content can stay after you leave because it is part of someone else's work: forks others made of your public repositories, and comments and reviews you left in other people's projects. Ask us, and we'll remove your name from what stays where we can.

## Your choices and rights

Wherever you live, you can:

- **See and correct** your information: most of it is in your settings, your workspaces and your projects.
- **Take it with you**: clone your repositories with git, use the API for everything else, and export the audit log and statements as CSV or JSON. Ask us and we'll send you a copy of your account's personal information.
- **Delete it**: delete content in the app, or write to us to delete your account or workspace.
- **Object or restrict**: ask us to stop a particular use of your information.

If you're in the EEA, the UK or another place with similar laws (such as under the GDPR), you also have the right to object to processing based on legitimate interests, and to complain to your data protection authority. If you're a California resident, you have the right to know what we collect, to delete it, to correct it, and not to be treated differently for using these rights. We don't sell or share personal information as California law defines those words.

To use any of these rights, write to [hey@flagon.io](mailto:hey@flagon.io) from the email address on your account. We'll answer within 30 days. We may need to confirm it's you before we act.

## Where your information is

g1t runs on Cloudflare's global network, so your information may be processed in the United States and other countries where Cloudflare operates, which may have different data protection laws from yours. Flagon is based in the United States. Where the law requires it, we rely on the European Commission's Standard Contractual Clauses (and their UK equivalent) with our providers for these transfers.

## Security

We protect your information with encryption in transit, encryption of secrets at rest, short-lived credentials for agents, an audit log, and isolated sandboxes. Our [security](/security) page describes what we do, and how to report a problem.

## Children

g1t isn't meant for children under 13, and we don't knowingly collect information from them. If you believe a child under 13 has an account, write to [hey@flagon.io](mailto:hey@flagon.io) and we'll delete it.

## Changes to this policy

When we change this policy, we'll update the date on the [policies](/policies) page and list the change in its history. **We'll tell you before material changes take effect**, by email to account holders, at least 30 days ahead.

## Contact

Questions about privacy, or a request about your information: [hey@flagon.io](mailto:hey@flagon.io).

Flagon, Inc.
