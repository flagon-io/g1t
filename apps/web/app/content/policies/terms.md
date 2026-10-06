These terms are the agreement between you and Flagon, Inc. ("Flagon", "we", "us") when you use g1t: the website at g1t.sh, its API at api.g1t.sh, its MCP server at mcp.g1t.sh, git over g1t.sh, the documentation, apps deployed to g1t.page, and the agents and sandboxes g1t runs for you (together, "g1t" or "the service").

We've tried to write them the way we'd want to read them: plainly. If anything here is unclear, write to [hey@flagon.io](mailto:hey@flagon.io) and we'll explain it.

By creating an account or using g1t, you agree to these terms, the [Acceptable Use Policy](/policies/acceptable-use), and the [Refunds and Cancellation](/policies/refunds) policy. The [Privacy Policy](/policies/privacy) explains what we do with your information. If you use g1t for a company or another organization, you're agreeing for it, and you're telling us you're allowed to.

The g1t software is open source under the MIT license. These terms cover the service we run at g1t.sh, not your use of the source code; the license covers that.

## 1. Your account

- **You need an account to do most things.** Give us a real email address and keep it current: it's how we reach you about your account, security and billing, and how you get back in if you lose your password.
- **You must be at least 13 years old**, and old enough where you live to agree to these terms yourself. If you're under 18, a parent or guardian must agree to them for you.
- **An account is for one person.** Automation is welcome: use access tokens, workspace tokens and agents for it. Don't share a password, and don't create accounts to get around a limit, a trial, or a suspension.
- **Keep your credentials safe.** You're responsible for what happens under your account, your tokens and your SSH keys. If you think someone else has them, revoke them in your settings and tell us at [hey@flagon.io](mailto:hey@flagon.io).

## 2. Workspaces

Everything on g1t lives in a workspace: its projects, repositories, issues, pull requests, agents, settings and bill. A workspace's **owners** control it. They decide who is a member, what members and agents may do, and they're responsible for paying for it. If you create a workspace for an organization, the organization is the customer, and its owners act for it.

## 3. Acceptable use

Use g1t lawfully and the way it's meant to be used. The [Acceptable Use Policy](/policies/acceptable-use) lists what isn't allowed. In short: no cryptocurrency mining, no abuse of g1t, other people or other systems, no malware, no illegal content, and no attempts to get around our limits, billing or security. We enforce it, including automatically (see section 11).

## 4. Your content stays yours

Your code, issues, pull requests, comments, files, settings, and anything else you or your agents put on g1t ("your content") belong to you or whoever you got them from. We don't claim ownership of any of it.

To run g1t, we need your permission to handle your content. You give Flagon a worldwide, non-exclusive, royalty-free license to host, store, copy, process, transmit and display your content **only as needed to provide, secure and improve the service for you**. That includes, for example:

- storing your repositories and showing them to the people you let see them;
- sending the relevant parts to a model provider when you ask an agent to work (see section 6);
- indexing it so you can search it;
- scanning it for secrets and vulnerable dependencies, so we can warn you;
- making backups.

This license ends when your content is deleted from g1t, except for copies in backups (which expire on their own schedule) and content others have a right to keep under section 5.

**We don't sell your content, and we don't use your private content to train AI models.** We don't let the model providers we use for hosted agents train on it either.

You're responsible for your content: that you have the right to put it on g1t, and that it doesn't break the law or someone else's rights.

## 5. Public repositories are public

When you make a project or repository public, **anyone can see it, including people without an account**. That includes its code and history, its issues and pull requests, comments, the recorded sessions of the agents that worked on it, and its deployed previews. Public content appears in g1t's search and Explore, in link previews, and can be read by search engines and by anyone's tools, including AI tools, that read the public web.

By making something public, you let every g1t user view it and fork it on g1t. Anything more (such as using your code in their own product) is governed by the license you choose for your repository. If you don't choose one, the law's defaults apply, which usually reserve your rights.

A fork someone else made of your public repository while it was public is theirs to keep, under your license, even if you later make yours private or delete it.

## 6. Agents act on your behalf

g1t's agents ("g1t agents") write code, review changes, answer questions, plan work and land changes, when you or another member of your workspace asks them to: by assigning an issue, mentioning an agent, starting a plan, or turning on something that runs on its own, such as upkeep or automatic merges.

- **An agent acts on behalf of the person who started its work**, within the limits of that person's access and the workspace's guardrails. Its actions are recorded as such in the audit log.
- **You're responsible for what you ask agents to do**, and for checking what they produce before you rely on it, merge it or deploy it, as you would for a teammate's work. Agents make mistakes. Their output can be wrong, insecure, or similar to code that exists elsewhere, and you're responsible for making sure your use of it complies with the licenses and laws that apply.
- **Guardrails** (network limits, command rules and caps) reduce risk. They're a safety net, not a guarantee that an agent won't do something you didn't intend.
- **What agents produce for you is your content.** As between you and us, Flagon claims no rights in it.
- **Agents cost money.** Runs, sandbox time and model use are charged to the workspace that owns the repository, as described on [pricing](/pricing).

To run hosted agents, we send the relevant content (such as the issue, the code it needs and the conversation so far) to a model provider. The [subprocessors](/policies/subprocessors) page lists who. If your workspace connects its own model provider, your content goes to that provider instead, under your agreement with them.

## 7. Services you connect

You can connect g1t to other services: your own model providers, issue trackers, error tracking, webhooks, and anything your sandboxes are allowed to reach. When you do, you're telling us to send them the data that connection needs. Those services are run by others, under their own terms and privacy policies, and we're not responsible for them.

## 8. Paying for g1t

- **The forge is free.** Repositories, git, issues, pull requests and review cost nothing, within the free limits described on [pricing](/pricing).
- **Compute is paid.** Agents, sandboxes, checks, workflows, the merge queue, deployments and the other metered items on [pricing](/pricing) are charged to the workspace, at what they cost us plus the markup shown there. **The g1t plan** is a monthly subscription per workspace, with some usage included.
- **Usage prices follow our costs.** They move when what we pay our providers moves, and every change is listed on the pricing page with its reason. We'll give owners at least 30 days' notice by email before we raise the plan's own monthly price.
- **Payment.** Payments are processed by Stripe. You authorize us to charge the workspace's card, or another payment method on file, for the plan, for usage as it is billed, and when the workspace nears its limit. Invoices are available from the Billing page. Card numbers never reach g1t.
- **Taxes.** Prices don't include taxes unless we say so. You're responsible for the taxes that apply to your purchases, other than taxes on our income.
- **Unpaid amounts.** If a payment fails or is disputed, new work stops until it's resolved, and we may suspend the workspace if it stays unpaid.
- **Trials and credits** (the trial, the open-source pool, goodwill credits and other credits we give) have no cash value, can't be transferred, and may change or end. Each card gets one trial.
- **Limits.** Workspaces have spend limits and caps, described in the [documentation](https://docs.g1t.sh/guides/usage-and-billing/). They protect you and us, but usage already under way can go slightly past a limit, and you're responsible for paying for it.
- **Refunds and goodwill credits** are covered by the [Refunds and Cancellation](/policies/refunds) policy.

Some customers have custom terms (such as invoicing or an enterprise account) agreed with us in writing. Where those conflict with these terms, the written agreement wins.

## 9. Cancelling, and taking your data with you

You can stop using g1t whenever you like.

- **Ending the plan.** An owner can end the plan from the Billing page. It stays on until the end of the period you've paid for, and nothing more is charged for it after. Usage until then is still billed.
- **Your data is yours to take.** Clone your repositories with git, use the API for issues, pull requests and everything else, and export the audit log and statements from the app, at any time, on any plan.
- **Deleting your account or a workspace.** Write to [hey@flagon.io](mailto:hey@flagon.io) from your account's email address. We'll confirm, give you a chance to export, and delete it within 30 days, except what we must keep by law (such as billing records) and backups, which expire on their own schedule. We'll settle any amount the workspace owes first.

## 10. Our responsibilities

We'll run g1t with reasonable care and skill, keep your content secure as described on our [security](/security) page, and tell you about changes that affect you. We publish the state of the service on the [status](/status) page. Unless you have a written agreement with us that says otherwise, we don't promise a particular uptime.

We change g1t all the time. If we remove a feature you pay for, or make a change that materially reduces what g1t does for you, we'll tell owners in advance.

## 11. Suspension and termination

We may suspend or close an account or workspace, or remove content, if:

- it breaks these terms or the Acceptable Use Policy;
- it puts g1t, our users or anyone else at risk, including through security problems or abuse;
- it hasn't paid what it owes; or
- the law requires us to.

Some of this is automatic: a sandbox that looks like it's mining cryptocurrency is stopped at once, and a workspace whose spending spikes is paused until an owner answers. When we act, we'll tell you why, unless the law stops us or telling you would help someone abuse g1t. If you think we got it wrong, reply or write to [hey@flagon.io](mailto:hey@flagon.io) and a person will look at it.

When an account or workspace is closed, we'll keep its content for 30 days so it can be exported, unless it was closed for illegal content or serious abuse, then delete it.

## 12. Disclaimers

We work hard to make g1t reliable, but **g1t is provided "as is" and "as available."** To the extent the law allows, Flagon disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, title and non-infringement. We don't promise that g1t will be uninterrupted or error-free, that agents' output will be correct or fit for your purpose, or that content will never be lost. Keep your own copies of what matters to you: git makes this easy.

## 13. Limitation of liability

To the extent the law allows:

- **Flagon isn't liable for indirect, incidental, special, consequential or punitive damages**, or for lost profits, revenue, data or goodwill, arising from or related to g1t or these terms, even if we were told they were possible.
- **Flagon's total liability** for any claim arising from or related to g1t or these terms is limited to the greater of what you paid Flagon for g1t in the 12 months before the claim arose, and US$100.

Some places don't allow some of these limits, so they may not all apply to you. Nothing in these terms limits liability that can't be limited by law, such as for fraud.

## 14. Indemnity

If someone makes a claim against Flagon because of your content or your use of g1t in breach of these terms or the law, you'll cover Flagon's reasonable costs of that claim, including reasonable legal fees. We'll tell you about the claim promptly and let you take part in defending it.

## 15. Copyright complaints

If you believe something on g1t infringes your copyright, send a notice to [hey@flagon.io](mailto:hey@flagon.io) with what is infringed, where it is on g1t, your contact details, and a statement that you believe in good faith the use isn't authorized and that your notice is accurate. If your content was removed and you believe that was a mistake, you can send a counter-notice to the same address. We close the accounts of repeat infringers.

Copyright notices and counter-notices go to Flagon, Inc. at [hey@flagon.io](mailto:hey@flagon.io).

## 16. Governing law and disputes

These terms are governed by the laws of the United States and of the state in which Flagon, Inc. is incorporated, without regard to conflict-of-law rules. Any dispute will be resolved in the state or federal courts there, and you and Flagon agree to their jurisdiction. If you're a consumer, you keep the protections of the law where you live that can't be waived by contract.

Before going to court, please write to [hey@flagon.io](mailto:hey@flagon.io). Most problems are solved faster by talking.

## 17. Changes to these terms

We'll update these terms as g1t changes. **We'll tell you before material changes take effect**: by email to workspace owners and on the [policies](/policies) page, at least 30 days ahead, unless a change is needed sooner for legal or security reasons. Every change is listed in the policies' change history. If you keep using g1t after a change takes effect, you're agreeing to the new terms. If you don't agree, you can stop using g1t and take your data with you.

## 18. The rest

- These terms, the policies they link to, and any written agreement for your account are the whole agreement between you and Flagon about g1t.
- If a court finds part of these terms unenforceable, the rest still applies.
- If we don't enforce something right away, we haven't given up the right to.
- You can't transfer these terms without our written consent. We may transfer them to a company that takes over g1t, and we'll tell you if we do.
- You must comply with the export control and sanctions laws that apply to you, and you may not use g1t if you're barred from receiving US services.

## 19. Contact

Flagon, Inc.\
[hey@flagon.io](mailto:hey@flagon.io)
