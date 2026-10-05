import { ArrowRight, Check } from "lucide-react";
import { data, Link } from "react-router";

import type { Route } from "./+types/soon";
import { NavGlyph } from "~/components/shell";
import { Badge, Notice, Section, When } from "~/components/ui";
import { soonFor } from "~/lib/nav";
import { priceBook } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

/**
 * A page sudo will have. It says what it will do and why, and what it
 * will have, so the sidebar doubles as the roadmap for g1t's own back
 * office. Each is made from its entry in lib/nav.ts.
 */
export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.label ?? "Soon"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const page = soonFor(new URL(request.url).pathname);
  if (!page) throw data("Not found.", { status: 404 });
  // The price book's editor is to come; what it holds can be read today.
  const prices = page.to === "/prices" ? await settle(priceBook()) : null;
  return {
    label: page.label,
    about: page.about,
    icon: page.icon,
    soon: page.soon,
    prices: prices?.ok ? prices.value : null,
    pricesError: prices && !prices.ok ? prices.error : null,
  };
}

/** A unit price, which can be millionths of a dollar: `$0.000021`. */
function unitPrice(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars >= 0.01) return `$${dollars.toFixed(dollars >= 100 ? 0 : 2)}`;
  return `$${dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export default function Soon({ loaderData }: Route.ComponentProps) {
  const { label, about, icon, soon, prices, pricesError } = loaderData;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-14">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-merged/10 text-merged ring-1 ring-merged/30 ring-inset">
          <NavGlyph icon={icon} size={18} />
        </span>
        <Badge tone="lavender">Soon</Badge>
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">{label}</h1>
      <p className="mt-2 text-[0.9375rem] text-fg-soft">{about}</p>

      <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted">
        {soon.summary.map((paragraph) => (
          <p key={paragraph.slice(0, 40)}>{paragraph}</p>
        ))}
      </div>

      <section className="mt-8 rounded-lg border border-line bg-surface p-4 sm:p-5">
        <h2 className="text-xs font-medium tracking-wide text-faint uppercase">What it will have</h2>
        <ul className="mt-3 space-y-2.5">
          {soon.plans.map((plan) => (
            <li key={plan} className="flex gap-2.5 text-sm text-fg-soft">
              <Check size={15} className="mt-0.5 shrink-0 text-merged" />
              <span>{plan}</span>
            </li>
          ))}
        </ul>
      </section>

      {soon.meanwhile && (
        <div className="mt-4">
          <Notice tone="info">
            <span>
              Meanwhile: {soon.meanwhile.text}
              {soon.meanwhile.to && (
                <>
                  {" "}
                  <Link to={soon.meanwhile.to} className="inline-flex items-center gap-1 text-merged hover:underline hover:underline-offset-4">
                    {soon.meanwhile.link ?? "Open"}
                    <ArrowRight size={13} />
                  </Link>
                </>
              )}
            </span>
          </Notice>
        </div>
      )}

      {(prices || pricesError) && (
        <Section
          title="The price book today"
          description={
            prices ? `Read-only. Models are charged at cost plus ${prices.modelMarginPercent}%.` : undefined
          }
          className="mt-8"
        >
          {pricesError ? (
            <Notice tone="warn">Billing did not answer for prices: {pricesError}</Notice>
          ) : prices && prices.prices.length > 0 ? (
            <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
              <table className="w-full min-w-xl text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium sm:pl-5">Meter</th>
                    <th className="px-4 py-2 text-right font-medium">Cost</th>
                    <th className="px-4 py-2 text-right font-medium">Markup</th>
                    <th className="px-4 py-2 text-right font-medium">Price</th>
                    <th className="px-4 py-2 font-medium sm:pr-5">Cost from</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.prices.map((price) => (
                    <tr key={price.meter} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5 sm:pl-5">
                        <p className="text-fg-soft">{price.title}</p>
                        <p className="text-xs text-faint">per {price.unit}</p>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-muted">{unitPrice(price.costMicros)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted">{price.markupPercent}%</td>
                      <td className="tabular px-4 py-2.5 text-right text-fg">{unitPrice(price.priceMicros)}</td>
                      <td className="px-4 py-2.5 text-xs text-muted sm:pr-5">
                        {price.source === "cloudflare" ? "Cloudflare's bill" : price.source === "list" ? "List price" : price.source}
                        {price.checkedAt && (
                          <span className="block text-faint">
                            checked <When at={price.checkedAt} />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No metered prices yet.</p>
          )}
        </Section>
      )}

      <p className="mt-10 border-t border-line pt-5 text-xs text-faint">
        Part of the back office g1t is building for itself: one place for sales, support and finance, on the same data as the
        product, with every change recorded.
      </p>
    </main>
  );
}
