import { ArrowRight, Bug, Globe, Send } from "lucide-react";
import { Link } from "react-router";

import { TELEMETRY_OTLP_ENDPOINT, type TelemetryOverview } from "@g1t/contracts/telemetry";

import type { Route } from "./+types/observability";
import { FilterBar, ObservabilityHeader, StatTile, TimeChart, useLoadingView } from "../../components/observability";
import { ButtonLink, CopyLine, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { SERIES, count, duration, percent, shortId, viewHref } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Observability · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter, access } = await observed(context, params, request);
  const [overview, facets, errors] = await Promise.all([
    soft(service.overview({ project_id: projectId, ...filter }), "overview"),
    soft(service.facets({ project_id: projectId }), "facets"),
    soft(service.errors({ project_id: projectId, ...filter, state: "open" }), "errors"),
  ]);
  return { view, overview, facets, errors: errors?.slice(0, 5) ?? null, canManage: access.can.manage_integrations };
}

export default function Observability({ loaderData, params }: Route.ComponentProps) {
  const { view, overview, facets, errors, canManage } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const path = `${base}/observability`;
  const loading = useLoadingView();
  const nothing = overview && overview.totals.requests === 0 && overview.services.length === 0 && (facets?.services.length ?? 0) === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <ObservabilityHeader
        title="Observability"
        about="What the project's running software does: its requests, errors and latency, by deployment. Apps on g1t.page report on their own; anything else sends OpenTelemetry."
      />
      <FilterBar path={path} view={view} environments={facets?.environments ?? []} services={facets?.services ?? []} />

      <div className={cn("mt-6 transition-opacity", loading && "opacity-60")}>
        {!overview ? (
          <Card className="p-6 text-sm text-muted">Observability could not be loaded just now. Reload the page to try again.</Card>
        ) : nothing ? (
          <GetStarted base={base} canManage={canManage} />
        ) : (
          <Loaded overview={overview} errors={errors} base={base} path={path} view={view} />
        )}
      </div>
    </div>
  );
}

function Loaded({
  overview,
  errors,
  base,
  path,
  view,
}: {
  overview: TelemetryOverview;
  errors: Route.ComponentProps["loaderData"]["errors"];
  base: string;
  path: string;
  view: Route.ComponentProps["loaderData"]["view"];
}) {
  const { totals, points } = overview;
  // The period before is compared only when it had enough requests to say something.
  const enough = overview.previous.requests >= Math.max(30, totals.requests * 0.05);
  const previous = enough
    ? overview.previous
    : { requests: null, errors: null, error_rate: null, latency: { p50: null, p75: null, p95: null, p99: null }, cpu: { p50: null, p75: null, p95: null, p99: null } };
  const times = points.map((p) => p.time_us);
  const anyCpu = totals.cpu.p50 !== null;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Requests" value={count(totals.requests)} now={totals.requests} before={previous.requests} />
        <StatTile label="Error rate" value={percent(totals.error_rate)} now={totals.error_rate} before={previous.error_rate} lowerIsBetter detail={`${count(totals.errors)} failed`} />
        <StatTile label="Latency p50" value={duration(totals.latency.p50)} now={totals.latency.p50} before={previous.latency.p50} lowerIsBetter />
        <StatTile label="Latency p95" value={duration(totals.latency.p95)} now={totals.latency.p95} before={previous.latency.p95} lowerIsBetter />
        <StatTile
          label={anyCpu ? "CPU time p50" : "Latency p99"}
          value={duration(anyCpu ? totals.cpu.p50 : totals.latency.p99)}
          now={anyCpu ? totals.cpu.p50 : totals.latency.p99}
          before={anyCpu ? previous.cpu.p50 : previous.latency.p99}
          lowerIsBetter
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <TimeChart
          title="Requests"
          kind="bars"
          times={times}
          stepS={overview.step_s}
          format={count}
          series={[
            // Whatever did not fail as a 4xx or a 5xx (requests with no status, such as a cron, count here too).
            { key: "ok", label: "2xx and 3xx", color: SERIES.ok, values: points.map((p) => Math.max(0, p.requests - p.status_4xx - Math.max(p.status_5xx, p.errors))) },
            { key: "4xx", label: "4xx", color: SERIES.client, values: points.map((p) => p.status_4xx) },
            { key: "5xx", label: "5xx and failures", color: SERIES.server, values: points.map((p) => Math.max(p.status_5xx, p.errors)) },
          ]}
          action={
            <Link to={viewHref(`${path}/requests`, view)} className="text-xs text-muted hover:text-fg">
              Requests <ArrowRight size={12} className="inline" />
            </Link>
          }
        />
        <TimeChart
          title="Latency"
          kind="lines"
          times={times}
          stepS={overview.step_s}
          format={(n) => duration(n)}
          series={[
            { key: "p50", label: "p50", color: SERIES.p50, values: points.map((p) => p.latency.p50) },
            { key: "p95", label: "p95", color: SERIES.p95, values: points.map((p) => p.latency.p95) },
            { key: "p99", label: "p99", color: SERIES.p99, values: points.map((p) => p.latency.p99) },
          ]}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card asChild className="min-w-0 lg:col-span-2">
          <section aria-labelledby="deployments-title">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 id="deployments-title" className="text-sm font-medium">
                By deployment
              </h2>
              <span className="hidden text-xs text-faint sm:inline">Newest first: a change in the numbers starts with the deployment that brought it.</span>
            </div>
            {overview.deployments.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No deployment on g1t.page served requests in this period.</p>
            ) : (
              <Table frameProps={{ className: "rounded-none border-0" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deployment</TableHead>
                    <TableHead className="hidden sm:table-cell">Environment</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Error rate</TableHead>
                    <TableHead className="text-right">p95</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.deployments.map((d, i) => {
                    const rate = d.requests ? d.errors / d.requests : 0;
                    const before = overview.deployments[i + 1];
                    const worse = before && before.requests > 20 && d.requests > 20 && rate > (before.errors / before.requests) * 1.5 + 0.005;
                    return (
                      <TableRow key={d.deployment_id}>
                        <TableCell>
                          <Link to={viewHref(path, view, { deployment: d.deployment_id })} className="font-mono text-xs hover:text-accent">
                            {d.commit_sha ? shortId(d.commit_sha, 7) : shortId(d.deployment_id, 12)}
                          </Link>
                          <span className="ml-2 text-xs whitespace-nowrap text-faint">
                            <TimeAgo at={d.first_us / 1000} />
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted sm:table-cell">{d.environment ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(d.requests)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", worse && "text-danger")}>{percent(rate)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">{duration(d.latency.p95)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </section>
        </Card>

        <Card asChild className="min-w-0">
          <section aria-labelledby="errors-title">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 id="errors-title" className="flex items-center gap-2 text-sm font-medium">
                <Bug size={14} className="text-faint" />
                Open errors
              </h2>
              <Link to={viewHref(`${path}/errors`, view)} className="text-xs text-muted hover:text-fg">
                All <ArrowRight size={12} className="inline" />
              </Link>
            </div>
            {!errors || errors.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">No open errors in this period.</p>
            ) : (
              <ul className="divide-y divide-line">
                {errors.map((e) => (
                  <li key={e.fingerprint} className="px-4 py-2.5">
                    <Link to={`${path}/errors#${e.fingerprint}`} className="block min-w-0 hover:text-accent">
                      <p className="truncate font-mono text-xs">{e.name}</p>
                      <p className="truncate text-sm text-muted">{e.message}</p>
                    </Link>
                    <p className="mt-0.5 text-xs text-faint tabular-nums">
                      {count(e.count)} times · last <TimeAgo at={e.last_us / 1000} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Card>
      </div>

      <Card asChild className="mt-3 min-w-0">
        <section aria-labelledby="routes-title">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id="routes-title" className="text-sm font-medium">
              Routes
            </h2>
            <span className="hidden text-xs text-faint sm:inline">Paths with their ids taken out, busiest first</span>
          </div>
          {overview.routes.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No requests in this period.</p>
          ) : (
            <Table frameProps={{ className: "rounded-none border-0" }}>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Error rate</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">p50</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">p99</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.routes.slice(0, 15).map((r) => (
                  <TableRow key={`${r.method} ${r.route}`}>
                    <TableCell className="w-1/2 max-w-[10rem] sm:max-w-0">
                      <Link
                        to={viewHref(`${path}/requests`, view, { route: r.route })}
                        className="flex min-w-0 items-center gap-2 font-mono text-xs hover:text-accent"
                      >
                        {r.method && <span className="shrink-0 text-faint">{r.method}</span>}
                        <span className="truncate">{r.route || "/"}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.requests)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", r.errors > 0 && "text-danger")}>{percent(r.requests ? r.errors / r.requests : 0)}</TableCell>
                    <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{duration(r.latency.p50)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{duration(r.latency.p95)}</TableCell>
                    <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{duration(r.latency.p99)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </Card>

      {(overview.services.length > 1 || overview.regions.length > 0) && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {overview.services.length > 0 && (
            <Card asChild className="min-w-0">
              <section aria-labelledby="services-title">
                <h2 id="services-title" className="border-b border-line px-4 py-3 text-sm font-medium">
                  Services
                </h2>
                <ul className="divide-y divide-line">
                  {overview.services.map((s) => (
                    <li key={`${s.service}-${s.source}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                      <Link to={viewHref(path, view, { service: s.service })} className="flex min-w-0 items-center gap-2 hover:text-accent">
                        <span className="truncate font-mono text-xs">{s.service || "(unnamed)"}</span>
                        <Badge tone="neutral">{s.source === "cloudflare" ? "g1t.page" : "OTLP"}</Badge>
                      </Link>
                      <span className="shrink-0 text-xs text-muted tabular-nums">
                        {count(s.requests)} · {percent(s.requests ? s.errors / s.requests : 0)} failed
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </Card>
          )}
          {overview.regions.length > 0 && (
            <Card asChild className="min-w-0">
              <section aria-labelledby="regions-title">
                <h2 id="regions-title" className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium">
                  <Globe size={14} className="text-faint" />
                  Where requests were served
                </h2>
                <ul className="space-y-1.5 px-4 py-3">
                  {overview.regions.slice(0, 8).map((r) => {
                    const share = r.requests / Math.max(1, overview.regions.reduce((n, x) => n + x.requests, 0));
                    return (
                      <li key={r.region} className="grid grid-cols-[3rem_1fr_4rem] items-center gap-3 text-xs">
                        <span className="font-mono">{r.region}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
                        </span>
                        <span className="text-right text-muted tabular-nums">{percent(share)}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </Card>
          )}
        </div>
      )}
      <p className="mt-4 text-xs text-faint">
        Numbers are counted each minute; the newest minute fills in as its requests finish. <Link to={`${base}/observability/logs`} className="underline hover:text-fg">Logs</Link> and{" "}
        <Link to={`${base}/observability/requests`} className="underline hover:text-fg">requests</Link> arrive within seconds.
      </p>
    </>
  );
}

/** Nothing has arrived yet: the two ways it does. */
function GetStarted({ base, canManage }: { base: string; canManage: boolean }) {
  return (
    <Card asChild>
      <section>
        <div className="border-b border-line px-6 py-5">
          <h2 className="font-medium">Nothing has arrived yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Requests, logs, traces and metrics show here as the project's software sends them, kept for its retention and counted for
            its charts.
          </p>
        </div>
        <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="min-w-0 p-6">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Globe size={14} className="text-accent" />
              Deployed on g1t.page
            </h3>
            <p className="mt-1.5 text-sm text-muted">
              Nothing to set up. Every request an app on g1t.page answers arrives here with its logs, exceptions, status and CPU time, and
              an OpenTelemetry SDK in the app sends its spans here without configuration.
            </p>
            <ButtonLink to={`${base}/deployments`} variant="outline" size="sm" className="mt-4">
              Deployments
            </ButtonLink>
          </div>
          <div className="min-w-0 p-6">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Send size={14} className="text-accent" />
              Running anywhere else
            </h3>
            <p className="mt-1.5 text-sm text-muted">
              Send OpenTelemetry (OTLP over HTTP, JSON or protobuf) from any SDK or collector, with one of the project's ingest tokens.
            </p>
            <div className="mt-3">
              <CopyLine text={TELEMETRY_OTLP_ENDPOINT} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {canManage && (
                <ButtonLink to={`${base}/observability/settings`} size="sm">
                  Make an ingest token
                </ButtonLink>
              )}
              <ButtonLink to="https://docs.g1t.sh/guides/observability/" variant="outline" size="sm">
                How to send
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </Card>
  );
}
