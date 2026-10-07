import { type ReactNode } from "react";

import type { CostsReport, PriceProposal } from "@g1t/contracts";

import type { Route } from "./+types/costs-bill";
import { CostsHeader } from "~/components/costs-header";
import { Badge, Button, EmptyState, Field, Input, Notice, Section, When } from "~/components/ui";
import { countLabel, driftLabel, percentLabel, unitDollars } from "~/lib/costs";
import { type CostsActionResult, costsAction, costsLoader } from "~/lib/costs-route.server";
import { dollarsField, usd } from "~/lib/money";

export const meta: Route.MetaFunction = () => [{ title: "Bill & pricing · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export const loader = ({ request, context }: Route.LoaderArgs) => costsLoader(request, context);
export const action = ({ request, context }: Route.ActionArgs) => costsAction(request, context);

/**
 * Cloudflare's bill as read, what does not add up against it, and the
 * price book: proposals, versions, mappings and the guardrails on them.
 */
export default function CostsBill({ loaderData, actionData }: Route.ComponentProps) {
  const { range, report, error, done } = loaderData;
  const failed = actionData && "error" in actionData ? (actionData as CostsActionResult) : null;
  const description =
    "Cloudflare's bill as read, line by line, what does not add up against g1t's own counts and price book, and the prices themselves: proposals waiting for a decision, every version, the mappings and the guardrails.";
  if (!report) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <CostsHeader page="bill" range={range} report={null} done={null} runError={null} description={description} />
        <div className="mt-5">
          <Notice tone="warn">Billing did not answer for costs: {error}</Notice>
        </div>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <CostsHeader page="bill" range={range} report={report} done={done} runError={failed?.section === "run" ? failed.error : null} description={description} />

      <Section
        className="mt-5"
        id="drift"
        title="Drift"
        description="Over the last 7 days: counts g1t and Cloudflare disagree on past a mapping's threshold, a bill far from the price book's cost of the same usage, and leaks (cost nothing charges for, or a Cloudflare meter no one mapped)."
      >
        {report.drift.length === 0 ? (
          <p className="text-sm text-muted">Nothing has drifted.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:px-5">Product</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 text-right font-medium">g1t</th>
                  <th className="px-4 py-2 text-right font-medium">Cloudflare</th>
                  <th className="px-4 py-2 text-right font-medium sm:pr-5">Delta</th>
                </tr>
              </thead>
              <tbody>
                {report.drift.map((d) => {
                  const money = d.kind !== "count";
                  return (
                    <tr key={`${d.bucket}-${d.kind}`} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5 sm:px-5">
                        {d.title}
                        <span className="mt-0.5 block max-w-md text-xs text-faint">{d.detail.replace(`${d.title}: `, "")}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={d.kind === "leak" ? "danger" : "warn"}>{driftLabel(d.kind)}</Badge>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{money ? usd(d.ours) : countLabel(d.ours)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{money ? usd(d.cloudflare) : countLabel(d.cloudflare)}</td>
                      <td className="tabular px-4 py-2.5 text-right sm:pr-5">{percentLabel(d.deltaPercent, { signed: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        className="mt-6"
        id="proposals"
        title="Price proposals"
        description={`What the keeper and the reconciler measured. Moves within ${report.settings.autoApplyPercent}% apply themselves${report.settings.autoApply ? "" : " (off now)"}; larger ones wait here. A fall applies at once; a rise after ${report.settings.noticeDays} days' notice, and a monthly meter's from the start of the next month.`}
      >
        {report.proposals.length === 0 ? (
          <p className="text-sm text-muted">No proposals yet.</p>
        ) : (
          <ul className="space-y-3">
            {report.proposals.map((p) => (
              <ProposalRow key={p.id} proposal={p} error={failed?.section === `proposal-${p.id}` ? failed.error : null} />
            ))}
          </ul>
        )}
      </Section>

      <Section className="mt-6" title="Price versions" description="Every price as it was and will be. A version never changes once written; each charge records the version it was made at.">
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium sm:px-5">Meter</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium sm:pr-5">Why</th>
              </tr>
            </thead>
            <tbody>
              {report.versions.map((v) => (
                <tr key={v.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2.5 sm:px-5">
                    <span className="font-mono text-xs">{v.meter}</span> <span className="text-faint">v{v.version}</span>
                    {!v.appliedAt && (
                      <span className="ml-2">
                        <Badge tone="info">Coming</Badge>
                      </span>
                    )}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">{unitDollars(v.costMicros)}</td>
                  <td className="tabular px-4 py-2.5 text-right">{unitDollars(v.priceMicros)}</td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    <When at={v.effectiveAt} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint sm:pr-5">
                    {v.reason} · {v.createdBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        className="mt-6"
        title="Cloudflare's lines"
        description="Every meter Cloudflare billed or counted in the range, as it named it, and which of g1t's products it is a cost of. Not mapped means no one decided what pays for it."
      >
        {report.lines.length === 0 ? (
          <EmptyState title="No lines yet">The bill is read once a day at 04:17 UTC, or now with “Run the analysis now”.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:px-5">Product / meter</th>
                  <th className="px-4 py-2 text-right font-medium">Quantity</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                  <th className="px-4 py-2 font-medium sm:pr-5">Cost of</th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr key={`${l.source}-${l.product}-${l.meter}`} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2.5 sm:px-5">
                      <span className="font-mono text-xs">
                        {l.product} / {l.meter}
                      </span>
                      <span className="block text-xs text-faint">
                        {l.rawName}
                        {l.source === "artifacts_events" ? " (Artifacts' own count)" : ""}
                      </span>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {countLabel(l.quantity)} <span className="text-xs text-faint">{l.unit}</span>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{usd(l.costMicros)}</td>
                    <td className="px-4 py-2.5 sm:pr-5">{l.bucket ? <span className="text-fg-soft">{l.bucket}</span> : <Badge tone="danger">Not mapped</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        className="mt-6"
        id="mappings"
        title="Mappings"
        description="Which of g1t's products each Cloudflare meter is a cost of. The longest matching meter prefix wins; * is the rest of the product. A price meter is measured from it; an own meter is g1t's count to compare; scaling prices one of g1t's units at as many of Cloudflare's as it took."
      >
        <MappingsTable report={report} />
        <form method="post" action="#mappings" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="intent" value="mapping" />
          <Field label="Cloudflare product">
            <Input name="product" placeholder="artifacts" defaultValue={failed?.section === "mapping" ? failed.values?.product : ""} required />
          </Field>
          <Field label="Meter prefix" hint="Or * for all of it">
            <Input name="meter" placeholder="*" defaultValue={failed?.section === "mapping" ? failed.values?.meter : ""} />
          </Field>
          <Field label="g1t product">
            <Input name="bucket" placeholder="git" defaultValue={failed?.section === "mapping" ? failed.values?.bucket : ""} />
          </Field>
          <Field label="Drift threshold, %">
            <Input name="driftPercent" inputMode="decimal" placeholder="10" defaultValue={failed?.section === "mapping" ? failed.values?.driftPercent : ""} />
          </Field>
          <Field label="Price meter" hint="Optional">
            <Input name="priceMeter" placeholder="git_operations" defaultValue={failed?.section === "mapping" ? failed.values?.priceMeter : ""} />
          </Field>
          <Field label="Own meter" hint="Optional">
            <Input name="ownMeter" placeholder="git_operations" defaultValue={failed?.section === "mapping" ? failed.values?.ownMeter : ""} />
          </Field>
          <Field label="Note">
            <Input name="note" defaultValue={failed?.section === "mapping" ? failed.values?.note : ""} />
          </Field>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" name="scaleToOwn" className="accent-[var(--g1t-merged)]" /> Scale to g1t's count
            </label>
            <div className="flex gap-2">
              <Button type="submit">Save mapping</Button>
              <Button type="submit" name="remove" value="1" variant="danger">
                Remove
              </Button>
            </div>
          </div>
          {failed?.section === "mapping" && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Notice tone="error">{failed.error}</Notice>
            </div>
          )}
        </form>
      </Section>

      <Section className="mt-6" id="guardrails" title="Guardrails" description="What may change prices without a person, and when staff hear about margin.">
        <form method="post" action="#guardrails" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="intent" value="settings" />
          <Field label="Apply small moves on their own">
            <label className="flex h-[38px] items-center gap-2 text-sm text-fg-soft">
              <input type="checkbox" name="autoApply" defaultChecked={report.settings.autoApply} className="accent-[var(--g1t-merged)]" /> On
            </label>
          </Field>
          <Field label="Up to, either way, %">
            <Input name="autoApplyPercent" inputMode="decimal" defaultValue={String(report.settings.autoApplyPercent)} />
          </Field>
          <Field label="Notice for a rise, days">
            <Input name="noticeDays" inputMode="numeric" defaultValue={String(report.settings.noticeDays)} />
          </Field>
          <Field label="Margin floor, %">
            <Input name="marginFloorPercent" inputMode="decimal" defaultValue={String(report.settings.marginFloorPercent)} />
          </Field>
          <Field label="Alert after, days in a row">
            <Input name="alertDays" inputMode="numeric" defaultValue={String(report.settings.alertDays)} />
          </Field>
          <Field label="Ignore days costing under, $">
            <Input name="minDailyCost" inputMode="decimal" defaultValue={dollarsField(report.settings.minDailyCostMicros)} />
          </Field>
          <Field label="Flag a workspace costing more than its revenue ×">
            <Input name="anomalyFactor" inputMode="decimal" defaultValue={String(report.settings.anomalyFactor)} />
          </Field>
          <Field label="And at least, $">
            <Input name="anomalyFloor" inputMode="decimal" defaultValue={dollarsField(report.settings.anomalyFloorMicros)} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            {failed?.section === "settings" && (
              <div className="mb-3">
                <Notice tone="error">{failed.error}</Notice>
              </div>
            )}
            <Button type="submit">Save guardrails</Button>
          </div>
        </form>
      </Section>
    </main>
  );
}

function ProposalRow({ proposal: p, error }: { proposal: PriceProposal; error: string | null }) {
  const rise = p.proposedCostMicros > p.currentCostMicros;
  const statusTone = p.status === "open" ? "warn" : p.status === "rejected" || p.status === "superseded" ? "plain" : "mint";
  return (
    <li className="rounded-md border border-line px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{p.title}</span> <span className="font-mono text-xs text-faint">{p.meter}</span>
        </div>
        <div className="flex items-center gap-2">
          {p.suspect && <Badge tone="danger">Far off: look first</Badge>}
          <Badge tone={statusTone}>{p.status}</Badge>
        </div>
      </div>
      <p className="tabular mt-1.5 text-sm">
        Cost {unitDollars(p.currentCostMicros)} → <span className={rise ? "text-warn" : "text-accent"}>{unitDollars(p.proposedCostMicros)}</span> per {p.unit || "unit"}{" "}
        <span className="text-faint">({percentLabel(p.changePercent, { signed: true })})</span>
      </p>
      <p className="mt-1 text-xs text-muted">{p.reason}</p>
      <p className="mt-1 text-xs text-faint">
        From the {p.source}, <When at={p.createdAt} time />
        {p.decidedBy ? ` · ${p.status} by ${p.decidedBy}` : ""}
        {p.effectiveAt ? (
          <>
            {" "}
            · in force from <When at={p.effectiveAt} />
          </>
        ) : null}
        {p.note ? ` · “${p.note}”` : ""}
      </p>
      {p.status === "open" && (
        <form method="post" action="#proposals" className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="intent" value="decide" />
          <input type="hidden" name="id" value={p.id} />
          <Input name="note" placeholder="A note (needed to reject)" className="sm:max-w-sm" />
          <div className="flex gap-2">
            <Button type="submit" name="decision" value="approve" variant="lavender">
              Approve
            </Button>
            <Button type="submit" name="decision" value="reject" variant="quiet">
              Reject
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="mt-2">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </li>
  );
}

function MappingsTable({ report }: { report: CostsReport }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium sm:px-5">Cloudflare</th>
            <th className="px-4 py-2 font-medium">g1t product</th>
            <th className="px-4 py-2 font-medium">Price meter</th>
            <th className="px-4 py-2 font-medium">Own meter</th>
            <th className="px-4 py-2 text-right font-medium sm:pr-5">Drift at</th>
          </tr>
        </thead>
        <tbody>
          {report.mappings.map((m) => (
            <tr key={`${m.product}-${m.meter}`} className="border-b border-line align-top last:border-0">
              <td className="px-4 py-2 sm:px-5">
                <span className="font-mono text-xs">
                  {m.product} / {m.meter}
                </span>
                {m.note && <span className="block text-xs text-faint">{m.note}</span>}
              </td>
              <td className="px-4 py-2 text-fg-soft">{m.bucket}</td>
              <td className="px-4 py-2 font-mono text-xs text-muted">{m.priceMeter ?? "—"}</td>
              <td className="px-4 py-2 font-mono text-xs text-muted">
                {m.ownMeter ?? "—"}
                {m.scaleToOwn && <span className="block font-sans text-faint">scaled</span>}
              </td>
              <td className="tabular px-4 py-2 text-right text-muted sm:pr-5">{m.driftPercent}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
