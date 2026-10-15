import { Link } from "react-router";

import type { Route } from "./+types/observability-traces";
import { DurationBar, FilterBar, ObservabilityHeader, StatusBadge, useLoadingView } from "../../components/observability";
import { ButtonLink, EmptyState } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { clock, duration, viewHref } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";
import { Unavailable } from "../../components/boundary";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Traces · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter } = await observed(context, params, request);
  const search = new URL(request.url).searchParams;
  const errorsOnly = search.get("errors") === "1";
  const slow = Number(search.get("slow")) || null;
  const cursor = search.get("cursor");
  const [list, facets] = await Promise.all([
    soft(service.traces({ project_id: projectId, ...filter, text: view.q || null, errors_only: errorsOnly, min_duration_ms: slow, cursor, limit: 50 }), "traces"),
    soft(service.facets({ project_id: projectId }), "facets"),
  ]);
  return { view, list, facets, errorsOnly, slow, cursor };
}

const SLOW = [100, 500, 1000];

export default function Traces({ loaderData, params }: Route.ComponentProps) {
  const { view, list, facets, errorsOnly, slow, cursor } = loaderData;
  const base = `/${params.owner}/${params.repo}/observability`;
  const path = `${base}/traces`;
  const loading = useLoadingView();
  const extra = { errors: errorsOnly ? "1" : null, slow: slow ? String(slow) : null };
  const href = (change: Record<string, string | null>) => viewHref(path, view, { ...extra, ...change });
  const max = Math.max(1, ...(list?.items.map((t) => t.duration_us / 1000) ?? []));

  return (
    <div className="mx-auto max-w-6xl">
      <ObservabilityHeader
        title="Traces"
        about="Each request followed through the software it touched: the request on g1t.page, the spans its own code and every other service sent, and the logs written along the way."
      />
      <FilterBar
        path={path}
        view={view}
        environments={facets?.environments ?? []}
        services={facets?.services ?? []}
        search={{ placeholder: "Search span names   service:api   http.route=/users/:id", hint: "Words in span names, a field such as service:api, or attribute=value" }}
      >
        <nav className="flex rounded-md border border-line p-0.5 text-sm" aria-label="Slower than">
          {SLOW.map((ms) => (
            <Link
              key={ms}
              to={href({ slow: slow === ms ? null : String(ms) })}
              preventScrollReset
              aria-pressed={slow === ms}
              className={cn("rounded px-2 py-0.5 text-xs tabular-nums", slow === ms ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              &gt;{duration(ms)}
            </Link>
          ))}
        </nav>
        <Link
          to={href({ errors: errorsOnly ? null : "1" })}
          preventScrollReset
          aria-pressed={errorsOnly}
          className={cn("inline-flex h-8 items-center rounded-md border px-2.5 text-xs", errorsOnly ? "border-danger/40 bg-danger/10 text-danger" : "border-line text-muted hover:text-fg")}
        >
          With errors
        </Link>
      </FilterBar>

      <div className={cn("mt-4 transition-opacity", loading && "opacity-60")}>
        {!list ? (
          <Unavailable what="Traces" />
        ) : list.items.length === 0 ? (
          <EmptyState title={cursor ? "No older traces" : "No traces in this period"}>
            Traces come from OpenTelemetry spans. An app on g1t.page sends them as soon as it uses an OpenTelemetry SDK: its endpoint and token
            are set for it. Software elsewhere sends them with an ingest token.{" "}
            <a href="https://docs.g1t.sh/guides/observability/#traces" className="text-accent hover:underline">
              How
            </a>
          </EmptyState>
        ) : (
          <Card className="min-w-0 overflow-hidden">
            <Table frameProps={{ className: "rounded-none border-0" }}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Time (UTC)</TableHead>
                  <TableHead>Trace</TableHead>
                  <TableHead className="w-48">Services</TableHead>
                  <TableHead className="w-20 text-right">Spans</TableHead>
                  <TableHead className="w-44">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((t) => (
                  <TableRow key={t.trace_id} className="group">
                    <TableCell className="font-mono text-xs text-muted tabular-nums">{clock(t.start_us)}</TableCell>
                    <TableCell className="max-w-0">
                      <Link to={`${path}/${t.trace_id}`} className="flex min-w-0 items-center gap-2 group-hover:text-accent">
                        {t.status !== null && <StatusBadge status={t.status} />}
                        <span className="truncate font-mono text-xs">{t.name || t.trace_id}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {t.services.slice(0, 3).map((s) => (
                          <Badge key={s} tone="neutral" className="font-mono">
                            {s}
                          </Badge>
                        ))}
                        {t.services.length > 3 && <span className="text-xs text-faint">+{t.services.length - 3}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {t.span_count}
                      {t.error_count > 0 && <span className="ml-1.5 text-danger">{t.error_count} failed</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">{duration(t.duration_us / 1000)}</span>
                        <DurationBar ms={t.duration_us / 1000} max={max} failed={t.error_count > 0} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        {(list?.next || cursor) && (
          <div className="mt-4 flex justify-between">
            {cursor ? (
              <ButtonLink to={href({ cursor: null })} variant="outline" size="sm">
                Newest
              </ButtonLink>
            ) : (
              <span />
            )}
            {list?.next && (
              <ButtonLink to={href({ cursor: list.next })} variant="outline" size="sm">
                Older
              </ButtonLink>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
