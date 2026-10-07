import type { ReactNode } from "react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import type { CostsReport, PriceProposal } from "@g1t/contracts";

import type { Route } from "./+types/costs";
import { DaysChart } from "~/components/costs";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, Stat, When } from "~/components/ui";
import {
  capPercent,
  countLabel,
  daySeries,
  driftLabel,
  marginTone,
  parseBucket,
  parseCostSettings,
  parseMapping,
  parseRange,
  percentLabel,
  spendRows,
  unitDollars,
} from "~/lib/costs";
import { dollarsField, usd } from "~/lib/money";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Costs & margin · sudo" }, { name: "robots", content: "noindex, nofollow" }];

const DONE: Record<string, string> = {
  run: "Ran the analysis: read Cloudflare's bill, reconciled the last 31 days and checked the alerts. The figures below are fresh.",
  approved: "Approved. A fall applies now; a rise after the notice period, and owners on the plan are emailed.",
  rejected: "Rejected, with the note kept for whoever measures it next.",
  settings: "Guardrails saved. They apply from the next run.",
  mapping: "Mapping saved. It applies from the next run; read the bill now to see it.",
  removed: "Mapping removed.",
  lifted: "Breaker lifted for the rest of today (UTC). Hosted-model runs start again; it is recorded in the audit log.",
};

const RANGES = [7, 30, 90];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("days"));
  const report = await settle(admin.costs(range));
  const done = url.searchParams.get("done");
  return {
    range,
    bucket: url.searchParams.get("product"),
    report: report.ok ? report.value : null,
    error: report.ok ? null : report.error,
    done: done ? (DONE[done] ?? null) : null,
  };
}

type ActionResult = { error: string; section: string; values?: Record<string, string> };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (section: string, error: string) =>
    data<ActionResult>({ error, section, values: Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])) }, { status: 422 });
  const back = (done: string, hash = "") => {
    const url = new URL(request.url);
    url.searchParams.set("done", done);
    return redirect(`${url.pathname}${url.search}${hash}`);
  };
  if (intent === "run") {
    const run = await settle(admin.runCosts(staff.email));
    if (!run.ok) return fail("run", `Billing did not answer: ${run.error}`);
    if (!run.value.ok) return fail("run", run.value.error.message);
    if (run.value.value.problems.length > 0) return fail("run", run.value.value.problems.join(" "));
    throw back("run");
  }
  if (intent === "lift") {
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    if (note.length < 5) return fail("lift", "Say why it is lifted, for whoever looks next.");
    const result = await settle(admin.liftBreaker(note, staff.email));
    if (!result.ok) return fail("lift", `Billing did not answer: ${result.error}`);
    if (!result.value.ok) return fail("lift", result.value.error.message);
    throw back("lifted", "#spend");
  }
  if (intent === "decide") {
    const id = String(form.get("id") ?? "");
    const decision = form.get("decision") === "approve" ? "approve" : "reject";
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    if (decision === "reject" && note.length < 5) return fail(`proposal-${id}`, "Say why it is rejected, for whoever measures it next.");
    const result = await admin.decideProposal(id, decision, note, staff.email);
    if (!result.ok) return fail(`proposal-${id}`, result.error.message);
    throw back(decision === "approve" ? "approved" : "rejected", "#proposals");
  }
  if (intent === "settings") {
    const parsed = parseCostSettings(form);
    if (!parsed.ok) return fail("settings", parsed.error);
    const result = await admin.setCostSettings(parsed.value, staff.email);
    if (!result.ok) return fail("settings", result.error.message);
    throw back("settings", "#guardrails");
  }
  if (intent === "mapping") {
    const parsed = parseMapping(form);
    if (!parsed.ok) return fail("mapping", parsed.error);
    const result = await admin.setCostMapping(parsed.value, staff.email);
    if (!result.ok) return fail("mapping", result.error.message);
    throw back(parsed.value.remove ? "removed" : "mapping", "#mappings");
  }
  return fail("run", "Unknown change.");
}

function chip(active: boolean) {
  return `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
    active ? "border-merged/50 bg-merged/10 text-merged" : "border-line text-muted hover:border-line-strong hover:text-fg"
  }`;
}

function href(range: number, bucket: string | null) {
  const params = new URLSearchParams();
  if (range !== 30) params.set("days", String(range));
  if (bucket) params.set("product", bucket);
  const query = params.toString();
  return query ? `/costs?${query}` : "/costs";
}

export default function Costs({ loaderData, actionData }: Route.ComponentProps) {
  const { range, report, error, done } = loaderData;
  const failed = actionData && "error" in actionData ? (actionData as ActionResult) : null;
  if (!report) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <PageHeader title="Costs & margin" />
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
  // Margin under the floor at the top; drift and leaks are in their own table, workspaces on Reach out.
  const banner = report.alerts.filter((a) => a.kind === "overall" || a.kind === "margin");
  const elsewhere = report.alerts.length - banner.length;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Costs & margin"
        description="What g1t cost to run (Cloudflare's bill and the model providers') against what workspaces paid. Prices are cost plus 20%; this is where that is checked against the bill, where drift and leaks show, and where price changes wait for a decision."
        actions={<RunButton />}
      />
      <nav aria-label="Range" className="mt-5 flex flex-wrap gap-2">
        {RANGES.map((days) => (
          <Link key={days} to={href(days, bucket)} aria-current={days === range ? "page" : undefined} className={chip(days === range)}>
            Last {days} days
          </Link>
        ))}
      </nav>
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {failed?.section === "run" && <Notice tone="error">{failed.error}</Notice>}
        {!report.configured && (
          <Notice tone="warn">
            Billing cannot read Cloudflare's bill: set the <code className="font-mono">CLOUDFLARE_BILLING_TOKEN</code> secret on g1t-billing (Account:
            Billing Read and Account Analytics Read). Until then the figures are g1t's own, and Cloudflare's cost shows as nothing.
          </Notice>
        )}
        {banner.map((alert) => (
          <Notice key={alert.id} tone="error">
            {alert.detail} <span className="text-faint">Since {alert.since}.</span>
          </Notice>
        ))}
        {elsewhere > 0 && (
          <p className="text-xs text-muted">
            {elsewhere} more open: {" "}
            <a href="#drift" className="underline underline-offset-2">
              drift and leaks
            </a>{" "}
            below, and workspaces that cost more than they pay on{" "}
            <Link to="/reach-out?kind=cost_over_revenue" className="underline underline-offset-2">
              Reach out
            </Link>
            .
          </p>
        )}
      </div>

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
          <Link to={href(range, null)} aria-current={!bucket ? "page" : undefined} className={chip(!bucket)}>
            All of g1t
          </Link>
          {report.products.map((p) => (
            <Link key={p.bucket} to={href(range, p.bucket)} aria-current={p.bucket === bucket ? "page" : undefined} className={chip(p.bucket === bucket)}>
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
                      <Link to={href(range, p.bucket)} className="text-fg hover:underline">
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

function CapMeter({ label, used, cap, hint }: { label: string; used: number; cap: number; hint: ReactNode }) {
  const percent = capPercent(used, cap);
  const tone = cap > 0 && used >= cap ? "bg-danger" : percent >= 75 ? "bg-warn" : "bg-merged";
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

/** g1t's own spend: the daily breaker, comped budgets, and this month by what paid. */
/** The button that runs the nightly analysis now, saying so while it runs. */
function RunButton() {
  const navigation = useNavigation();
  const running = navigation.state !== "idle" && navigation.formData?.get("intent") === "run";
  return (
    <Form method="post" className="flex items-center gap-3">
      <input type="hidden" name="intent" value="run" />
      <Button variant="quiet" type="submit" disabled={running}>
        {running ? "Running the analysis…" : "Run the analysis now"}
      </Button>
      {running && <span className="text-xs text-muted">Reading the bill and reconciling 31 days; about a minute.</span>}
    </Form>
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
  const usageMargin = o.usageMarginMicros ?? o.usageMicros - usageCost;
  const usagePercent = o.usageMarginPercent !== undefined ? o.usageMarginPercent : null;
  const running = o.runningCostMicros ?? 0;
  const unmapped = o.unmappedCostMicros ?? 0;
  // Cloudflare's subscriptions are not on the usage bill: the estimate, over the range.
  const subscriptions = Math.round((report.caps.fixedMonthlyMicros * range) / 30);
  const moneyIn = o.usageMicros + o.plansMicros;
  const spent = o.costMicros + subscriptions;
  const net = moneyIn - spent;
  const givenParts = [
    ["comped", o.givenCompedMicros ?? 0],
    ["free use", o.givenFreeMicros ?? 0],
    ["trial", o.givenTrialMicros ?? 0],
    ["open-source pool", o.givenPoolMicros ?? 0],
  ].filter(([, micros]) => (micros as number) > 0) as [string, number][];
  const rows: { title: string; note: string; in: number | null; cost: number; result: number | null; tone?: "danger" | "warn" | "muted" }[] = [
    {
      title: "Usage sold",
      note: "What workspaces paid for usage, against what that usage cost",
      in: o.usageMicros,
      cost: usageCost,
      result: usageMargin,
      tone: usageMargin < 0 ? "danger" : undefined,
    },
    {
      title: "Running g1t",
      note: "Plans, against Workers, D1, KV, Queues and the rest of the platform",
      in: o.plansMicros,
      cost: running,
      result: o.plansMicros - running,
      tone: o.plansMicros - running < 0 ? "warn" : undefined,
    },
    {
      title: "Cloudflare subscriptions",
      note: "Fixed, an estimate (CLOUDFLARE_FIXED_MONTHLY_MICROS), not on the usage bill",
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
      note: givenParts.length > 0 ? givenParts.map(([why, micros]) => `${why} ${usd(micros)}`).join(" · ") : "Nothing this range",
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
          hint={`${usd(o.usageMicros)} paid for usage that cost ${usd(usageCost)}`}
          tone={marginTone(usagePercent, floor)}
        />
        <Stat
          label="Given away on purpose"
          value={usd(given)}
          hint={givenParts.length > 0 ? givenParts.map(([why, micros]) => `${usd(micros)} ${why}`).join(", ") : "Nothing given this range"}
        />
        <Stat
          label="Who g1t paid"
          value={usd(o.costMicros)}
          hint={`Cloudflare ${usd(o.cloudflareCostMicros ?? o.costMicros - (o.modelsCostMicros ?? 0))}, model providers ${usd(o.modelsCostMicros ?? 0)}`}
        />
        <Stat
          label="Proposals waiting"
          value={String(proposals)}
          hint={report.fetchedAt ? <>Bill read <When at={report.fetchedAt} time /></> : "The bill has not been read yet"}
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
                <td className="tabular px-4 py-2.5 text-right">{row.in == null ? <span className="text-faint">—</span> : usd(row.in)}</td>
                <td className="tabular px-4 py-2.5 text-right">{usd(row.cost)}</td>
                <td className={`tabular px-4 py-2.5 text-right sm:pr-5 ${resultClass(row.tone)}`}>
                  {row.result == null ? "a budget" : usd(row.result, { signed: true })}
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-4 py-2.5 sm:px-5">
                <span className="font-medium text-fg">All in</span>
                <span className="block text-xs text-faint">
                  {given > 0 ? `${usd(given)} of the cost was given away on purpose; without it, ${usd(net + given, { signed: true })}` : "Everything above"}
                </span>
              </td>
              <td className="tabular px-4 py-2.5 text-right font-medium">{usd(moneyIn)}</td>
              <td className="tabular px-4 py-2.5 text-right font-medium">{usd(spent)}</td>
              <td className="tabular px-4 py-2.5 text-right font-medium text-fg sm:pr-5">{usd(net, { signed: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>
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
      description="What g1t pays for itself, at cost: comped accounts, the trial and open-source pools, free workspaces' overruns, and anything charged without real money behind it. Two caps hold it: each comped account's monthly budget, and a daily breaker on all of it that pauses new hosted-model agent runs g1t would pay for."
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
            label={`${b.name}, ${caps.month} (comped)`}
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
