/**
 * What both costs pages open with: the title, the run button, the two
 * tabs, the range, and what needs attention.
 */
import { Link } from "react-router";

import type { CostsReport } from "@g1t/contracts";

import { Button, Notice, PageHeader } from "~/components/ui";

export const RANGES = [7, 30, 90];

export function chip(active: boolean) {
  return `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
    active ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"
  }`;
}

/** A costs page's address with its range (and, on Costs & margin, its product). */
export function costsHref(page: "costs" | "bill", range: number, bucket: string | null = null) {
  const params = new URLSearchParams();
  if (range !== 30) params.set("days", String(range));
  if (bucket && page === "costs") params.set("product", bucket);
  const query = params.toString();
  const path = page === "costs" ? "/costs" : "/costs/bill";
  return query ? `${path}?${query}` : path;
}

const TABS = [
  { page: "costs", title: "Costs & margin" },
  { page: "bill", title: "Bill & pricing" },
] as const;

export function CostsHeader({
  page,
  range,
  report,
  done,
  runError,
  description,
}: {
  page: "costs" | "bill";
  range: number;
  report: CostsReport | null;
  done: string | null;
  runError: string | null;
  description: string;
}) {
  // Margin under the floor at the top of Costs & margin; drift and leaks
  // at the top of Bill & pricing; workspaces on Reach out.
  const alerts = report?.alerts ?? [];
  const here = alerts.filter((a) => (page === "costs" ? a.kind === "overall" || a.kind === "margin" : a.kind === "drift" || a.kind === "leak"));
  const drift = alerts.filter((a) => a.kind === "drift" || a.kind === "leak").length;
  const workspaces = alerts.filter((a) => a.kind === "workspace").length;
  const margin = alerts.filter((a) => a.kind === "overall" || a.kind === "margin").length;
  return (
    <>
      <PageHeader title={TABS.find((t) => t.page === page)!.title} description={description} actions={<RunButton />} />
      <nav aria-label="Costs" className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-b border-line">
        {TABS.map((tab) => (
          <Link
            key={tab.page}
            to={costsHref(tab.page, range)}
            aria-current={tab.page === page ? "page" : undefined}
            className={`-mb-px border-b-2 pb-2 text-sm ${tab.page === page ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {tab.title}
          </Link>
        ))}
      </nav>
      <nav aria-label="Range" className="mt-4 flex flex-wrap gap-2">
        {RANGES.map((days) => (
          <Link key={days} to={costsHref(page, days)} aria-current={days === range ? "page" : undefined} className={chip(days === range)}>
            Last {days} days
          </Link>
        ))}
      </nav>
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {runError && <Notice tone="error">{runError}</Notice>}
        {report && !report.configured && (
          <Notice tone="warn">
            Billing cannot read Cloudflare's bill: set the <code className="font-mono">CLOUDFLARE_BILLING_TOKEN</code> secret on g1t-billing (Account:
            Billing Read and Account Analytics Read). Until then the figures are g1t's own, and Cloudflare's cost shows as nothing.
          </Notice>
        )}
        {here.map((alert) => (
          <Notice key={alert.id} tone={alert.kind === "drift" ? "warn" : "error"}>
            {alert.detail} <span className="text-faint">Since {alert.since}.</span>
          </Notice>
        ))}
        {page === "costs" && (drift > 0 || workspaces > 0) && (
          <p className="text-xs text-muted">
            Also open:{" "}
            {drift > 0 && (
              <Link to={costsHref("bill", range) + "#drift"} className="underline underline-offset-2">
                {drift} on Bill &amp; pricing
              </Link>
            )}
            {drift > 0 && workspaces > 0 && ", "}
            {workspaces > 0 && (
              <Link to="/reach-out?kind=cost_over_revenue" className="underline underline-offset-2">
                {workspaces} workspace{workspaces === 1 ? "" : "s"} on Reach out
              </Link>
            )}
            .
          </p>
        )}
        {page === "bill" && margin > 0 && (
          <p className="text-xs text-muted">
            Also open:{" "}
            <Link to={costsHref("costs", range)} className="underline underline-offset-2">
              margin under the floor on Costs &amp; margin
            </Link>
            .
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The button that runs the nightly analysis now. sudo runs no JavaScript,
 * so app.css's run-button rules say it is running while the page waits.
 */
function RunButton() {
  return (
    <form method="post" className="flex items-center gap-3">
      <input type="hidden" name="intent" value="run" />
      <Button variant="quiet" type="submit" className="run-button">
        <span className="run-idle">Run the analysis now</span>
        <span className="run-busy">
          <span className="run-spinner" aria-hidden="true" />
          Running the analysis…
        </span>
      </Button>
      <span className="run-note text-xs text-muted">Reading the bill and reconciling 31 days; about a minute.</span>
    </form>
  );
}
