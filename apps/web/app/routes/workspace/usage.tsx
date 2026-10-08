import { Suspense } from "react";
import { Await, Link, data } from "react-router";

import { PRODUCTS, type UsageReport } from "@g1t/contracts";

import type { Route } from "./+types/usage";
import { Breakdown, IncludedAndCredit, UsageChart, UsageFilterBar, type UsageFilters, UsageSkeleton } from "../../components/usage";
import { columns, defaultGrain, type Grain, type GroupBy, resolveRange } from "../../lib/usage";
import { page } from "../../lib/meta";
import { billing } from "../../lib/services.server";
import { getViewer, managesBilling, roleIn } from "../../lib/session.server";

/** Where the usage API is documented. */
export const USAGE_API = "https://docs.g1t.sh/reference/api/#usage";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Usage · ${params.owner} · g1t` });
}

/** The page's filters from its address: a filtered page is a link. */
export function readFilters(url: URL, fixedProject?: string): UsageFilters {
  const q = url.searchParams;
  const { period, from, until } = resolveRange(q.get("period"), { from: q.get("from"), until: q.get("until") });
  const known = new Set<string>(PRODUCTS.map((p) => p.key));
  const grain = q.get("grain");
  const group = q.get("group");
  return {
    period,
    from,
    until,
    products: q.getAll("product").filter((p) => known.has(p)),
    projects: fixedProject ? [fixedProject] : q.getAll("project").filter((p) => /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(p)).map((p) => p.toLowerCase()),
    group: group === "project" && !fixedProject ? "project" : group === "day" ? "day" : "product",
    grain: grain === "day" || grain === "week" || grain === "month" ? grain : defaultGrain(from, until),
    cumulative: q.get("cumulative") === "1",
  };
}

/** The address with one filter changed. */
export function hrefWith(url: string, change: Record<string, string | null>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(change)) {
    if (value == null) next.searchParams.delete(key);
    else next.searchParams.set(key, value);
  }
  return `${next.pathname}?${next.searchParams.toString()}`;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const filters = readFilters(url);
  // Streamed: the page's frame and filters come at once, each region's
  // skeleton holds its place, and the report fills them in.
  const report = billing
    .usageReport(slug, viewer, { from: filters.from, until: filters.until, products: filters.products, projects: filters.projects })
    .then((result) => (result.ok ? { report: result.value, error: null } : { report: null, error: result.error.message }));
  return { slug, owner: managesBilling(getViewer(context), slug), filters, url: url.toString(), report };
}

export function UsageView({
  slug,
  owner,
  filters,
  url,
  report,
  error,
  fixedProject,
}: {
  slug: string;
  owner: boolean;
  filters: UsageFilters;
  url: string;
  report: UsageReport | null;
  error: string | null;
  fixedProject?: string;
}) {
  const bar = (
    <UsageFilterBar
      filters={filters}
      products={[...PRODUCTS]}
      projects={report?.projects ?? filters.projects}
      report={report}
      apiHref={USAGE_API}
      fixedProject={fixedProject}
    />
  );
  if (!report) {
    return (
      <div className="space-y-6">
        {bar}
        <p className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-sm">{error ?? "Usage could not be read. Try again in a minute."}</p>
      </div>
    );
  }
  const cols = columns(report.days, report.from, report.until, filters.grain as Grain, filters.cumulative);
  return (
    <div className="space-y-6">
      {bar}
      {!fixedProject && <IncludedAndCredit report={report} billingHref={`/${slug}/-/billing`} owner={owner} />}
      <UsageChart
        columns={cols}
        products={report.products}
        grain={filters.grain}
        cumulative={filters.cumulative}
        grainHref={(grain) => hrefWith(url, { grain })}
        cumulativeHref={hrefWith(url, { cumulative: filters.cumulative ? null : "1" })}
      />
      <Breakdown report={report} group={filters.group as GroupBy} columns={cols} projectHref={fixedProject ? undefined : (project) => `/${project}/usage`} />
      <p className="text-xs text-faint">
        Every amount is usage at price: what was charged, plus what included usage, credit or a discount paid for it. Storage, git
        operations, scans and search are metered through the month and charged when it closes.
        {!fixedProject && (
          <>
            {" "}
            Each request your own code sent through the AI Gateway is listed on{" "}
            <Link to={`/${slug}/-/gateway`} className="hover:text-fg hover:underline">
              AI Gateway
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

export default function UsagePage({ loaderData }: Route.ComponentProps) {
  const { slug, owner, filters, url, report } = loaderData;
  return (
    <Suspense
      fallback={
        <UsageSkeleton>
          <UsageFilterBar filters={filters} products={[...PRODUCTS]} projects={filters.projects} report={null} apiHref={USAGE_API} />
        </UsageSkeleton>
      }
    >
      <Await resolve={report}>
        {(loaded) => <UsageView slug={slug} owner={owner} filters={filters} url={url} report={loaded.report} error={loaded.error} />}
      </Await>
    </Suspense>
  );
}
