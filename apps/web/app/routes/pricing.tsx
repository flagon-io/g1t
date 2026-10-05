import { ArrowUpRight } from "lucide-react";

import { DEPLOYMENTS_ALLOWANCE, MICROS_PER_DOLLAR, type Price } from "@g1t/contracts";

import type { Route } from "./+types/pricing";
import { page } from "../lib/meta";
import { TimeAgo } from "../components/ui";
import { billing } from "../lib/services.server";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Pricing · g1t",
    description: "g1t passes its costs through: what Cloudflare and model providers charge g1t, plus 20%. No seats.",
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
    body: "Add as many people and agents as you like. A workspace pays for what it uses, and for the features it turns on.",
  },
  {
    title: "Limits that protect both of us",
    body: "Usage not yet paid for can only go so far: $3 for a new workspace, growing with what it pays. With a card on file, g1t charges it as you near the limit, so work that is paid for never stops. Owners can set a lower limit of their own.",
  },
  {
    title: "Enterprise billing",
    body: "One bill, one limit and one set of terms for several workspaces. Write to us to set one up.",
  },
];

export default function Pricing({ loaderData }: Route.ComponentProps) {
  const { book, free } = loaderData;
  const checked = book?.prices.map((p) => p.checkedAt).filter((at): at is string => !!at).sort().at(-1);
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

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Features</h2>
      <p className="mt-1 text-sm text-muted">Turned on per workspace with a monthly plan. Never free.</p>
      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium">Deployments</h3>
          <p>
            <span className="text-2xl font-semibold">$5</span> <span className="text-sm text-muted">/ month</span>
          </p>
        </div>
        <p className="mt-1 text-sm text-muted">
          Includes {DEPLOYMENTS_ALLOWANCE.apps} apps up at once, {(DEPLOYMENTS_ALLOWANCE.requests / 1e6).toLocaleString()}{" "}
          million requests, {(DEPLOYMENTS_ALLOWANCE.cpuMs / 1e6).toLocaleString()} million CPU milliseconds and{" "}
          {DEPLOYMENTS_ALLOWANCE.customDomains} custom domains a month;
          builds, and usage past that, at the prices above.
        </p>
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
            return (
              <li key={`${change.meter}-${change.createdAt}`} className="px-4 py-3 text-sm">
                <p>
                  <span className="font-medium">{title}</span>{" "}
                  <span className={up ? "text-warn" : "text-accent"}>
                    {up ? "up" : "down"} {Math.abs((after / before - 1) * 100).toFixed(1)}%
                  </span>
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
