import type { ReactNode } from "react";
import { Link } from "react-router";

import type { CostsReport } from "@g1t/contracts";

import type { Route } from "./+types/costs";
import { DaysChart } from "~/components/costs";
import { CostsHeader, chip, costsHref } from "~/components/costs-header";
import { Badge, Button, Field, Input, Notice, Section, Stat, When } from "~/components/ui";
import { capPercent, daySeries, marginTone, parseBucket, percentLabel, spendRows } from "~/lib/costs";
import { type CostsActionResult, costsAction, costsLoader } from "~/lib/costs-route.server";
import { usd } from "~/lib/money";

export const meta: Route.MetaFunction = () => [{ title: "Costs & margin · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export const loader = ({ request, context }: Route.LoaderArgs) => costsLoader(request, context);
export const action = ({ request, context }: Route.ActionArgs) => costsAction(request, context);

/**
 * Where g1t's money goes: the statement, what g1t pays for itself against
 * its caps, and the same by day, by product and by workspace.
 */
export default function Costs({ loaderData, actionData }: Route.ComponentProps) {
  const { range, report, error, done } = loaderData;
  const failed = actionData && "error" in actionData ? (actionData as CostsActionResult) : null;
  const description =
    "What g1t cost to run (Cloudflare's bill and the model providers') against what workspaces paid, with what g1t gave away on purpose kept apart. Prices are cost plus 20%; the bill itself, drift and the price book are on Bill & pricing.";
  if (!report) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <CostsHeader page="costs" range={range} report={null} done={null} runError={null} description={description} />
        <div className="mt-5">
          <Notice tone="warn">Billing did not answer for costs: {error}</Notice>
        </div>
      </main>
    );
  }
  const bucket = parseBucket(loaderData.bucket, report.products.map((p) => p.bucket));
  const product = report.products.find((p) => p.bucket === bucket) ?? null;
  const series = daySeries(report.days, report.since, report.until, bucket);
  const floor = report.settings.marginFloorPercent;
  const open = report.proposals.filter((p) => p.status === "open");
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <CostsHeader page="costs" range={range} report={report} done={done} runError={failed?.section === "run" ? failed.error : null} description={description} />

      <Statement report={report} floor={floor} range={range} proposals={open.length} />

      <SpendSection caps={report.caps} error={failed?.section === "lift" ? failed.error : null} />

      <Section
        className="mt-6"
        title={product ? `${product.title}, by day` : "By day"}
        description={
          product
            ? "What customers were charged for it at price, before included usage and pools paid part, against what it cost."
            : "Money in (usage paid for and the plan) against every cost. Pick a product to see its own."
        }
      >
        <nav aria-label="Product" className="mb-4 flex flex-wrap gap-2">
          <Link to={costsHref("costs", range, null)} aria-current={!bucket ? "page" : undefined} className={chip(!bucket)}>
            All of g1t
          </Link>
          {report.products.map((p) => (
            <Link key={p.bucket} to={costsHref("costs", range, p.bucket)} aria-current={p.bucket === bucket ? "page" : undefined} className={chip(p.bucket === bucket)}>
              {p.title}
            </Link>
          ))}
        </nav>
        <DaysChart
          days={series}
          floor={floor}
          revenueLabel={product ? "Charged at price" : "Money in"}
          label={product ? `${product.title}: charged against Cloudflare cost by day` : "Money in against Cloudflare cost by day"}
        />
      </Section>

      <Section className="mt-6" title="By product" description={`Each of g1t's products over the last ${range} days. The floor is ${floor}%.`}>
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium sm:px-5">Product</th>
                <th className="px-4 py-2 text-right font-medium">Charged at price</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Price book said</th>
                <th className="px-4 py-2 text-right font-medium">Margin</th>
                <th className="px-4 py-2 text-right font-medium sm:pr-5">%</th>
              </tr>
            </thead>
            <tbody>
              {report.products.map((p) => {
                const tone = p.overhead ? undefined : marginTone(p.marginPercent, floor);
                return (
                  <tr key={p.bucket} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 sm:px-5">
                      <Link to={costsHref("costs", range, p.bucket)} className="text-fg hover:underline">
                        {p.title}
                      </Link>
                      <span className="block text-xs text-faint">
                        {p.overhead ? "Paid by the plan" : p.costSource === "ledger" ? "Cost from the gateway, not Cloudflare" : p.bucket}
                      </span>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{usd(p.valueMicros)}</td>
                    <td className="tabular px-4 py-2.5 text-right">{usd(p.costMicros)}</td>
                    <td className="tabular px-4 py-2.5 text-right text-muted">{usd(p.ownCostMicros)}</td>
                    <td className={`tabular px-4 py-2.5 text-right ${p.marginMicros < 0 && !p.overhead ? "text-danger" : ""}`}>{usd(p.marginMicros)}</td>
                    <td className="px-4 py-2.5 text-right sm:pr-5">
                      {p.overhead ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Badge tone={tone === "mint" ? "mint" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : "plain"}>{percentLabel(p.marginPercent)}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        className="mt-6"
        title="Workspaces that cost most"
        description="Cloudflare's costs shared out by each workspace's own meters (its git operations, its usage), against what it paid. Over its revenue for 30 days, a workspace shows on Reach out."
      >
        {report.topWorkspaces.length === 0 ? (
          <p className="text-sm text-muted">No costs shared out yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:px-5">Workspace</th>
                  <th className="px-4 py-2 text-right font-medium">Cost to g1t</th>
                  <th className="px-4 py-2 text-right font-medium">Given away</th>
                  <th className="px-4 py-2 text-right font-medium">Paid</th>
                  <th className="px-4 py-2 text-right font-medium sm:pr-5">Net</th>
                </tr>
              </thead>
              <tbody>
                {report.topWorkspaces.map((w) => {
                  const net = w.revenueMicros - w.costMicros;
                  return (
                    <tr key={w.workspace} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 sm:px-5">
                        <Link to={`/workspaces/${encodeURIComponent(w.workspace)}#billing`} className="font-mono text-fg hover:underline">
                          {w.workspace}
                        </Link>
                        {w.internal && <span className="ml-2 text-xs text-faint">g1t's own</span>}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{usd(w.costMicros)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-fg-soft">{usd(w.givenMicros ?? 0)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{usd(w.revenueMicros)}</td>
                      <td className={`tabular px-4 py-2.5 text-right sm:pr-5 ${net < 0 && !w.internal ? "text-danger" : "text-fg-soft"}`}>{usd(net)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

    </main>
  );
}

function CapMeter({ label, used, cap, hint }: { label: string; used: number; cap: number; hint: ReactNode }) {
  const percent = capPercent(used, cap);
  const tone = cap > 0 && used >= cap ? "bg-danger" : percent >= 75 ? "bg-warn" : "bg-accent";
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="tabular text-sm">
          {usd(used)} <span className="text-faint">of {cap > 0 ? usd(cap) : "no cap"}</span>
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
        <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{hint}</p>
    </div>
  );
}

/**
 * Where the money went, as a short statement: usage sold and running g1t
 * (each against what paid for it), what g1t gave away on purpose (a budget,
 * never a loss), and who was paid.
 */
function Statement({ report, floor, range, proposals }: { report: CostsReport; floor: number; range: number; proposals: number }) {
  const o = report.overall;
  // Reports from before the statement have only the totals.
  const given = o.givenMicros ?? 0;
  const usageCost = o.usageCostMicros ?? o.costMicros - given;
  const included = o.includedMicros ?? 0;
  const usageIn = o.usageMicros + included;
  const usageMargin = o.usageMarginMicros ?? usageIn - usageCost;
  // Under a cent sold, a percentage says nothing (a few micros against none).
  const soldSomething = usageIn >= 10_000;
  const usagePercent = soldSomething && o.usageMarginPercent !== undefined ? o.usageMarginPercent : null;
  const running = o.runningCostMicros ?? 0;
  const unmapped = o.unmappedCostMicros ?? 0;
  // Cloudflare's subscriptions are not on the usage bill: the estimate, over the range.
  const subscriptions = Math.round((report.caps.fixedMonthlyMicros * range) / 30);
  const moneyIn = o.usageMicros + o.plansMicros;
  const spent = o.costMicros + subscriptions;
  const net = moneyIn - spent;
  const givenParts = [
    ["100% discounts", o.givenCompedMicros ?? 0],
    ["free use", o.givenFreeMicros ?? 0],
    ["trial", o.givenTrialMicros ?? 0],
    ["open-source pool", o.givenPoolMicros ?? 0],
    ["partial discounts", o.givenDiscountMicros ?? 0],
    ["promotional credit", o.givenCreditPromotionalMicros ?? 0],
    ["goodwill credit", o.givenCreditGoodwillMicros ?? 0],
  ].filter(([, micros]) => (micros as number) > 0) as [string, number][];
  const rows: { title: string; note: string; in: number | null; cost: number; result: number | null; tone?: "danger" | "warn" | "muted" }[] = [
    {
      title: "Usage sold",
      note:
        included > 0
          ? `What workspaces paid for usage (${usd(o.usageMicros, { cents: true })}) and their plan's included usage (${usd(included, { cents: true })}), against what it cost`
          : "What workspaces paid for usage, against what that usage cost",
      in: usageIn,
      cost: usageCost,
      result: usageMargin,
      tone: usageMargin < 0 ? "danger" : undefined,
    },
    {
      title: "Running g1t",
      note:
        included > 0
          ? `Plans (${usd(o.plansMicros, { cents: true })}) less the included usage they paid for, against Workers, D1, KV, Queues and the rest`
          : "Plans, against Workers, D1, KV, Queues and the rest of the platform",
      in: o.plansMicros - included,
      cost: running,
      result: o.plansMicros - included - running,
      tone: o.plansMicros - included - running < 0 ? "warn" : undefined,
    },
    {
      title: "Cloudflare subscriptions",
      note:
        report.caps.fixedSource === "cloudflare"
          ? `Fixed, as Cloudflare lists them${(report.caps.fixedItems ?? []).length > 0 ? ` (${(report.caps.fixedItems ?? []).map((i) => i.name).join(", ")})` : ""}; not on the usage bill`
          : "Fixed, an estimate (CLOUDFLARE_FIXED_MONTHLY_MICROS) until Cloudflare's list is read; not on the usage bill",
      in: null,
      cost: subscriptions,
      result: -subscriptions,
      tone: "muted",
    },
    ...(unmapped > 0
      ? [{ title: "Not mapped", note: "Billed by Cloudflare, charged for by nothing yet", in: null, cost: unmapped, result: -unmapped, tone: "danger" as const }]
      : []),
    {
      title: "Given away",
      note: givenParts.length > 0 ? givenParts.map(([why, micros]) => `${why} ${usd(micros, { cents: true })}`).join(" · ") : "Nothing this range",
      in: null,
      cost: given,
      result: null,
      tone: "muted",
    },
  ];
  const resultClass = (tone?: string) => (tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-muted" : "text-fg");
  return (
    <>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Margin on usage sold"
          value={percentLabel(usagePercent)}
          hint={soldSomething ? `${usd(usageIn, { cents: true })} paid for usage that cost ${usd(usageCost, { cents: true })}` : "No usage sold in this range"}
          tone={marginTone(usagePercent, floor)}
        />
        <Stat
          label="Given away on purpose"
          value={usd(given, { cents: true })}
          hint={givenParts.length > 0 ? givenParts.map(([why, micros]) => `${usd(micros, { cents: true })} ${why}`).join(", ") : "Nothing given this range"}
        />
        <Stat
          label="Who g1t paid"
          value={usd(o.costMicros, { cents: true })}
          hint={`Cloudflare ${usd(o.cloudflareCostMicros ?? o.costMicros - (o.modelsCostMicros ?? 0), { cents: true })}, model providers ${usd(o.modelsCostMicros ?? 0, { cents: true })}`}
        />
        <Stat
          label="Proposals waiting"
          value={String(proposals)}
          hint={
            <>
              <Link to={costsHref("bill", range) + "#proposals"} className="underline underline-offset-2">
                On Bill &amp; pricing
              </Link>
              {report.fetchedAt ? (
                <>
                  {" "}
                  · bill read <When at={report.fetchedAt} time />
                </>
              ) : (
                " · the bill has not been read yet"
              )}
            </>
          }
          tone={proposals > 0 ? "warn" : undefined}
        />
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium sm:px-5">
                {report.since} to {report.until}
              </th>
              <th className="px-4 py-2 text-right font-medium">Paid in</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
              <th className="px-4 py-2 text-right font-medium sm:pr-5">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.title} className="border-b border-line">
                <td className="px-4 py-2.5 sm:px-5">
                  <span className="text-fg">{row.title}</span>
                  <span className="block text-xs text-faint">{row.note}</span>
                </td>
                <td className="tabular px-4 py-2.5 text-right">{row.in == null ? <span className="text-faint">—</span> : usd(row.in, { cents: true })}</td>
                <td className="tabular px-4 py-2.5 text-right">{usd(row.cost, { cents: true })}</td>
                <td className={`tabular px-4 py-2.5 text-right sm:pr-5 ${resultClass(row.tone)}`}>
                  {row.result == null ? "a budget" : usd(row.result, { signed: true, cents: true })}
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-4 py-2.5 sm:px-5">
                <span className="font-medium text-fg">All in</span>
                <span className="block text-xs text-faint">
                  {given > 0 ? `${usd(given, { cents: true })} of the cost was given away on purpose; without it, ${usd(net + given, { signed: true, cents: true })}` : "Everything above"}
                </span>
              </td>
              <td className="tabular px-4 py-2.5 text-right font-medium">{usd(moneyIn, { cents: true })}</td>
              <td className="tabular px-4 py-2.5 text-right font-medium">{usd(spent, { cents: true })}</td>
              <td className="tabular px-4 py-2.5 text-right font-medium text-fg sm:pr-5">{usd(net, { signed: true, cents: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-faint">
        Credits from g1t, {report.since} to {report.until}: {usd(o.creditsGivenMicros ?? 0, { cents: true })} given, {usd(o.creditsUsedMicros ?? 0, { cents: true })}{" "}
        spent on usage. What promotional and goodwill credit paid for is given away above, never money in; refunds took{" "}
        {usd(o.creditsRefundedMicros ?? 0, { cents: true })} off money in on the days they refund.{" "}
        <Link to="/credits" className="underline underline-offset-2">
          Every credit
        </Link>
      </p>
    </>
  );
}

function SpendSection({ caps, error }: { caps: CostsReport["caps"]; error: string | null }) {
  const { rows, totalMicros } = spendRows(caps);
  const net = caps.revenueMicros - totalMicros;
  return (
    <Section
      className="mt-6"
      id="spend"
      title="g1t's own spend"
      description="What g1t pays for itself, at cost: accounts on a 100% discount, the trial and open-source pools, free workspaces' overruns, and anything charged without real money behind it. Two caps hold it: each 100%-discount account's monthly budget, and a daily breaker on all of it that pauses new hosted-model agent runs g1t would pay for."
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <CapMeter
          label={`Today, ${caps.day} (UTC)`}
          used={caps.todayMicros}
          cap={caps.dailyCapMicros}
          hint={
            caps.tripped ? (
              <span className="text-danger">
                Breaker open{caps.trippedAt ? <> since <When at={caps.trippedAt} time /></> : null}: new hosted-model runs g1t pays for wait until 00:00 UTC.
              </span>
            ) : caps.liftedBy ? (
              <>
                Lifted for today by {caps.liftedBy}
                {caps.liftNote ? `: “${caps.liftNote}”` : ""}.
              </>
            ) : (
              "Paying workspaces on a live card are never paused. PLATFORM_DAILY_SPEND_CAP_MICROS."
            )
          }
        />
        {caps.comped.map((b) => (
          <CapMeter
            key={b.account}
            label={`${b.name}, ${caps.month} (100% discount)`}
            used={b.usedMicros}
            cap={b.ceilingMicros}
            hint={
              <>
                {b.ceilingMicros > 0 && b.usedMicros >= b.ceilingMicros ? (
                  <span className="text-danger">Used up: new work on it is refused. </span>
                ) : null}
                {b.defaultCeiling ? "The default budget (COMPED_MONTHLY_CEILING_MICROS)" : "Its own budget, in its terms"}. Raise it on{" "}
                <Link to={`/workspaces/${encodeURIComponent(b.name)}#billing`} className="underline underline-offset-2">
                  its account
                </Link>
                : Terms, Limit.
              </>
            }
          />
        ))}
      </div>
      {(caps.tripped || error) && (
        <form method="post" action="#spend" className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="lift" />
          <Field label="Why lift it" hint="Recorded in the audit log.">
            <Input name="note" required minLength={5} maxLength={500} placeholder="e.g. Launch day; watching it" className="sm:min-w-[24rem]" />
          </Field>
          <Button type="submit" variant="danger">
            Lift for today
          </Button>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="-mx-4 mt-5 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium sm:px-5">{caps.month}, so far</th>
              <th className="px-4 py-2 text-right font-medium sm:pr-5">g1t paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line align-top">
                <td className="px-4 py-2.5 sm:px-5">
                  {row.title}
                  <span className="block text-xs text-faint">{row.note}</span>
                </td>
                <td className="tabular px-4 py-2.5 text-right sm:pr-5">{usd(row.micros)}</td>
              </tr>
            ))}
            <tr className="border-b border-line font-medium">
              <td className="px-4 py-2.5 sm:px-5">All of it</td>
              <td className="tabular px-4 py-2.5 text-right sm:pr-5">{usd(totalMicros)}</td>
            </tr>
            <tr className="border-b border-line">
              <td className="px-4 py-2.5 sm:px-5">
                Money in
                <span className="block text-xs text-faint">Usage paid for and the plan, reconciled through yesterday</span>
              </td>
              <td className="tabular px-4 py-2.5 text-right sm:pr-5">{usd(caps.revenueMicros)}</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 sm:px-5">Money in less what g1t paid</td>
              <td className={`tabular px-4 py-2.5 text-right sm:pr-5 ${net < 0 ? "text-danger" : "text-fg-soft"}`}>{usd(net, { signed: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  );
}

