/**
 * The Runners page's shaping: what runs on g1t's cloud now, what waits for
 * the workspace's own runners, and what each cost this month, from the
 * actions, work and billing services' own answers. Pure, so it can be
 * tested; the reads are in ./runners.server.ts.
 *
 * - **On g1t's cloud now** is the workspace's agent runs that are running
 *   (from the work service) and not handed to one of its own runners
 *   (`runner_activity`'s `handed_over`), and its workflow jobs running in
 *   g1t's sandboxes (`cloud_jobs`).
 * - **This month** is billing's usage report from the first of the month:
 *   agent sandbox time and sandbox time are g1t's cloud, at price;
 *   self-hosted runner time is the workspace's own, at $0.
 */
import type { AgentRun, MeterLine, Price, RunnerActivity, UsageReport } from "@g1t/contracts";

/** One thing running in one of g1t's sandboxes. */
export type CloudWork = {
  kind: "agent" | "workflow";
  id: string;
  /** What it is: a pull request's title, a job's name. */
  title: string;
  /** The run's kind for an agent (`implement`, `checks`…); the job's workflow run for a job. */
  detail: string;
  /** `owner/name`. */
  repo: string;
  href: string;
  startedAt: string | null;
};

export type CloudNow = {
  running: CloudWork[];
  /** Agent runs and workflow jobs waiting to start in g1t's sandboxes. */
  queued: number;
  /** A list reached its limit: there may be more than shown. */
  more: boolean;
};

/** Waiting for one of the workspace's own runners. */
export type OwnWaiting = { tasks: number; jobs: number };

/** This month's machine time, from billing's usage report. */
export type RunnerCost = {
  from: string;
  until: string;
  /** g1t's cloud: agent sandbox time and sandbox time. */
  cloudSeconds: number;
  /** At price, before what paid for it. */
  cloudMicros: number;
  /** The workspace's own runners: self-hosted runner time, always $0. */
  ownSeconds: number;
  /** g1t charges nothing for now: the figures are usage at cost. */
  free: boolean;
};

/** A price for time on g1t's cloud, per minute, from the price book. */
export type CloudPrice = { meter: string; title: string; unit: string; perMinuteMicros: number };

/** Billing's meters for machine time (`METERS` in services/billing/src/report.rs). */
export const CLOUD_METERS = ["agent_sandbox", "sandbox"] as const;
export const OWN_METER = "self_hosted";

/** The price book's meters for a sandbox's time: its parts when both are priced, else the one price. */
const PRICE_PARTS = ["sandbox_base_second", "sandbox_cpu_second"] as const;
const PRICE_WHOLE = "sandbox_second";

/** The repository page of an agent run. */
export function agentRunHref(repo: string, runId: string): string {
  return `/${repo}/agents/runs/${runId}`;
}

/** The page of a workflow run. */
export function workflowRunHref(repo: string, runId: string): string {
  return `/${repo}/actions/runs/${runId}`;
}

const repoName = (run: Pick<AgentRun, "repo">) => `${run.repo.namespace}/${run.repo.name}`;

/**
 * What runs on g1t's cloud now. `runs` are the workspace's active agent
 * runs (null when the work service did not answer); `activity` is the
 * actions service's (null when it did not). Null when neither answered.
 */
export function cloudNow(runs: AgentRun[] | null, activity: RunnerActivity | null, runLimit: number, jobLimit: number): CloudNow | null {
  if (!runs && !activity) return null;
  const handed = new Set((activity?.handed_over ?? []).map((task) => task.run_id).filter((id): id is string => !!id));
  const ours = (runs ?? []).filter((run) => !handed.has(run.id));
  const running: CloudWork[] = [
    ...ours
      .filter((run) => run.status === "running")
      .map((run) => ({
        kind: "agent" as const,
        id: run.id,
        title: run.title ?? (run.number != null ? `#${run.number}` : repoName(run)),
        detail: run.kind,
        repo: repoName(run),
        href: agentRunHref(repoName(run), run.id),
        startedAt: run.startedAt ?? run.createdAt,
      })),
    ...(activity?.cloud_jobs ?? []).map((job) => ({
      kind: "workflow" as const,
      id: job.id,
      title: job.name,
      detail: job.run_id,
      repo: job.repo,
      href: workflowRunHref(job.repo, job.run_id),
      startedAt: job.started_at,
    })),
  ].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const queued = ours.filter((run) => run.status === "queued").length + (activity?.cloud_jobs_queued ?? 0);
  const more = (runs?.length ?? 0) >= runLimit || (activity?.cloud_jobs.length ?? 0) >= jobLimit;
  return { running, queued, more };
}

/** What waits for one of the workspace's own runners: agent work not yet taken, and workflow jobs. */
export function ownWaiting(activity: RunnerActivity | null): OwnWaiting | null {
  if (!activity) return null;
  return { tasks: activity.handed_over.filter((task) => task.status === "queued").length, jobs: activity.self_hosted_jobs_queued };
}

/** This month's machine time from billing's usage report; null when billing did not answer. */
export function runnerCost(report: UsageReport | null): RunnerCost | null {
  if (!report) return null;
  const meters: MeterLine[] = report.products.flatMap((product) => product.meters);
  const sum = (keys: readonly string[], pick: (meter: MeterLine) => number) =>
    meters.filter((meter) => keys.includes(meter.key)).reduce((total, meter) => total + pick(meter), 0);
  return {
    from: report.from,
    until: report.until,
    cloudSeconds: sum(CLOUD_METERS, (meter) => meter.quantity),
    cloudMicros: sum(CLOUD_METERS, (meter) => meter.micros + (meter.pendingMicros ?? 0)),
    ownSeconds: sum([OWN_METER], (meter) => meter.quantity),
    free: report.free,
  };
}

/** The price of a minute on g1t's cloud, as the price book has it; null when it has none. */
export function cloudPrices(prices: Price[] | null): CloudPrice[] | null {
  if (!prices) return null;
  const perMinute = (price: Price): CloudPrice => ({
    meter: price.meter,
    title: price.title,
    unit: price.unit.replace(/second$/, "minute"),
    perMinuteMicros: price.priceMicros * 60,
  });
  const parts = PRICE_PARTS.map((meter) => prices.find((price) => price.meter === meter));
  if (parts.every(Boolean)) return parts.map((price) => perMinute(price!));
  const whole = prices.find((price) => price.meter === PRICE_WHOLE);
  return whole ? [perMinute(whole)] : null;
}

/** Seconds as people read machine time: "45s", "12 min", "3.4 h". */
export function machineTime(seconds: number): string {
  if (seconds <= 0) return "0 min";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 100) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours).toLocaleString("en-US")} h`;
}

/** A price per minute, to a tenth of a cent or finer: "$0.0012". */
export function perMinute(micros: number): string {
  if (micros <= 0) return "$0";
  const dollars = micros / 1_000_000;
  const digits = dollars >= 0.01 ? 3 : Math.min(6, Math.max(4, 2 - Math.floor(Math.log10(dollars))));
  return `$${dollars.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
}
