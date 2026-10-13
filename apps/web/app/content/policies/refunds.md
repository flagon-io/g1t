We'd rather you pay for what you use and feel good about it than argue over a bill. This page says when money goes back to you, and how ending the plan works. It's part of the [Terms of Service](/policies/terms). Prices and limits are on [pricing](/pricing) and in the [usage and billing guide](https://docs.g1t.sh/guides/usage-and-billing/).

## What is charged, and why

The forge is free. What costs money is compute, and the g1t plan, $21 a month per workspace with $10 of usage included, with no separate card or processing fee. Compute is hosted runner minutes (for checks, workflows and the merge queue), deploy builds, deployed apps (requests, CPU time, custom domains and containers), storage and git operations past what is included, search indexing, and observability data past the free amount. Most of it is charged at what it costs us plus 20%; runner minutes are a fixed rate for each machine, set from what a minute of it costs us. Model use isn't on g1t's bill: your agents, Ask g1t and sessions you start from g1t use your own AI provider, which bills you. The plan is billed monthly in advance; usage is billed when each month closes, or sooner as the workspace nears its limit on unpaid usage. Because usage is charged at close to what it costs us, most of it can't be given back once it has run: we've already paid for it.

That's why g1t works hard to keep spending from surprising you: a $5 trial that never turns into a charge, a spend limit you set, budget alerts at 50%, 75%, 90% and 100%, and a pause when spending suddenly spikes until an owner says to keep going.

## Spent more than you meant to

If a month went well past what you meant to spend (a runaway job, a workflow that kept going, a loop you didn't notice), tell us. On the workspace's **Billing** page, an owner chooses **Spent more than you meant to? Tell us.**, says what happened, and sends it.

- **Once every 12 months per workspace**, g1t can credit the overage above your usual month.
- **The 20% we added to that overage always comes back to you.** We don't keep a margin on a mistake.
- **What the overage cost us is covered up to $50.**
- Larger amounts, or a second request within 12 months, are reviewed by a person.

The credit appears on your statement with the day it happened, such as *Credit from g1t: accidental usage on 2026-11-12*, and pays for usage before your card is charged. Credits have no cash value.

## When we refund to your card

- **Charged in error.** If we charged you twice, charged the wrong amount, or charged for something that didn't run because of a fault on our side, we refund it to the card it was paid with.
- **Unused prepaid balance**, when you close the workspace: write to us **before you delete it**, and we'll refund what's left to the card or account it came from.
- **Anything else** is up to us, case by case. Write to [hey@flagon.io](mailto:hey@flagon.io) and we'll be fair about it.

Refunds appear on the statement under **Refunds** and take as long as your bank takes to show them, usually 5 to 10 business days. Tax paid on a refunded amount is refunded in proportion.

We don't refund for part of a month on the plan, or for usage that ran as asked. The plan's included usage doesn't roll over, and isn't refunded if unused.

## Ending the plan

- **An owner or billing manager can end the plan at any time** from **Settings → Billing and plans**: **Manage billing** opens Stripe's billing page, where you cancel it. The plan stays on until the end of the period you've paid for, and nothing more is charged for it after; the rest of the period isn't prorated. Until the period ends, you can renew it from the same page.
- **Usage until the plan ends is still billed**, on the final invoice.
- **When the plan ends**, the workspace goes back to free. Repositories, issues, pull requests and the audit log stay. Compute stops unless the trial or the open-source pool pays for it, and private storage past the free amount stops taking pushes until it's back under, though nothing is deleted.
- **If a renewal payment fails**, the plan's features stop until it's paid. Update the card from the Billing page.

## Closing a workspace or account

An owner deletes a workspace from its **Settings → General**. What it owes is charged at once, and its plan ends at once, without a refund for the rest of the period. If it has prepaid balance left, write to [hey@flagon.io](mailto:hey@flagon.io) first (see above). A deleted workspace can be restored for 30 days, then it is purged. You delete your own account from your account settings. See [cancelling](/policies/terms#cancelling-and-taking-your-data-with-you) in the terms.

## Disputes

If a charge looks wrong, please write to [hey@flagon.io](mailto:hey@flagon.io) before disputing it with your bank. We'll answer within one business day, and we can usually fix it faster. While a payment is disputed, the workspace's paid work stops. If the dispute is decided against us, it stays stopped until what the bank took back is paid. See the [usage and billing guide](https://docs.g1t.sh/guides/usage-and-billing/#your-card-and-billing-details).

## Custom terms

Enterprise and other custom agreements may have their own refund and cancellation terms. Where they differ from this page, the written agreement applies.
