import { ChevronLeft, GitCommitHorizontal, Waypoints } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/observability-request";
import { LogLines } from "../../components/observability-logs";
import { StatusBadge, SourceBadge } from "../../components/observability";
import { ButtonLink } from "../../components/ui";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Card } from "../../components/ui/card";
import { page } from "../../lib/meta";
import { clock, duration, shortId } from "../../lib/observability";
import { observed } from "../../lib/observability.server";
import { outcomeWords } from "../../lib/observability-words";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Request ${params.id} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service } = await observed(context, params, request);
  const found = await service.request({ project_id: projectId, id: params.id });
  if (!found) throw data(null, { status: 404 });
  return found;
}

export default function RequestPage({ loaderData, params }: Route.ComponentProps) {
  const { request: r, logs } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const facts: [string, React.ReactNode][] = [
    ["Time", <span className="font-mono tabular-nums">{clock(r.time_us, true)} UTC</span>],
    ["Duration", duration(r.duration_us / 1000)],
    ["CPU time", r.cpu_ms === null ? "—" : duration(r.cpu_ms)],
    ["Outcome", outcomeWords(r.outcome)],
    ["Served from", [r.region, r.country].filter(Boolean).join(" · ") || "—"],
    ["Trigger", r.trigger],
    ["Service", <span className="font-mono">{r.service || "—"}</span>],
    ["Environment", r.environment ?? "—"],
  ];
  return (
    <div>
      <Link to={`${base}/observability/requests`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft size={14} />
        Requests
      </Link>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex min-w-0 items-center gap-3 font-mono text-lg">
            <StatusBadge status={r.status} outcome={r.outcome} />
            <span className="shrink-0 text-faint">{r.method ?? r.trigger}</span>
            <span className="truncate">{r.url ?? r.route}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
            <span className="font-mono">{r.id}</span>
            <SourceBadge source={r.source} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.trace_id && (
            <ButtonLink to={`${base}/observability/traces/${r.trace_id}`} variant="outline" size="sm">
              <Waypoints size={14} />
              Trace
            </ButtonLink>
          )}
          {r.deployment_id && (
            <ButtonLink to={`${base}/deployments/${r.deployment_id}`} variant="outline" size="sm">
              <GitCommitHorizontal size={14} />
              {r.commit_sha ? shortId(r.commit_sha, 7) : "Deployment"}
            </ButtonLink>
          )}
        </div>
      </header>

      {r.error && (
        <Alert className="mt-5">
          <AlertTitle className="font-mono">{r.error.name}</AlertTitle>
          <AlertDescription>{r.error.message}</AlertDescription>
        </Alert>
      )}

      <Card className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-0.5 truncate text-sm">{value}</p>
          </div>
        ))}
      </Card>

      <section className="mt-6" aria-labelledby="logs-title">
        <h2 id="logs-title" className="text-sm font-semibold">
          Logs <span className="font-normal text-faint">{logs.length}</span>
        </h2>
        {logs.length === 0 ? (
          <p className="mt-2 text-sm text-muted">It wrote nothing.</p>
        ) : (
          <Card className="mt-2 overflow-hidden">
            <LogLines logs={logs} base={base} showRequest={false} />
          </Card>
        )}
      </section>
    </div>
  );
}
