/**
 * Log lines, as the Logs page, a request's page and a trace show them:
 * one row each (time, level, service, the line), opened for its
 * attributes and links to the request and trace it was written under.
 */
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { TelemetryLog } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { clock } from "../lib/observability";
import { LevelBadge } from "./observability";

export function LogLines({ logs, base, showRequest = true, fresh }: { logs: TelemetryLog[]; base: string; showRequest?: boolean; fresh?: Set<string> }) {
  return (
    <ol className="divide-y divide-line font-mono text-xs" aria-label="Log lines">
      {logs.map((log) => (
        <LogLine key={log.id} log={log} base={base} showRequest={showRequest} fresh={fresh?.has(log.id) ?? false} />
      ))}
    </ol>
  );
}

function LogLine({ log, base, showRequest, fresh }: { log: TelemetryLog; base: string; showRequest: boolean; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const attributes = Object.entries(log.attributes);
  const multiline = log.body.includes("\n");
  return (
    <li className={cn("group", log.severity === "error" || log.severity === "fatal" ? "bg-danger/5" : log.severity === "warn" ? "bg-warn/5" : "", fresh && "animate-[g1t-fresh_1.2s_ease-out]")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="grid w-full grid-cols-[1rem_8.5rem_3.25rem_minmax(0,1fr)] items-start gap-2 px-3 py-1.5 text-left hover:bg-raised/60 sm:grid-cols-[1rem_10.5rem_3.25rem_7rem_minmax(0,1fr)]"
      >
        <ChevronRight size={12} className={cn("mt-0.5 text-faint transition-transform", open && "rotate-90")} />
        <span className="text-faint tabular-nums">{clock(log.time_us, true).slice(6)}</span>
        <LevelBadge level={log.severity} />
        <span className="hidden truncate text-muted sm:block">{log.service || "—"}</span>
        <span className={cn("min-w-0 text-fg", open || !multiline ? "break-words whitespace-pre-wrap" : "truncate")}>{open ? log.body : log.body.split("\n")[0]}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pt-1 pb-3 pl-9">
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1">
            <dt className="text-faint">time</dt>
            <dd className="tabular-nums">{clock(log.time_us, true)} UTC</dd>
            {log.environment && (
              <>
                <dt className="text-faint">environment</dt>
                <dd>{log.environment}</dd>
              </>
            )}
            {log.deployment_id && (
              <>
                <dt className="text-faint">deployment</dt>
                <dd>
                  <Link to={`${base}/deployments/${log.deployment_id}`} className="text-accent hover:underline">
                    {log.deployment_id}
                  </Link>
                </dd>
              </>
            )}
            {showRequest && log.request_id && (
              <>
                <dt className="text-faint">request</dt>
                <dd>
                  <Link to={`${base}/observability/requests/${log.request_id}`} className="text-accent hover:underline">
                    {log.request_id}
                  </Link>
                </dd>
              </>
            )}
            {log.trace_id && (
              <>
                <dt className="text-faint">trace</dt>
                <dd>
                  <Link to={`${base}/observability/traces/${log.trace_id}`} className="text-accent hover:underline">
                    {log.trace_id}
                  </Link>
                </dd>
              </>
            )}
            {attributes.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-faint">{key}</dt>
                <dd className="break-all">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}
