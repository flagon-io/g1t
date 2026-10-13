These terms are the agreement between you and Flagon, Inc. ("Flagon", "we", "us") when you use g1t: the website at g1t.sh, its API at api.g1t.sh, its MCP server at mcp.g1t.sh, git over g1t.sh, the documentation, apps deployed to g1t.page, and the runners and sandboxes g1t runs for you (together, "g1t" or "the service").

We've tried to write them the way we'd want to read them: plainly. If anything here is unclear, write to [hey@flagon.io](mailto:hey@flagon.io) and we'll explain it.

By creating an account or using g1t, you agree to these terms, the [Acceptable Use Policy](/policies/acceptable-use), and the [Refunds and Cancellation](/policies/refunds) policy. The [Privacy Policy](/policies/privacy) explains what we do with your information. If you use g1t for a company or another organization, you're agreeing for it, and you're telling us you're allowed to.

The g1t software is open source under the MIT license. These terms cover the service we run at g1t.sh, not your use of the source code; the license covers that.

## 1. Your account

- **You need an account to do most things.** Give us a real email address and keep it current: it's how we reach you about your account, security and billing, and how you get back in if you lose your password.
- **You must be at least 13 years old**, and old enough where you live to agree to these terms yourself. If you're under 18, a parent or guardian must agree to them for you.
- **An account is for one person.** Automation is welcome: use access tokens, workspace tokens and coding agents for it. Don't share a password, and don't create accounts to get around a limit, a trial, or a suspension.
- **Keep your credentials safe.** You're responsible for what happens under your account, your tokens and your SSH keys. If you think someone else has them, revoke them in your settings and tell us at [hey@flagon.io](mailto:hey@flagon.io).

## 2. Workspaces

Everything on g1t lives in a workspace: its projects, repositories, issues, pull requests, settings and bill. A workspace's **owners** control it. They decide who is a member, what members and agents may do, and they're responsible for paying for it. If you create a workspace for an organization, the organization is the customer, and its owners act for it.

## 3. Acceptable use

Use g1t lawfully and the way it's meant to be used. The [Acceptable Use Policy](/policies/acceptable-use) lists what isn't allowed. In short: no cryptocurrency mining, no abuse of g1t, other people or other systems, no malware, no illegal content, and no attempts to get around our limits, billing or security. We enforce it, including automatically (see section 11).

## 4. Your content stays yours

Your code, issues, pull requests, comments, files, settings, and anything else you or your agents put on g1t ("your content") belong to you or whoever you got them from. We don't claim ownership of any of it.

To run g1t, we need your permission to handle your content. You give Flagon a worldwide, non-exclusive, royalty-free license to host, store, copy, process, transmit and display your content **only as needed to provide, secure and improve the service for you**. That includes, for example:

- storing your repositories and showing them to the people you let see them;
- sending the relevant parts to your workspace's AI provider when you ask g1t a question (see section 6);
- indexing it so you can search it;
- scanning it for secrets and vulnerable dependencies, so we can warn you;
- making backups.

This license ends when your content is deleted from g1t, except for copies in backups (which expire on their own schedule) and content others have a right to keep under section 5.

**We don't sell your content, and we don't use your private content to train AI models.** g1t doesn't send your content to any outside model provider of its own: Ask g1t and sessions started from g1t use the AI provider your workspace connects, under your agreement with them. The only models g1t runs itself are the embedding models that index your content for search, on our hosting provider.

You're responsible for your content: that you have the right to put it on g1t, and that it doesn't break the law or someone else's rights.

## 5. Public repositories are public

When you make a project or repository public, **anyone can see it, including people without an account**. That includes its code and history, its issues and pull requests, comments, the recorded sessions of the agents that worked on it, and its deployed previews. Public content appears in g1t's search and Explore, in link previews, and can be read by search engines and by anyone's tools, including AI tools, that read the public web.

By making something public, you let every g1t user view it and fork it on g1t. Anything more (such as using your code in their own product) is governed by the license you choose for your repository. If you don't choose one, the law's defaults apply, which usually reserve your rights.

A fork someone else made of your public repository while it was public is theirs to keep, under your license, even if you later make yours private or delete it.

## 6. Agents you bring

The coding agents you connect to g1t (through the MCP server, the API, the g1t CLI or a plugin) work with your access: they read and change what you let them, and open issues and pull requests, record their sessions and claim work as you.

- **An agent acts on behalf of the person whose credentials it uses**, within the limits of that person's access, the token's scopes and the workspace's rules. Its actions are recorded as such in the audit log.
- **You're responsible for what you ask agents to do**, and for checking what they produce before you rely on it, merge it or deploy it, as you would for a teammate's work. Agents make mistakes. Their output can be wrong, insecure, or similar to code that exists elsewhere, and you're responsible for making sure your use of it complies with the licenses and laws that apply.
- **Guardrails** (token scopes, branch protection, required checks and spend limits) reduce risk. They're a safety net, not a guarantee that an agent won't do something you didn't intend.
- **What agents produce for you is your content.** As between you and us, Flagon claims no rights in it.
- **Your model provider bills you for model use, not g1t.** What your agents, Ask g1t and sessions started from g1t cost in model use is between you and your provider, under your agreement with them. What g1t itself charges for, such as the runner minutes your agents' checks and workflows use, is in section 8.

**Ask g1t** answers questions about your workspace with the AI provider your workspace connects. To answer, we send that provider the question and the content it needs (such as the issue, pull request or files it reads), under your agreement with them. Its answers can be wrong too.

## 7. Services you connect

You can connect g1t to other services: your own model providers, issue trackers, error tracking, webhooks, and anything your sandboxes are allowed to reach. When you do, you're telling us to send them the data that connection needs. Those services are run by others, under their own terms and privacy policies, and we're not responsible for them.

## 8. Paying for g1t

- **The forge is free.** Repositories, git, issues, pull requests and review cost nothing, within the free limits described on [pricing](/pricing).
- **Compute is paid.** Hosted runner minutes (for checks, workflows and the merge queue), deploy builds, deployed apps (requests, CPU time, custom domains and containers), storage and git operations past the free amounts, package and actions cache storage, search indexing, observability data past the free amount, and the other metered items on [pricing](/pricing) are charged to the workspace that owns the repository or project. Most are priced at what they cost us plus 20%; runner minutes are a fixed rate for each machine, set from what a minute of it costs us. Jobs on your own runners aren't charged. There is no price per person.
- **The g1t plan** is $21 a month per workspace, with $10 of usage included each month. Included usage doesn't roll over. There is no separate card or processing fee, on the plan or on anything else.
- **When you're billed.** The plan is billed monthly in advance, at the start of each billing period. Usage is billed in arrears: what a workspace used is invoiced when each month (UTC) closes, or sooner when the workspace nears our limit on unpaid usage (below). What a workspace owes when it is deleted is charged then.
- **Price changes.** Usage prices follow our costs. A price that goes down changes at once. When a usage price goes up, it's listed on [pricing](/pricing) with its reason and the day it takes effect, and owners of workspaces on the plan are emailed, **at least 14 days before** it applies. We'll give owners **at least 30 days' notice** by email before we raise the plan's own monthly price. Nothing already charged is repriced.
- **Payment.** Payments are processed by Stripe. You authorize us to charge the workspace's card, or another payment method on file, for the plan each period, for usage as it is billed, and when the workspace nears our limit on unpaid usage. Invoices and receipts are on the Billing page. Card numbers never reach g1t.
- **Taxes.** Prices don't include taxes. Where the law requires it, sales tax, VAT or GST is added, worked out by Stripe from the workspace's billing address, and shown as its own line before you pay and on every invoice. Without a billing address we can't work tax out, so we don't charge the card until one is added. You're responsible for the taxes that apply to your purchases, other than taxes on our income.
- **Failed payments.** If a card is declined, new paid work stops until the workspace pays; if a renewal fails, the plan's features stop too. What the workspace owes stays owed, and if it stays unpaid we may suspend the workspace (section 11).
- **Disputes and chargebacks.** Please write to us before disputing a charge with your bank (see [Refunds and Cancellation](/policies/refunds)). While a payment is disputed, the workspace's paid work stops. If the dispute is decided against us, it stays stopped until what the bank took back is paid.
- **Limits are yours to set.** Owners set the workspace's spend limit and budget alerts, and choose whether usage pauses at the limit. We also keep a limit of our own on usage not yet paid for, which starts at $100 in a workspace's first month on the plan and grows with its payment history, and we pause new compute when spending suddenly spikes, until an owner answers. Both are described in the [documentation](https://docs.g1t.sh/guides/usage-and-billing/). They're safety nets, not a promise: work already under way when a limit is reached finishes, so usage can go slightly past it, and you're responsible for paying for all usage your workspace runs, including past a limit you chose not to pause at.
- **Trials and credits** (the trial, the open-source pool, goodwill credits and other credits we give) have no cash value, can't be transferred, and may change or end. Each card gets one trial.
- **Refunds and goodwill credits** are covered by the [Refunds and Cancellation](/policies/refunds) policy.

Some customers have custom terms (such as invoicing or an enterprise account) agreed with us in writing. Where those conflict with these terms, the written agreement wins.

## 9. Cancelling, and taking your data with you

You can stop using g1t whenever you like.

- **Ending the plan.** An owner can end the plan from the Billing page. It stays on until the end of the period you've paid for, and nothing more is charged for it after. The rest of a period isn't refunded or prorated. Usage until then is still billed, on the final invoice.
- **Your data is yours to take.** Clone your repositories with git, use the API for issues, pull requests and everything else, and export the audit log and statements from the app, at any time, on any plan.
- **Deleting a workspace.** An owner can delete a workspace from its settings. What it owes is charged at once, and its plan ends at once, without a refund for the rest of the period. Usage still being metered for the current month must be charged first, so a workspace with some can be deleted from the 1st of the next month. A deleted workspace is kept for 30 days, so a deletion you didn't mean can be undone by writing to us, then purged, except what we must keep by law (such as invoices and billing records) and backups, which expire on their own schedule.
- **Deleting your account.** You can delete your account from your account settings, once every workspace you own alone has another owner or is deleted. It's kept for 30 days so it can be restored, then purged the same way.

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

When we close an account or workspace, we'll keep its content for 30 days so it can be exported, unless it was closed for illegal content or serious abuse, then delete it. What it owed for the plan and usage before it closed is still owed.

## 12. Disclaimers

We work hard to make g1t reliable, but **g1t is provided "as is" and "as available."** To the extent the law allows, Flagon disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, title and non-infringement. We don't promise that g1t will be uninterrupted or error-free, that answers or agents' output will be correct or fit for your purpose, or that content will never be lost. Keep your own copies of what matters to you: git makes this easy.

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
