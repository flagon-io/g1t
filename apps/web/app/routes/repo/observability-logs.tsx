import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { LOG_SEVERITIES, type LogSeverity, type TelemetryLog } from "@g1t/contracts/telemetry";

import type { Route } from "./+types/observability-logs";
import { FilterBar, LiveDot, ObservabilityHeader, useLoadingView } from "../../components/observability";
import { LogLines } from "../../components/observability-logs";
import { ButtonLink, EmptyState } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { matchesLog, viewHref } from "../../lib/observability";
import { useTelemetryLive } from "../../lib/observability-live";
import { observed, soft } from "../../lib/observability.server";

/** The levels offered as toggles: trace and debug go with debug, fatal with error. */
const LEVELS: LogSeverity[] = ["debug", "info", "warn", "error"];
const WITH: Partial<Record<LogSeverity, LogSeverity[]>> = { debug: ["trace", "debug"], error: ["error", "fatal"] };
/** A live page keeps this many lines; older ones are a page away. */
const KEEP = 1000;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Logs · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter } = await observed(context, params, request);
  const search = new URL(request.url).searchParams;
  const levels = search.getAll("level").filter((l): l is LogSeverity => (LOG_SEVERITIES as readonly string[]).includes(l));
  const cursor = search.get("cursor");
  const [list, facets] = await Promise.all([
    soft(
      service.logs({
        project_id: projectId,
        ...filter,
        text: view.q || null,
        severities: levels.flatMap((l) => WITH[l] ?? [l]),
        cursor,
        limit: 300,
      }),
      "logs",
    ),
    soft(service.facets({ project_id: projectId }), "facets"),
  ]);
  return { view, list, facets, levels, cursor };
}

export default function Logs({ loaderData, params }: Route.ComponentProps) {
  const { view, list, facets, levels, cursor } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const path = `${base}/observability/logs`;
  const loading = useLoadingView();
  const [live, setLive] = useState(false);
  const [arrived, setArrived] = useState<TelemetryLog[]>([]);
  const [dropped, setDropped] = useState(0);
  // A new view starts the page over.
  useEffect(() => {
    setArrived([]);
    setDropped(0);
  }, [list]);
  const wanted = levels.flatMap((l) => WITH[l] ?? [l]);
  const state = useTelemetryLive(`${base}/observability/live`, live && !cursor, (items, lost) => {
    const fresh = items.flatMap((i) => (i.type === "log" && matchesLog(i.log, view, wanted) ? [i.log] : []));
    if (fresh.length) setArrived((before) => [...fresh.sort((a, b) => b.time_us - a.time_us), ...before].slice(0, KEEP));
    if (lost) setDropped((n) => n + lost);
  });
  const shown = useMemo(() => {
    const seen = new Set<string>();
    return [...arrived, ...(list?.items ?? [])].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true))).slice(0, KEEP);
  }, [arrived, list]);
  const fresh = useMemo(() => new Set(arrived.map((l) => l.id)), [arrived]);

  const levelHref = (level: LogSeverity) => {
    const next = levels.includes(level) ? levels.filter((l) => l !== level) : [...levels, level];
    const url = viewHref(path, view);
    return `${url}${next.length ? `${url.includes("?") ? "&" : "?"}${next.map((l) => `level=${l}`).join("&")}` : ""}`;
  };
  const pageHref = (c: string | null) => {
    const url = viewHref(path, view, { cursor: c });
    return `${url}${levels.length ? `${url.includes("?") ? "&" : "?"}${levels.map((l) => `level=${l}`).join("&")}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-6xl">
      <ObservabilityHeader title="Logs" about="Every line the project's software wrote, newest first. Search words, a level, or any attribute; follow it live.">
        {!cursor && (
          <div className="flex items-center gap-3">
            <LiveDot on={state === "live"} />
            <Button variant={live ? "secondary" : "outline"} size="sm" onClick={() => setLive(!live)} aria-pressed={live}>
              {live ? <Pause size={14} /> : <Play size={14} />}
              {live ? "Pause" : "Follow live"}
            </Button>
          </div>
        )}
      </ObservabilityHeader>
      <FilterBar
        path={path}
        view={view}
        environments={facets?.environments ?? []}
        services={facets?.services ?? []}
        search={{ placeholder: 'Search: timeout   level:error   user.id=42   "exact phrase"', hint: "Words to find, level:error, or attribute=value" }}
      >
        <nav className="flex rounded-md border border-line p-0.5 text-sm" aria-label="Levels">
          {LEVELS.map((level) => (
            <Link
              key={level}
              to={levelHref(level)}
              preventScrollReset
              aria-pressed={levels.includes(level)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize",
                levels.includes(level) ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {level}
            </Link>
          ))}
        </nav>
      </FilterBar>
      {state === "dropped" && <p className="mt-3 text-xs text-warn">The live connection dropped; reconnecting.</p>}
      {dropped > 0 && <p className="mt-3 text-xs text-faint">{dropped.toLocaleString("en-US")} lines arrived faster than the page shows them; search to find them.</p>}

      <div className={cn("mt-4 transition-opacity", loading && "opacity-60")}>
        {!list ? (
          <Card className="p-6 text-sm text-muted">Logs could not be loaded just now. Reload the page to try again.</Card>
        ) : shown.length === 0 ? (
          <EmptyState title={view.q || levels.length ? "No lines match" : "No logs in this period"}>
            {live ? "Following: new lines show here as they are written." : "Apps on g1t.page send what they write with console.log; anything else sends OpenTelemetry logs."}
          </EmptyState>
        ) : (
          <Card className="overflow-hidden">
            <LogLines logs={shown} base={base} fresh={fresh} />
          </Card>
        )}
        {(list?.next || cursor) && (
          <div className="mt-4 flex justify-between">
            {cursor ? (
              <ButtonLink to={pageHref(null)} variant="outline" size="sm">
                Newest
              </ButtonLink>
            ) : (
              <span />
            )}
            {list?.next && (
              <ButtonLink to={pageHref(list.next)} variant="outline" size="sm">
                Older
              </ButtonLink>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
