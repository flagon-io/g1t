/**
 * A repository's deployments at a glance, for a sidebar: each environment's
 * latest deployment and when, linking to the Deployments page. Also the
 * state icon and badge every page about deployments shares.
 */
import { Check, CircleDashed, CircleDot, Clock, Loader2, Rocket, X } from "lucide-react";
import { Link } from "react-router";

import type { DeploymentEnvironments, DeploymentSource, DeploymentState } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { SOURCE_LABEL, STATE_WORD, environmentLabel, orderEnvironments } from "../lib/deployments";
import { TimeAgo } from "./ui";

/** Environments listed before the rest are a link away. */
const SHOWN = 3;

/** The color a state is shown in. */
export const STATE_TONE: Record<DeploymentState, string> = {
  queued: "text-faint",
  in_progress: "text-warn",
  success: "text-success",
  failure: "text-danger",
  error: "text-danger",
  inactive: "text-faint",
};

/** A deployment's state as an icon: a check, a cross, a spinner, a clock. */
export function DeploymentStateIcon({
  state,
  size = 16,
  className,
  over = false,
}: {
  state: DeploymentState;
  size?: number;
  className?: string;
  /** A past status a later one followed: under way then, over now, so it does not spin. */
  over?: boolean;
}) {
  const label = STATE_WORD[state];
  switch (state) {
    case "success":
      return (
        <span role="img" aria-label={label} className={cn("inline-flex shrink-0 rounded-full bg-success/15 p-0.5 text-success", className)}>
          <Check size={size - 4} strokeWidth={3} />
        </span>
      );
    case "failure":
    case "error":
      return (
        <span role="img" aria-label={label} className={cn("inline-flex shrink-0 rounded-full bg-danger/15 p-0.5 text-danger", className)}>
          <X size={size - 4} strokeWidth={3} />
        </span>
      );
    case "in_progress":
      if (over) return <CircleDot size={size} aria-label={label} className={cn("shrink-0 text-faint", className)} />;
      return <Loader2 size={size} aria-label={label} className={cn("shrink-0 animate-spin text-warn", className)} />;
    case "queued":
      return <Clock size={size} aria-label={label} className={cn("shrink-0 text-faint", className)} />;
    default:
      return <CircleDashed size={size} aria-label={label} className={cn("shrink-0 text-faint", className)} />;
  }
}

/** A state's icon and word together. */
export function DeploymentStateBadge({ state, size = 14, className }: { state: DeploymentState; size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", STATE_TONE[state], className)}>
      <DeploymentStateIcon state={state} size={size} />
      {STATE_WORD[state]}
    </span>
  );
}

/** What made a deployment, in words. */
export function sourceLabel(source: DeploymentSource): string {
  return SOURCE_LABEL[source];
}

export function DeploymentsPanel({
  base,
  summary,
  className,
}: {
  base: string;
  summary: DeploymentEnvironments | null;
  className?: string;
}) {
  if (!summary || summary.environments.length === 0) return null;
  const environments = orderEnvironments(summary.environments);
  const shown = environments.slice(0, SHOWN);
  const more = environments.length - shown.length;
  return (
    <section className={className} aria-labelledby="deployments-panel">
      <h2 id="deployments-panel" className="text-sm font-semibold">
        <Link to={`${base}/deployments`} className="inline-flex items-center gap-2 hover:text-accent">
          <Rocket size={14} className="text-faint" />
          Deployments
          <span className="rounded-full bg-line px-1.5 text-[0.6875rem] font-medium tabular-nums text-muted">
            {summary.total_count.toLocaleString("en-US")}
          </span>
        </Link>
      </h2>
      <ul className="mt-3 space-y-2 text-sm">
        {shown.map((env) => {
          const latest = env.latest;
          return (
            <li key={env.name} className="min-w-0">
              <Link
                to={latest ? `${base}/deployments/${latest.id}` : `${base}/deployments?environment=${encodeURIComponent(env.name)}#history`}
                className="group flex min-w-0 items-center gap-2"
              >
                {latest ? <DeploymentStateIcon state={latest.state} size={15} /> : <CircleDashed size={15} className="shrink-0 text-faint" />}
                <span className="min-w-0 truncate font-medium text-fg-soft group-hover:text-accent">{environmentLabel(env.name)}</span>
                <span className="shrink-0 text-xs text-faint">
                  · <TimeAgo at={latest?.updated_at ?? env.updated_at} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link to={`${base}/deployments`} className="mt-2.5 inline-block text-xs text-muted hover:text-fg">
          + {more} more {more === 1 ? "environment" : "environments"}
        </Link>
      )}
    </section>
  );
}
