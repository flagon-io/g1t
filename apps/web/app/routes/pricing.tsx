import { ArrowUpRight } from "lucide-react";

import { type FeaturePlan, type FreeTier, MICROS_PER_DOLLAR, type Price } from "@g1t/contracts";

import type { Route } from "./+types/pricing";
import { wholeDollars } from "../lib/billing";
import { page } from "../lib/meta";
import { TimeAgo } from "../components/ui";
import { billing } from "../lib/services.server";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Pricing · g1t",
    description:
      "The forge is free. One plan, $20 a month per workspace with $10 of usage included; usage at what it costs g1t plus 20%. No seats, ever.",
  });
}

export async function loader() {
  const [book, status] = await Promise.all([billing.prices().catch(() => null), billing.status().catch(() => null)]);
  return { book, free: status?.free ?? false };
}

/** A price in dollars, with as many digits as it needs to say anything. */
function money(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toPrecision(2)}`;
}

/** Per second is easier to read per minute. */
function perUnit(price: Price, micros: number): string {
  return price.unit === "second" ? `${money(micros * 60)} a minute` : `${money(micros)} per ${price.unit}`;
}

function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1e9) * 10) / 10} GB`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** Price-book rows the table shows in rows of their own, or not at all. */
const SHOWN_APART = new Set([
  "app_month",
  "agent_models",
  "agent_tokens",
  "agent_tokens_own",
  "agent_token_weight_input",
  "agent_token_weight_output",
  "agent_token_weight_cache_read",
  "agent_token_weight_cache_write",
  "gateway_models",
  "card_fee_percent",
  "card_fee_fixed",
]);

/** How each kind of token counts toward the agent rate, from the price book: `input ×1, …`. */
function tokenWeights(prices: { meter: string; costMicros: number }[]): string {
  const weight = (kind: string) => {
    const row = prices.find((p) => p.meter === `agent_token_weight_${kind}`);
    return row ? Number((row.costMicros / 1_000_000).toFixed(3)) : 1;
  };
  return `input ×${weight("input")}, output ×${weight("output")}, cache reads ×${weight("cache_read")}, cache writes ×${weight("cache_write")}`;
}

/** What the page says when billing cannot be reached: the published defaults. */
const DEFAULT_FREE: Required<FreeTier> = {
  trialWorkspaceMicros: 5_000_000,
  trialMonthlyPoolMicros: 100_000_000,
  ossPoolMicros: 25_000_000,
  ossRepoMicros: 2_000_000,
  freePrivateStorageBytes: 1_000_000_000,
  auditRetentionDays: 7,
  planAuditRetentionDays: 90,
  minChargeMicros: 5_000_000,
  gitOperationsIncluded: 50_000,
  paidStartCeilingMicros: 100_000_000,
  overageForgiveCostMicros: 50_000_000,
};

const DEFAULT_PLAN: FeaturePlan = {
  feature: "plan",
  title: "g1t",
  monthlyCents: 2000,
  includes: [
    "$10 of usage each month at cost plus 20%, used first",
    "Everyone in the workspace at one price, never per person",
    "Unlimited projects, previews and repositories",
    "Agents, checks, workflows, the merge queue, deployments and semantic search",
    "Usage past $10 is charged at cost plus 20%, up to your spend limit",
  ],
  overage: "Everything is metered from the first unit at what it costs g1t plus 20%. Unused included usage does not roll over.",
};

/** The ways to reach g1t about an enterprise account. */
const ENTERPRISE_MAIL = "mailto:hey@flagon.io?subject=Enterprise%20billing%20for%20g1t";

const HOW = [
  {
    title: "Our cost, passed through",
    body: "Every sandbox second, build and app request costs g1t money at Cloudflare. Each is metered and charged at that cost plus 20%, from the first second and the first request. Models are charged at the provider's price with no markup, plus a flat agent rate per million tokens for what g1t adds around them, from prepaid AI credit. Use a little, pay a little.",
  },
  {
    title: "Prices follow costs, by themselves",
    body: "Model runs are charged at what Cloudflare's AI Gateway priced each request at, so a provider's price change reaches you the same day. Every day, sandbox, build and app costs are checked against what Cloudflare billed g1t; when one moves, its price moves with it, and the change is listed below. The rest are Cloudflare's published prices, marked as such.",
  },
  {
    title: "The 20% is the overhead",
    body: "It pays for running g1t and for building and keeping up the features you use. The same 20% on everything but models, whose overhead is the agent rate, and nothing bundled in.",
  },
  {
    title: "No seats, ever",
    body: "Once a workspace is on the plan, add as many people and agents as you like. It pays one flat price for the plan, and for what it uses past what the plan includes.",
  },
  {
    title: "Prices exclude tax",
    body: "Every price here is before tax. Stripe adds sales tax, VAT or GST where it applies, worked out from the billing address, and shows it as its own line before you pay and on every receipt and invoice. A valid business tax ID is applied where the law says so.",
  },
  {
    title: "Card fees are passed on, nothing more",
    body: "Paying by card adds Stripe's card processing fee as its own line, shown before you pay, so the 20% is never spent on fees. A bank transfer or invoiced billing has no card fee.",
  },
];

/** One row of the free-and-plan table. */
type Row = { what: string; free: string; plan: string; note?: string };

function rows(tier: Required<FreeTier>): Row[] {
  return [
    {
      what: "The forge",
      free: "Free",
      plan: "Included",
      note: "Public and private repositories, issues, pull requests, reviews, protected branches, code owners, search and Explore.",
    },
    {
      what: "Agents, checks, workflows, merge queue",
      free: "After a card check: the trial, and the open-source pool for checks, workflows and the merge queue on public repositories",
      plan: "From the plan's included usage, then at cost plus 20%",
    },
    {
      what: "Projects and previews",
      free: "Not available: deployments run on g1t's machines",
      plan: "Unlimited, and never charged for. An app no one visits costs nothing.",
    },
    {
      what: "Deployments",
      free: "Not available",
      plan: "Builds by the second, app requests, CPU time and custom domains, each from the first at cost plus 20%",
    },
    {
      what: "Semantic search",
      free: "After a card check, from the trial",
      plan: "From the plan's included usage, then at cost plus 20%",
    },
    {
      what: "Private storage",
      free: `${gigabytes(tier.freePrivateStorageBytes)}, never charged. Past it, pushes to private repositories stop until you make room or start the plan.`,
      plan: `${gigabytes(tier.freePrivateStorageBytes)} free, then at cost plus 20%. Pushes never stop.`,
      note: "Public repositories are never charged for storage.",
    },
    {
      what: "Git operations",
      free: `${count(tier.gitOperationsIncluded)} a month, never charged. Past it, slowed to 60 an hour until the month turns.`,
      plan: `${count(tier.gitOperationsIncluded)} a month free, then at cost plus 20%. Never slowed.`,
      note: "Clones, fetches and pushes through g1t.",
    },
    {
      what: "Actions cache",
      free: "2 GiB an entry and 10 GiB a repository, never charged",
      plan: "The same limits, with what it stores at cost plus 20%",
    },
    {
      what: "Audit log",
      free: `${tier.auditRetentionDays} days, with export`,
      plan: `${tier.planAuditRetentionDays} days, with export`,
      note: "Longer by arrangement. Older entries are deleted each day.",
    },
    {
      what: "Secret scanning, push protection, vulnerability alerts, security updates",
      free: "Included",
      plan: "Included",
      note: "Custom patterns, validity checks, code scanning, dependency review and the security overview on private repositories are the Security and quality activation. On public repositories they are free.",
    },
    { what: "Single sign-on", free: "On every plan, once it is built", plan: "On every plan, once it is built" },
    {
      what: "Members",
      free: "Only the people already in it: a free workspace cannot add members, invite people or invite outside collaborators",
      plan: "Unlimited, never per seat",
      note: "Each person can own one free workspace. More workspaces need the plan.",
    },
    {
      what: "Usage past what is included",
      free: "Not possible: a free workspace never runs up a bill",
      plan: "Charged at cost plus 20%, up to a spend limit you set. No quotas: only your limit stops anything.",
    },
  ];
}

export default function Pricing({ loaderData }: Route.ComponentProps) {
  const { book, free } = loaderData;
  const checked = book?.prices.map((p) => p.checkedAt).filter((at): at is string => !!at).sort().at(-1);
  const given = Object.fromEntries(Object.entries(book?.free ?? {}).filter(([, value]) => value != null));
  const tier: Required<FreeTier> = { ...DEFAULT_FREE, ...given };
  const plan = book?.plans?.find((p) => p.feature === "plan") ?? DEFAULT_PLAN;
  // The Security and quality activation, as the price book prices it.
  const securityPlan = book?.plans?.find((p) => p.feature === "security") ?? null;
  const price = plan.monthlyCents / 100;
  const dollars = wholeDollars;
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm font-medium text-accent">Pricing</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">One plan, and usage at cost plus 20%</h1>
      <p className="mt-3 max-w-2xl text-muted">
        The forge is free for everyone. Work that runs on g1t's machines is metered at what it costs g1t, plus 20%. The
        numbers on this page are the live price book g1t charges from. Prices exclude tax, which is added where it applies.
      </p>
      {free && (
        <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="font-medium">Free while g1t is being built out.</span>{" "}
          <span className="text-muted">Usage is recorded at these prices but not charged for now. The plan is charged.</span>
        </div>
      )}

      <section className="mt-10 rounded-xl border border-accent/40 bg-surface p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{plan.title}</h2>
          <p>
            <span className="text-3xl font-semibold tabular-nums">${price}</span>{" "}
            <span className="text-sm text-muted">a month per workspace</span>
            <span className="block text-right text-xs text-faint">
              {plan.cardFeeCents ? `+ $${(plan.cardFeeCents / 100).toFixed(2)} card processing fee, plus tax where it applies` : "Plus tax where it applies"}
            </span>
          </p>
        </div>
        <ul className="mt-4 space-y-1.5 text-sm text-muted">
          {plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-accent">
                ✓
              </span>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-faint">{plan.overage}</p>
        <div className="mt-5 grid gap-5 border-t border-line pt-5 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Where the ${price} goes</p>
            <p className="mt-1 text-muted">
              $10 comes back to you as usage: agents, sandboxes, builds and deployments at cost plus 20%, used before
              anything else. The other $10 pays for running g1t, the free forge for everyone, and the people building it.
            </p>
          </div>
          <div>
            <p className="font-medium">No quotas</p>
            <p className="mt-1 text-muted">
              No count of projects, previews, builds, requests or git operations ever stops a workspace on the plan. Past
              the $10, usage is charged at cost plus 20%, and only your spend limit stops it. Unused included usage does
              not roll over.
            </p>
          </div>
        </div>
        <p className="mt-5 text-sm text-muted">An owner starts the plan from the workspace's Billing page.</p>
      </section>

      {securityPlan && (
        <section id="security" className="mt-6 rounded-xl border border-line bg-surface p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">{securityPlan.title}</h2>
            <p>
              <span className="text-3xl font-semibold tabular-nums">${(securityPlan.monthlyCents / 100).toFixed(securityPlan.monthlyCents % 100 ? 2 : 0)}</span>{" "}
              <span className="text-sm text-muted">a month per workspace</span>
              <span className="block text-right text-xs text-faint">
                {securityPlan.cardFeeCents
                  ? `+ $${(securityPlan.cardFeeCents / 100).toFixed(2)} card processing fee, plus tax where it applies`
                  : "Plus tax where it applies"}
              </span>
            </p>
          </div>
          <p className="mt-2 text-sm text-muted">
            An activation, with or without the plan: the security suite's paid parts for a workspace's private repositories.
          </p>
          <ul className="mt-4 space-y-1.5 text-sm text-muted">
            {securityPlan.includes.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-accent">
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">{securityPlan.overage}</p>
        </section>
      )}

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Free and the plan, side by side</h2>
      <p className="mt-1 text-sm text-muted">
        Secret scanning, push protection, vulnerability alerts and security updates are free everywhere, on every plan.
      </p>
      {/* On a phone, one row at a time with both answers under it; a table that wide would scroll. */}
      <ul className="mt-4 divide-y divide-line rounded-xl border border-line text-sm sm:hidden">
        {rows(tier).map((row) => (
          <li key={row.what} className="px-4 py-3">
            <p className="font-medium">{row.what}</p>
            {row.note && <p className="text-xs text-faint">{row.note}</p>}
            <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-xs leading-5 text-faint">Free</dt>
              <dd className="text-muted">{row.free}</dd>
              <dt className="text-xs leading-5 text-faint">{plan.title}</dt>
              <dd className="text-muted">{row.plan}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="mt-4 hidden overflow-x-auto rounded-xl border border-line sm:block">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">
                <span className="sr-only">What</span>
              </th>
              <th className="px-4 py-2.5 font-medium">Free</th>
              <th className="px-4 py-2.5 font-medium">
                {plan.title}, ${price} a month
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows(tier).map((row) => (
              <tr key={row.what} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-medium">{row.what}</p>
                  {row.note && <p className="text-xs text-faint">{row.note}</p>}
                </td>
                <td className="px-4 py-3 text-muted">{row.free}</td>
                <td className="px-4 py-3 text-muted">{row.plan}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted">
        Git operations cost g1t money too: Cloudflare charges g1t $0.15 per 1,000. {count(tier.gitOperationsIncluded)} a
        month is far more than an active workspace uses; an agent run takes two to four.
      </p>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">No card, no compute</h2>
      <div className="mt-3 max-w-3xl space-y-3 text-sm text-muted">
        <p>
          Agents, checks, workflows, the merge queue, deployments and semantic search run on g1t's machines. They need
          the plan, or a card check.
        </p>
        <p>
          The reason: compute costs g1t real money from the first second, and free compute draws people who use it to
          mine cryptocurrency. A card check is the smallest gate that stops that, with one trial per card.
        </p>
        <p>
          A card check is never charged. Stripe saves and verifies the card, with 3-D Secure where your bank asks for it.
          Nothing is charged until an owner starts the plan, and then the same card is used, without asking for it again.
          The trial needs a credit or debit card; prepaid cards can still pay for the plan.
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">The trial</h3>
          <p className="mt-1.5 text-sm text-muted">
            {dollars(tier.trialWorkspaceMicros)} of usage, once per workspace and once per card, after a card check with a credit or
            debit card. It comes from a{" "}
            {dollars(tier.trialMonthlyPoolMicros)} pool each month for everyone; when a month's pool is given out, new
            trials wait until the 1st. The trial does not cover deployments and never turns into a charge. If the last
            run on a trial goes past it, g1t covers the difference.
          </p>
        </section>
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">The open-source pool</h3>
          <p className="mt-1.5 text-sm text-muted">
            Checks, workflows and the merge queue on public repositories, after a card check:{" "}
            {dollars(tier.ossPoolMicros)} a month in all, up to {dollars(tier.ossRepoMicros)} a month per repository.
            Agents do not run from the pool. When the pool or a repository's share is used up, the work waits for the
            month to turn, or the workspace pays as usual.
          </p>
        </section>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Limits, and how to raise them</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        g1t lets usage run ahead of payment only so far. Limits keep a mistake small, for you and for g1t.
      </p>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">{dollars(tier.paidStartCeilingMicros)} in the first month</p>
          <p className="mt-1 text-muted">
            A workspace on the plan can use up to {dollars(tier.paidStartCeilingMicros)} in its first month. After that,
            the limit grows with payments that clear.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Your own spend limit</p>
          <p className="mt-1 text-muted">
            Owners set a monthly spend limit anywhere up to the highest limit the workspace has had, with no approval.
            Once, you can raise it yourself to twice that.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Prepay to raise it now</p>
          <p className="mt-1 text-muted">
            Prepaying from $25 raises what you can use by the same amount, at once. From $1,000 you can also pay by bank
            transfer.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Raise my limit</p>
          <p className="mt-1 text-muted">
            Need more? Ask from Billing with the amount, why, and what you expect to spend. You get an answer within one
            business day, in the app and by email.
          </p>
        </li>
      </ul>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">When usage runs high</h2>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">A spike pauses new work</p>
          <p className="mt-1 text-muted">
            When an hour's spend is five times your usual hour, and at least $5, new compute waits for an owner to choose
            Keep going or Stop. Runs already going finish.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Caps per run and per issue</p>
          <p className="mt-1 text-muted">
            One agent run stops at $2 and the agents on one issue at $10 in all, so a run stuck in a loop stops on its own.
            Owners change both on Billing.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Alerts at 50, 75, 90 and 100%</p>
          <p className="mt-1 text-muted">
            Of the plan's included usage, your spend limit and g1t's limit: in the app and by email.
          </p>
        </li>
        <li className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Spent more than you meant to? Tell us</p>
          <p className="mt-1 text-muted">
            Tell us from Billing what happened. Once in 12 months, g1t can credit back usage you did not mean, always
            including its 20% on it. Larger credits, or a second one within 12 months, are reviewed by a person.
          </p>
        </li>
      </ul>
      <p className="mt-3 text-sm text-muted">
        No card is charged less than {dollars(tier.minChargeMicros)} when a month closes, so a payment's fee is never most
        of it. Smaller amounts carry over to the next invoice. Charges at a limit always go through.
      </p>

      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        {HOW.map((item) => (
          <section key={item.title} className="rounded-xl border border-line bg-surface p-5">
            <h2 className="font-medium">{item.title}</h2>
            <p className="mt-1.5 text-sm text-muted">{item.body}</p>
          </section>
        ))}
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Usage</h2>
      <p className="mt-1 text-sm text-muted">
        {checked ? (
          <>
            Last checked against Cloudflare's bill <TimeAgo at={checked} />.
          </>
        ) : (
          "Starting from Cloudflare's published prices; checked against its bill daily."
        )}
      </p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-sm sm:min-w-[36rem]">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">What</th>
              <th className="px-4 py-2.5 font-medium">Costs g1t</th>
              {/* The markup is in what you pay; on a phone the column gives way. */}
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Markup</th>
              <th className="px-4 py-2.5 font-medium">You pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Agent models</p>
                <p className="text-xs text-faint">g1t's hosted models for agent runs, the cheapest that can do each job, paid from AI credit</p>
              </td>
              <td className="px-4 py-3 text-muted">What the provider charges, per request</td>
              <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{book?.modelMarginPercent ?? 0}%</td>
              <td className="px-4 py-3 text-muted">{book?.modelMarginPercent ? `Cost + ${book.modelMarginPercent}%` : "The provider's price"}</td>
            </tr>
            {(() => {
              const rate = book?.prices.find((p) => p.meter === "agent_tokens");
              const gateway = book?.prices.find((p) => p.meter === "gateway_models");
              const feePercent = book?.prices.find((p) => p.meter === "card_fee_percent");
              const feeFixed = book?.prices.find((p) => p.meter === "card_fee_fixed");
              const coming = book?.changes.find((c) => c.meter === "agent_tokens" && c.effectiveAt);
              const ownRate = book?.prices.find((p) => p.meter === "agent_tokens_own");
              const ownComing = book?.changes.find((c) => c.meter === "agent_tokens_own" && c.effectiveAt);
              return (
                <>
                  <tr>
                    <td className="px-4 py-3">
                      <p className="font-medium">g1t agent rate</p>
                      <p className="text-xs text-faint">Context, memory, routing and orchestration, on every token an agent run uses</p>
                      <p className="text-xs text-faint">Tokens count by kind: {tokenWeights(book?.prices ?? [])}</p>
                    </td>
                    <td className="px-4 py-3 text-muted">A flat rate</td>
                    <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {rate && rate.priceMicros > 0 ? `${money(rate.priceMicros)} per million tokens` : coming ? `${money(coming.newCostMicros)} per million tokens from ${coming.effectiveAt!.slice(0, 10)}` : "$0.25 per million tokens"}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">
                      <p className="font-medium">g1t agent rate, your own model key</p>
                      <p className="text-xs text-faint">The same, on runs that use your own provider; its models are billed by your provider, not g1t</p>
                    </td>
                    <td className="px-4 py-3 text-muted">A flat rate</td>
                    <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {ownRate && ownRate.priceMicros > 0 ? `${money(ownRate.priceMicros)} per million tokens` : ownComing ? `${money(ownComing.newCostMicros)} per million tokens from ${ownComing.effectiveAt!.slice(0, 10)}` : "$0.25 per million tokens"}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">
                      <p className="font-medium">
                        AI Gateway <span className="ml-1 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">Free during beta</span>
                      </p>
                      <p className="text-xs text-faint">Your own apps calling models through g1t; your own key is free on the plan</p>
                    </td>
                    <td className="px-4 py-3 text-muted">What the provider charges</td>
                    <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{gateway?.markupPercent ?? 0}%</td>
                    <td className="px-4 py-3 text-muted">{gateway?.markupPercent ? `Cost + ${gateway.markupPercent}%` : "The provider's price"}</td>
                  </tr>
                  {feePercent && feeFixed && (
                    <tr>
                      <td className="px-4 py-3">
                        <p className="font-medium">Card processing fee</p>
                        <p className="text-xs text-faint">
                          On every card payment, as its own line shown before you pay; never on bank transfers or invoiced billing
                        </p>
                      </td>
                      <td className="px-4 py-3 text-muted">Stripe's fee</td>
                      <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
                      <td className="px-4 py-3 font-mono text-xs tabular-nums">
                        {(feePercent.priceMicros / 10_000).toFixed(1)}% + {money(feeFixed.priceMicros)}
                      </td>
                    </tr>
                  )}
                </>
              );
            })()}
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Projects, previews and apps</p>
                <p className="text-xs text-faint">Having them. An app's requests and CPU time are charged below.</p>
              </td>
              <td className="px-4 py-3 text-muted">Next to nothing</td>
              <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
              <td className="px-4 py-3 text-muted">Not charged</td>
            </tr>
            {(book?.prices ?? []).filter((price) => !SHOWN_APART.has(price.meter)).map((price) => (
              <tr key={price.meter}>
                <td className="px-4 py-3">
                  <p className="font-medium">{price.title}</p>
                  <p className="text-xs text-faint">
                    {price.meter === "actions_cache" ? "On the plan only. A free workspace is never charged for it. " : ""}
                    {price.source === "cloudflare" ? "Measured from Cloudflare's bill" : "Cloudflare's published price"}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">{perUnit(price, price.costMicros)}</td>
                <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{price.markupPercent}%</td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums">{perUnit(price, price.priceMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Enterprise</h2>
      <p className="mt-1 text-sm text-muted">
        For organizations with several workspaces: one invoice and one limit. The prices are the ones on this page.
      </p>
      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          <li>
            <p className="font-medium">Consolidated invoicing</p>
            <p className="text-muted">One monthly invoice for every workspace, paid by card or bank transfer.</p>
          </li>
          <li>
            <p className="font-medium">Custom terms</p>
            <p className="text-muted">One limit across every workspace, invoice terms and a billing contact, set with you.</p>
          </li>
          <li>
            <p className="font-medium">Security on every plan</p>
            <p className="text-muted">
              The audit log with export, {tier.planAuditRetentionDays} days or longer by arrangement, and secret push
              protection, for every workspace.
            </p>
          </li>
          <li>
            <p className="font-medium">
              Single sign-on <span className="ml-1 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">Coming</span>
            </p>
            <p className="text-muted">Through your identity provider, on every plan once it is built. Not available yet.</p>
          </li>
        </ul>
        <a
          href={ENTERPRISE_MAIL}
          className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong"
        >
          Write to us about enterprise
          <ArrowUpRight size={14} />
        </a>
      </section>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Price changes</h2>
      {book && book.changes.length > 0 ? (
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
          {book.changes.map((change) => {
            const title = book.prices.find((p) => p.meter === change.meter)?.title ?? change.meter;
            // What you pay moved: the cost, the markup, or both.
            const before = change.oldCostMicros * (100 + (change.oldMarkupPercent ?? change.markupPercent));
            const after = change.newCostMicros * (100 + change.markupPercent);
            const up = after > before;
            const fresh = after === before || before === 0;
            return (
              <li key={`${change.meter}-${change.createdAt}`} className="px-4 py-3 text-sm">
                <p>
                  <span className="font-medium">{title}</span>{" "}
                  {fresh ? (
                    <span className="text-muted">new</span>
                  ) : (
                    <span className={up ? "text-warn" : "text-accent"}>
                      {up ? "up" : "down"} {Math.abs((after / before - 1) * 100).toFixed(1)}%
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-faint">
                  {change.effectiveAt ? (
                    <>
                      {change.reason} · <span className="text-fg-soft">takes effect {change.effectiveAt.slice(0, 10)}</span>
                    </>
                  ) : (
                    <>
                      {change.reason} · <TimeAgo at={change.createdAt} />
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">None yet. When a price moves, it is listed here with why.</p>
      )}

      <a
        href="https://docs.g1t.sh/guides/usage-and-billing/"
        className="mt-12 inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
      >
        How usage and billing work
        <ArrowUpRight size={14} />
      </a>
    </main>
  );
}
