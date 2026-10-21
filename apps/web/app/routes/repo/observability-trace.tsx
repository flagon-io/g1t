import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, data } from "react-router";

import type { TelemetrySpan } from "@g1t/contracts";

import type { Route } from "./+types/observability-trace";
import { LogLines } from "../../components/observability-logs";
import { SourceBadge } from "../../components/observability";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { clock, duration } from "../../lib/observability";
import { observed } from "../../lib/observability.server";
import { spanTree } from "../../lib/observability-trace";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Trace ${params.trace.slice(0, 8)} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service } = await observed(context, params, request);
  if (!/^[0-9a-f]{32}$/.test(params.trace)) throw data(null, { status: 404 });
  const trace = await service.trace({ project_id: projectId, trace_id: params.trace });
  if (!trace) throw data(null, { status: 404 });
  return trace;
}

/** Each service keeps one of the site's categorical colors through the trace (lib/usage.ts). */
const SERVICE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export default function Trace({ loaderData, params }: Route.ComponentProps) {
  const { spans, logs, trace_id } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const rows = useMemo(() => spanTree(spans), [spans]);
  const start = Math.min(...spans.map((s) => s.start_us));
  const end = Math.max(...spans.map((s) => s.start_us + s.duration_us));
  const total = Math.max(1, end - start);
  const services = [...new Set(spans.map((s) => s.service))];
  const color = (service: string) => SERVICE_COLORS[services.indexOf(service) % SERVICE_COLORS.length]!;
  const [selected, setSelected] = useState<string | null>(rows[0]?.span.span_id ?? null);
  const chosen = spans.find((s) => s.span_id === selected) ?? null;
  const errors = spans.filter((s) => s.status === "error").length;

  return (
    <div className="mx-auto max-w-7xl">
      <Link to={`${base}/observability/traces`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft size={14} />
        Traces
      </Link>
      <header className="mt-3">
        <h1 className="truncate font-mono text-lg">{rows[0]?.span.name ?? trace_id}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-mono">{trace_id}</span>
          <span className="tabular-nums">{clock(start, true)} UTC</span>
          <span className="tabular-nums">{duration(total / 1000)}</span>
          <span>
            {spans.length} span{spans.length === 1 ? "" : "s"}
          </span>
          {errors > 0 && <span className="text-danger">{errors} failed</span>}
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Services">
          {services.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: color(s) }} />
              <span className="font-mono">{s || "(unnamed)"}</span>
            </li>
          ))}
        </ul>
      </header>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0 overflow-hidden">
          {/* The time ruler. */}
          <div className="grid grid-cols-[minmax(10rem,40%)_1fr] border-b border-line px-3 py-1.5 text-[0.6875rem] text-faint tabular-nums">
            <span>Span</span>
            <div className="relative h-4">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <span
                  key={f}
                  className={cn("absolute", f === 1 ? "right-0" : f === 0 ? "left-0" : "-translate-x-1/2")}
                  style={f > 0 && f < 1 ? { left: `${f * 100}%` } : undefined}
                >
                  {duration((total * f) / 1000)}
                </span>
              ))}
            </div>
          </div>
          <ol role="tree" aria-label="Spans">
            {rows.map(({ span, depth }) => {
              const left = ((span.start_us - start) / total) * 100;
              const width = Math.max(0.4, (span.duration_us / total) * 100);
              const on = span.span_id === selected;
              return (
                <li key={span.span_id} role="treeitem" aria-selected={on} aria-level={depth + 1}>
                  <button
                    type="button"
                    onClick={() => setSelected(span.span_id)}
                    className={cn(
                      "grid w-full grid-cols-[minmax(10rem,40%)_1fr] items-center gap-2 px-3 py-1 text-left text-xs hover:bg-raised/60",
                      on && "bg-raised",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 14 }}>
                      <span className="size-2 shrink-0 rounded-sm" style={{ background: color(span.service) }} />
                      <span className={cn("truncate font-mono", span.status === "error" && "text-danger")}>{span.name}</span>
                    </span>
                    <span className="relative block h-4">
                      <span
                        className={cn(
                          "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[3px]",
                          span.status === "error" && "ring-2 ring-danger ring-offset-1 ring-offset-bg",
                        )}
                        style={{ left: `${left}%`, width: `${width}%`, background: color(span.service) }}
                      />
                      <span
                        className="absolute top-1/2 -translate-y-1/2 pl-1 font-mono text-[0.6875rem] whitespace-nowrap text-muted tabular-nums"
                        style={left + width > 80 ? { right: `${100 - left}%`, paddingRight: 4 } : { left: `${left + width}%` }}
                      >
                        {duration(span.duration_us / 1000)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>

        <Card className="min-w-0 self-start p-4 lg:sticky lg:top-4">
          {chosen ? <SpanDetail span={chosen} /> : <p className="text-sm text-muted">Choose a span.</p>}
        </Card>
      </div>

      <section className="mt-6" aria-labelledby="logs-title">
        <h2 id="logs-title" className="text-sm font-semibold">
          Logs <span className="font-normal text-faint">{logs.length}</span>
        </h2>
        {logs.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing was written under this trace.</p>
        ) : (
          <Card className="mt-2 overflow-hidden">
            <LogLines logs={logs} base={base} />
          </Card>
        )}
      </section>
    </div>
  );
}

function SpanDetail({ span }: { span: TelemetrySpan }) {
  const sections: [string, Record<string, unknown>][] = [
    ["Attributes", span.attributes],
    ["Resource", span.resource],
  ];
  return (
    <div className="min-w-0 text-xs">
      <p className="font-mono text-sm break-all">{span.name}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone="neutral">{span.kind}</Badge>
        <Badge tone={span.status === "error" ? "danger" : span.status === "ok" ? "success" : "neutral"}>{span.status}</Badge>
        <SourceBadge source={span.source} />
      </div>
      {span.status_message && <p className="mt-2 text-danger">{span.status_message}</p>}
      <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-faint">Service</dt>
        <dd className="font-mono break-all">{span.service}</dd>
        <dt className="text-faint">Duration</dt>
        <dd className="tabular-nums">{duration(span.duration_us / 1000)}</dd>
        <dt className="text-faint">Span</dt>
        <dd className="font-mono">{span.span_id}</dd>
        {span.parent_span_id && (
          <>
            <dt className="text-faint">Parent</dt>
            <dd className="font-mono">{span.parent_span_id}</dd>
          </>
        )}
      </dl>
      {sections.map(([title, values]) =>
        Object.keys(values).length ? (
          <div key={title} className="mt-4">
            <p className="font-medium">{title}</p>
            <dl className="mt-1 space-y-1">
              {Object.entries(values).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="truncate font-mono text-faint">{k}</dt>
                  <dd className="font-mono break-all">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null,
      )}
      {span.events.length > 0 && (
        <div className="mt-4">
          <p className="font-medium">Events</p>
          <ul className="mt-1 space-y-2">
            {span.events.map((e, i) => (
              <li key={i}>
                <p className={cn("font-mono", e.name === "exception" && "text-danger")}>
                  {e.name} <span className="text-faint">+{duration((e.time_us - span.start_us) / 1000)}</span>
                </p>
                {Object.entries(e.attributes).map(([k, v]) => (
                  <p key={k} className="font-mono break-all whitespace-pre-wrap text-muted">
                    <span className="text-faint">{k}</span> {typeof v === "string" ? v : JSON.stringify(v)}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
