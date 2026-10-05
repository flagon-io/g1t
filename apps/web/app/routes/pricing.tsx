import { ArrowUpRight } from "lucide-react";

import { DEPLOYMENTS_ALLOWANCE, type FeaturePlan, type FreeTier, MICROS_PER_DOLLAR, type Price } from "@g1t/contracts";

import type { Route } from "./+types/pricing";
import { page } from "../lib/meta";
import { TimeAgo } from "../components/ui";
import { billing } from "../lib/services.server";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Pricing · g1t",
    description:
      "g1t passes its costs through: what Cloudflare and model providers charge g1t, plus 20%. Public repositories are free. No seats, ever.",
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

/** Whole dollars when they are whole. */
function dollars(micros: number): string {
  const d = micros / MICROS_PER_DOLLAR;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1e9) * 10) / 10} GB`;
}

/** What the page says when billing cannot be reached: the published defaults. */
const DEFAULT_FREE: FreeTier = {
  trialWorkspaceMicros: 1_000_000,
  trialMonthlyPoolMicros: 40_000_000,
  ossPoolMicros: 10_000_000,
  ossRepoMicros: 1_000_000,
  freePrivateStorageBytes: 1_000_000_000,
  auditRetentionDays: 30,
  minChargeMicros: 5_000_000,
};

const DEFAULT_PLANS: FeaturePlan[] = [
  {
    feature: "team",
    title: "Team",
    monthlyCents: 2000,
    includes: [
      "$5 of usage credit each month, drawn first by the month's usage at cost plus 20%. Unused credit does not roll over.",
      "50 GB of private repository storage, rather than 1 GB",
      "The audit log kept for 1 year, rather than 30 days",
      "Everyone in the workspace, at one price: never per person",
    ],
    overage: "Usage past the credit is charged as it is without the plan: at cost plus 20%.",
  },
  {
    feature: "deployments",
    title: "Deployments",
    monthlyCents: 500,
    includes: [
      `${DEPLOYMENTS_ALLOWANCE.apps} apps deployed at once, production and previews together`,
      `${DEPLOYMENTS_ALLOWANCE.buildSeconds / 60} build minutes`,
      `${DEPLOYMENTS_ALLOWANCE.requests / 1e6} million requests`,
      `${DEPLOYMENTS_ALLOWANCE.cpuMs / 1e6} million CPU milliseconds`,
      `${DEPLOYMENTS_ALLOWANCE.customDomains} custom domains, with certificates`,
    ],
    overage: "Usage past that is charged at Cloudflare's price plus 20%.",
  },
];

/** The ways to reach g1t about an enterprise account. */
const ENTERPRISE_MAIL = "mailto:billing@g1t.sh?subject=Enterprise%20billing%20for%20g1t";

const HOW = [
  {
    title: "Our cost, passed through",
    body: "Every sandbox second, build, app request and model token costs g1t money at Cloudflare or a model provider. Each is metered and charged at that cost plus 20%, from the first second and the first request. Use a little, pay a little.",
  },
  {
    title: "Prices follow costs, by themselves",
    body: "Model runs are charged at what Cloudflare's AI Gateway priced each request at, so a provider's price change reaches you the same day. Every day, each Cloudflare cost is checked against what Cloudflare billed g1t; when one moves, its price moves with it, and the change is listed below.",
  },
  {
    title: "The 20% is the overhead",
    body: "It pays for running g1t and for building and keeping up the features you use. The same 20% on everything, and nothing bundled in.",
  },
  {
    title: "No seats, ever",
    body: "Add as many people and agents as you like. A workspace pays for what it uses, and for the plans it turns on, each a flat price for the whole workspace.",
  },
  {
    title: "Free where something pays for it",
    body: "Public repositories are free, and their agents' compute comes from a capped open-source pool g1t pays for. New workspaces get a small trial from a monthly budget. Nothing free is an open-ended allowance.",
  },
  {
    title: "Limits that protect both of us",
    body: "Usage not yet paid for can only go so far: $3 for a new workspace, growing with what it pays. With a card on file, g1t charges it as you near the limit, so work that is paid for never stops. Owners can set a lower limit of their own.",
  },
];

export default function Pricing({ loaderData }: Route.ComponentProps) {
  const { book, free } = loaderData;
  const checked = book?.prices.map((p) => p.checkedAt).filter((at): at is string => !!at).sort().at(-1);
  const tier = book?.free ?? DEFAULT_FREE;
  const plans = book?.plans?.length ? book.plans : DEFAULT_PLANS;
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm font-medium text-accent">Pricing</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">What it costs us, plus 20%</h1>
      <p className="mt-3 max-w-2xl text-muted">
        g1t runs on Cloudflare and model providers, and passes those costs through. The numbers on this page are the
        live price book g1t charges from.
      </p>
      {free && (
        <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="font-medium">Free while g1t is being built out.</span>{" "}
          <span className="text-muted">
            Usage is recorded at these prices but not charged for now. Paid features, such as Deployments, are charged.
          </span>
        </div>
      )}

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
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
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">What</th>
              <th className="px-4 py-2.5 font-medium">Costs g1t</th>
              <th className="px-4 py-2.5 font-medium">Markup</th>
              <th className="px-4 py-2.5 font-medium">You pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Models</p>
                <p className="text-xs text-faint">g1t's hosted models, through AI Gateway</p>
              </td>
              <td className="px-4 py-3 text-muted">What the provider charges, per request</td>
              <td className="px-4 py-3 tabular-nums">{book?.modelMarginPercent ?? 20}%</td>
              <td className="px-4 py-3 text-muted">Cost + {book?.modelMarginPercent ?? 20}%</td>
            </tr>
            {(book?.prices ?? []).map((price) => (
              <tr key={price.meter}>
                <td className="px-4 py-3">
                  <p className="font-medium">{price.title}</p>
                  <p className="text-xs text-faint">
                    {price.source === "cloudflare" ? "Measured from Cloudflare's bill" : "Cloudflare's published price"}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">{perUnit(price, price.costMicros)}</td>
                <td className="px-4 py-3 tabular-nums">{price.markupPercent}%</td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums">{perUnit(price, price.priceMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Free, and what pays for it</h2>
      <p className="mt-1 text-sm text-muted">
        Hosting, git, issues, pull requests, review, search, the API and MCP cost nothing. What runs for you is metered,
        and these pay for some of it first, each from a fixed budget.
      </p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">What is free</th>
              <th className="px-4 py-2.5 font-medium">Paid for by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Public repositories and open source</p>
                <p className="text-xs text-faint">
                  Hosting, issues, pull requests and search are never charged. Agents' sandbox time and model cost on a
                  public repository come from the pool, up to {dollars(tier.ossRepoMicros)} a month per repository.
                </p>
              </td>
              <td className="px-4 py-3 text-muted">
                g1t's open-source pool, {dollars(tier.ossPoolMicros)} a month in all. When it or a repository's share is
                spent, the workspace pays as usual.
              </td>
            </tr>
            {tier.trialWorkspaceMicros > 0 && (
              <tr>
                <td className="px-4 py-3">
                  <p className="font-medium">A trial for each new workspace</p>
                  <p className="text-xs text-faint">
                    {dollars(tier.trialWorkspaceMicros)} of usage credit, once, given the first time it uses something.
                  </p>
                </td>
                <td className="px-4 py-3 text-muted">
                  A trial budget of {dollars(tier.trialMonthlyPoolMicros)} a month. When a month's is given out, new
                  trials start again on the 1st.
                </td>
              </tr>
            )}
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Private storage</p>
                <p className="text-xs text-faint">
                  {gigabytes(tier.freePrivateStorageBytes)} per workspace; past it, at the storage price above.
                </p>
              </td>
              <td className="px-4 py-3 text-muted">g1t, as part of the free core: at most {gigabytes(tier.freePrivateStorageBytes)} of storage a workspace, about $0.50 a month at Cloudflare's price.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted">
        No card is charged less than {dollars(tier.minChargeMicros)}, so a payment's fee is never most of it. Smaller
        amounts carry over to the next invoice.
      </p>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Plans</h2>
      <p className="mt-1 text-sm text-muted">
        Turned on by an owner, per workspace, at one flat price a month. Never per person.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {plans.map((plan) => (
          <section key={plan.feature} className="flex flex-col rounded-xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">{plan.title}</h3>
              <p>
                <span className="text-2xl font-semibold">${plan.monthlyCents / 100}</span>{" "}
                <span className="text-sm text-muted">/ month per workspace</span>
              </p>
            </div>
            <ul className="mt-3 space-y-1.5 text-sm text-muted">
              {plan.includes.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden className="text-accent">
                    ·
                  </span>
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-faint">{plan.overage}</p>
          </section>
        ))}
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Enterprise</h2>
      <p className="mt-1 text-sm text-muted">
        For organizations that would rather we run it for several teams, on terms set with them.
      </p>
      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          <li>
            <p className="font-medium">Consolidated invoicing</p>
            <p className="text-muted">One monthly invoice for every workspace, one limit, paid by card or bank transfer.</p>
          </li>
          <li>
            <p className="font-medium">Custom terms</p>
            <p className="text-muted">A limit of your own, discounts on usage, and terms until a date, set with you.</p>
          </li>
          <li>
            <p className="font-medium">Audit log export</p>
            <p className="text-muted">Every action by people and agents, as CSV or JSON, kept a year on Team.</p>
          </li>
          <li>
            <p className="font-medium">
              Single sign-on <span className="ml-1 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">Coming</span>
            </p>
            <p className="text-muted">Sign in through your identity provider. Not available yet.</p>
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
            const fresh = after === before;
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
                  {change.reason} · <TimeAgo at={change.createdAt} />
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
