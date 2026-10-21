import { FileText } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/observability-requests";
import { DurationBar, FilterBar, ObservabilityHeader, StatusBadge, useLoadingView } from "../../components/observability";
import { ButtonLink, EmptyState } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { clock, duration, shortId, viewHref } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";
import { Unavailable } from "../../components/boundary";

const STATUSES = ["2xx", "3xx", "4xx", "5xx"] as const;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Requests · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter } = await observed(context, params, request);
  const search = new URL(request.url).searchParams;
  const status = search.getAll("status").filter((s) => (STATUSES as readonly string[]).includes(s));
  const errorsOnly = search.get("errors") === "1";
  const route = search.get("route");
  const cursor = search.get("cursor");
  const [list, facets] = await Promise.all([
    soft(service.requests({ project_id: projectId, ...filter, text: view.q || null, status, errors_only: errorsOnly, route, cursor, limit: 100 }), "requests"),
    soft(service.facets({ project_id: projectId }), "facets"),
  ]);
  return { view, list, facets, status, errorsOnly, route, cursor };
}

export default function Requests({ loaderData, params }: Route.ComponentProps) {
  const { view, list, facets, status, errorsOnly, route, cursor } = loaderData;
  const base = `/${params.owner}/${params.repo}/observability`;
  const path = `${base}/requests`;
  const loading = useLoadingView();
  const extra = { route, errors: errorsOnly ? "1" : null };
  const href = (change: Record<string, string | null>) => {
    const url = viewHref(path, view, { ...extra, ...change });
    return change.status === undefined && status.length ? `${url}${url.includes("?") ? "&" : "?"}${status.map((s) => `status=${s}`).join("&")}` : url;
  };
  const max = Math.max(1, ...(list?.items.map((r) => r.duration_us / 1000) ?? []));

  return (
    <div className="mx-auto max-w-7xl">
      <ObservabilityHeader
        title="Requests"
        about="Each request the project's software answered, newest first, with what it wrote under it. Search the address or the error."
      />
      <FilterBar
        path={path}
        view={view}
        environments={facets?.environments ?? []}
        services={facets?.services ?? []}
        search={{
          placeholder: "Search: /checkout   status:502   region:AMS   deployment_id:…",
          hint: "Search the address and the error, or narrow by a field: status:502, method:POST, region:AMS",
        }}
      >
        <nav className="flex rounded-md border border-line p-0.5 text-sm" aria-label="Status">
          {STATUSES.map((s) => {
            const on = status.includes(s);
            const next = on ? status.filter((x) => x !== s) : [...status, s];
            const url = viewHref(path, view, extra);
            return (
              <Link
                key={s}
                to={`${url}${next.length ? `${url.includes("?") ? "&" : "?"}${next.map((x) => `status=${x}`).join("&")}` : ""}`}
                preventScrollReset
                aria-pressed={on}
                className={cn("rounded px-2 py-0.5 font-mono text-xs", on ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {s}
              </Link>
            );
          })}
        </nav>
        <Link
          to={href({ errors: errorsOnly ? null : "1" })}
          preventScrollReset
          aria-pressed={errorsOnly}
          className={cn(
            "inline-flex h-8 items-center rounded-md border px-2.5 text-xs",
            errorsOnly ? "border-danger/40 bg-danger/10 text-danger" : "border-line text-muted hover:text-fg",
          )}
        >
          Failed only
        </Link>
      </FilterBar>
      {route && (
        <p className="mt-3 text-sm text-muted">
          Route <code className="font-mono text-fg">{route}</code>{" "}
          <Link to={href({ route: null })} className="text-accent hover:underline">
            Show every route
          </Link>
        </p>
      )}

      <div className={cn("mt-4 transition-opacity", loading && "opacity-60")}>
        {!list ? (
          <Unavailable what="Requests" />
        ) : list.items.length === 0 ? (
          <EmptyState title={cursor ? "No older requests" : "No requests match"}>
            Requests of apps on g1t.page arrive within seconds of being answered; others arrive with their server spans.
          </EmptyState>
        ) : (
          <Card className="min-w-0 overflow-hidden">
            <Table frameProps={{ className: "rounded-none border-0" }}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Time (UTC)</TableHead>
                  <TableHead className="w-16">Status</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead className="w-40">Duration</TableHead>
                  <TableHead className="w-20 text-right">CPU</TableHead>
                  <TableHead className="w-16">Region</TableHead>
                  <TableHead className="w-24">Deployment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((r) => {
                  const ms = r.duration_us / 1000;
                  const failed = r.error !== null || (r.status ?? 0) >= 500;
                  return (
                    <TableRow key={r.id} className="group">
                      <TableCell className="font-mono text-xs text-muted tabular-nums">{clock(r.time_us)}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} outcome={r.outcome} />
                      </TableCell>
                      <TableCell className="max-w-0">
                        <Link to={`${base}/requests/${r.id}`} className="flex min-w-0 items-center gap-2 font-mono text-xs group-hover:text-accent">
                          <span className="w-12 shrink-0 text-faint">{r.method ?? r.trigger}</span>
                          <span className="truncate">{r.url ?? r.route ?? r.trigger}</span>
                          {r.log_count > 0 && (
                            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-faint" aria-label={`${r.log_count} log lines`}>
                              <FileText size={11} />
                              {r.log_count}
                            </span>
                          )}
                        </Link>
                        {r.error && (
                          <p className="mt-0.5 truncate text-xs text-danger">
                            {r.error.name}: {r.error.message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">{duration(ms)}</span>
                          <DurationBar ms={ms} max={max} failed={failed} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted tabular-nums">{r.cpu_ms === null ? "—" : duration(r.cpu_ms)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted">{r.region ?? "—"}</TableCell>
                      <TableCell className="max-w-24 truncate font-mono text-xs whitespace-nowrap text-muted">
                        {r.deployment_id ? (
                          <Link to={href({ deployment: r.deployment_id })} className="hover:text-fg">
                            {r.commit_sha ? shortId(r.commit_sha, 7) : shortId(r.deployment_id, 10)}
                          </Link>
                        ) : (
                          r.service || "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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
