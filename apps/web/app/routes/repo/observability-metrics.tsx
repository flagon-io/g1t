import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/observability-metrics";
import { FilterBar, ObservabilityHeader, TimeChart, useLoadingView } from "../../components/observability";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { SelectField } from "../../components/ui/select";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { duration, viewHref } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";
import { PRODUCT_STYLE } from "../../lib/usage";

const AGGREGATES = ["avg", "sum", "min", "max", "p50", "p95", "p99"] as const;
type Aggregate = (typeof AGGREGATES)[number];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Metrics · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter } = await observed(context, params, request);
  const search = new URL(request.url).searchParams;
  const [metrics, facets] = await Promise.all([soft(service.metrics({ project_id: projectId }), "metrics"), soft(service.facets({ project_id: projectId }), "facets")]);
  const name = search.get("name") ?? metrics?.[0]?.name ?? null;
  const info = metrics?.find((m) => m.name === name) ?? null;
  const aggregate = AGGREGATES.find((a) => a === search.get("agg")) ?? (info?.kind === "sum" ? "sum" : "avg");
  const groupBy = search.get("by") || null;
  const series = name ? await soft(service.metric({ project_id: projectId, ...filter, name, aggregate, group_by: groupBy }), "metric") : null;
  return { view, metrics, facets, name, info, aggregate, groupBy, series };
}

/** A value in its unit: durations read as durations, bytes as bytes. */
function formatter(unit: string): (n: number) => string {
  if (unit === "ms") return (n) => duration(n);
  if (unit === "s") return (n) => duration(n * 1000);
  if (unit === "us" || unit === "µs") return (n) => duration(n / 1000);
  if (unit === "By") return (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${Math.round(n)} B`);
  return (n) => `${n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 })}${unit && unit !== "1" && !unit.startsWith("{") ? ` ${unit}` : ""}`;
}

export default function Metrics({ loaderData, params }: Route.ComponentProps) {
  const { view, metrics, facets, name, info, aggregate, groupBy, series } = loaderData;
  const path = `/${params.owner}/${params.repo}/observability/metrics`;
  const navigate = useNavigate();
  const loading = useLoadingView();
  const extra = { name, agg: aggregate, by: groupBy };
  const go = (change: Record<string, string | null>) => navigate(viewHref(path, view, { ...extra, ...change }), { preventScrollReset: true });
  const aggregates: Aggregate[] = info?.kind === "histogram" ? [...AGGREGATES] : AGGREGATES.filter((a) => !a.startsWith("p"));

  return (
    <div className="mx-auto max-w-6xl">
      <ObservabilityHeader title="Metrics" about="Every metric the project's software sends with OpenTelemetry: counters, gauges and histograms, over time." />
      <FilterBar path={path} view={view} environments={facets?.environments ?? []} services={facets?.services ?? []} />

      <div className={cn("mt-4 transition-opacity", loading && "opacity-60")}>
        {!metrics ? (
          <Card className="p-6 text-sm text-muted">Metrics could not be loaded just now. Reload the page to try again.</Card>
        ) : metrics.length === 0 ? (
          <EmptyState title="No metrics yet">
            Request counts, errors and latency are on the Overview already. Metrics of your own arrive from an OpenTelemetry SDK's metric exporter,
            with an ingest token.{" "}
            <a href="https://docs.g1t.sh/guides/observability/#metrics" className="text-accent hover:underline">
              How
            </a>
          </EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <Card asChild className="min-w-0 self-start overflow-hidden">
              <nav aria-label="Metrics">
                <ul className="max-h-128 divide-y divide-line overflow-auto">
                  {metrics.map((m) => (
                    <li key={m.name}>
                      <Link
                        to={viewHref(path, view, { name: m.name })}
                        preventScrollReset
                        aria-current={m.name === name ? "page" : undefined}
                        className={cn("block px-3 py-2 hover:bg-raised/60", m.name === name && "bg-raised")}
                      >
                        <span className="block truncate font-mono text-xs">{m.name}</span>
                        <span className="text-[0.6875rem] text-faint">
                          {m.kind}
                          {m.unit ? ` · ${m.unit}` : ""} · <TimeAgo at={m.last_us / 1000} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </Card>
            <div className="min-w-0">
              {info && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <p className="mr-auto min-w-0 text-sm text-muted">{info.description || <span className="font-mono">{info.name}</span>}</p>
                  <SelectField
                    aria-label="Aggregate"
                    size="sm"
                    className="w-28"
                    value={aggregate}
                    onValueChange={(value) => go({ agg: value })}
                    options={aggregates.map((a) => ({ value: a, label: a }))}
                  />
                  <SelectField
                    aria-label="Group by"
                    size="sm"
                    className="w-44"
                    value={groupBy ?? "*"}
                    onValueChange={(value) => go({ by: value === "*" ? null : value })}
                    options={[
                      { value: "*", label: "No grouping" },
                      { value: "service", label: "By service" },
                      ...(facets?.attribute_keys ?? []).slice(0, 50).map((k) => ({ value: k, label: `By ${k}` })),
                    ]}
                  />
                </div>
              )}
              {series && (
                <TimeChart
                  title={`${series.name} (${aggregate})`}
                  kind="lines"
                  times={series.series[0]?.points.map((p) => p.time_us) ?? []}
                  stepS={series.step_s}
                  format={formatter(series.unit)}
                  series={series.series.slice(0, PRODUCT_STYLE.length).map((s, i) => ({
                    key: s.group ?? "all",
                    label: s.group ?? series.name,
                    color: PRODUCT_STYLE[i]!.color,
                    values: s.points.map((p) => p.value),
                  }))}
                  empty="No points in this period."
                />
              )}
              {series && series.series.length > PRODUCT_STYLE.length && (
                <p className="mt-2 text-xs text-faint">Showing the first {PRODUCT_STYLE.length} of {series.series.length} groups.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
