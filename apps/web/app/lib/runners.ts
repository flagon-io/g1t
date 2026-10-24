/**
 * The Runners page's shaping: what runs on g1t's cloud now, what waits for
 * the workspace's own runners, and what each cost this month, from the
 * actions, work and billing services' own answers. Pure, so it can be
 * tested; the reads are in ./runners.server.ts.
 *
 * - **On g1t's cloud now** is the workspace's sandbox runs (checks, the
 *   merge queue, merge checks) that are running
 *   (from the work service) and not handed to one of its own runners
 *   (`runner_activity`'s `handed_over`), and its workflow jobs running in
 *   g1t's sandboxes (`cloud_jobs`).
 * - **This month** is billing's usage report from the first of the month:
 *   runner minutes by machine are g1t's cloud, at price (older months
 *   name sandbox time by the second, and agent sandbox time);
 *   self-hosted runner time is the workspace's own, at $0.
 */
import type { AgentRun, MeterLine, OfferedSize, Runner, RunnerActivity, UsageReport } from "@g1t/contracts";
import { machineSize, machines, sizesSaid } from "@g1t/contracts/instances";

/** One thing running in one of g1t's sandboxes. */
export type CloudWork = {
  kind: "agent" | "workflow";
  id: string;
  /** What it is: a pull request's title, a job's name. */
  title: string;
  /** The run's kind for a sandbox run (`checks`, `queue`…); the job's workflow run for a job. */
  detail: string;
  /** `owner/name`. */
  repo: string;
  href: string;
  startedAt: string | null;
};

export type CloudNow = {
  running: CloudWork[];
  /** Sandbox runs and workflow jobs waiting to start in g1t's sandboxes. */
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
  /** g1t's cloud: sandbox time. */
  cloudSeconds: number;
  /** At price, before what paid for it. */
  cloudMicros: number;
  /** The workspace's own runners: self-hosted runner time, always $0. */
  ownSeconds: number;
  /** g1t charges nothing for now: the figures are usage at cost. */
  free: boolean;
};

/** A machine on g1t's cloud and its price a minute, from the machine catalogue. */
export type CloudPrice = { machine: string; title: string; perMinuteMicros: number };

/**
 * Billing's meters for machine time (`meters()` in services/billing/src/report.rs):
 * runner minutes by machine (`runner_2-core`), and by the second, sandbox time
 * from before minutes (`agent_sandbox` in still older months' reports).
 */
export const RUNNER_METER_PREFIX = "runner_";
export const CLOUD_SECOND_METERS = ["agent_sandbox", "sandbox"] as const;
export const OWN_METER = "self_hosted";

/** Where a sandbox run (checks, the merge queue) shows: its pull request, else the repository's pull requests. */
export function sandboxRunHref(repo: string, number?: number | null): string {
  return number != null ? `/${repo}/pull/${number}` : `/${repo}/pulls`;
}

/** The page of a workflow run. */
export function workflowRunHref(repo: string, runId: string): string {
  return `/${repo}/actions/runs/${runId}`;
}

const repoName = (run: Pick<AgentRun, "repo">) => `${run.repo.namespace}/${run.repo.name}`;

/**
 * What runs on g1t's cloud now. `runs` are the workspace's active sandbox
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
        href: sandboxRunHref(repoName(run), run.number),
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

/** What waits for one of the workspace's own runners: sandbox runs not yet taken, and workflow jobs. */
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
  const runnerKeys = meters.filter((meter) => meter.key.startsWith(RUNNER_METER_PREFIX)).map((meter) => meter.key);
  return {
    from: report.from,
    until: report.until,
    // Minutes as charged, and sandbox time from before them.
    cloudSeconds: sum(runnerKeys, (meter) => meter.quantity * 60) + sum(CLOUD_SECOND_METERS, (meter) => meter.quantity),
    cloudMicros: sum([...runnerKeys, ...CLOUD_SECOND_METERS], (meter) => meter.micros + (meter.pendingMicros ?? 0)),
    ownSeconds: sum([OWN_METER], (meter) => meter.quantity),
    free: report.free,
  };
}

/** Each machine on g1t's cloud and its price a minute, from the machine catalogue. */
export function cloudPrices(): CloudPrice[] {
  return machines().map((instance) => ({
    machine: instance.machine,
    title: `${instance.machine}: ${machineSize(instance)}`,
    perMinuteMicros: instance.microsPerMinute,
  }));
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

/**
 * Which of g1t's machines a runner takes jobs asking for one of for, for its row:
 * `Takes Small, Standard → 4 vCPU · 16 GB`. Null for a runner too old to say, which takes
 * them by its CPUs and memory.
 */
export function sizesLine(sizes: OfferedSize[] | null | undefined): string | null {
  if (!sizes) return null;
  return sizes.length === 0 ? "Takes none of g1t's sizes" : `Takes ${sizesSaid(sizes)}`;
}

/**
 * Whether a runner that takes some of g1t's sizes runs those jobs in g1t's machine image, for its
 * row, with why. Null when it doesn't matter: a runner that takes none of them, or is too old to say
 * its sizes.
 */
export function hostedImageLine(runner: Pick<Runner, "sizes" | "hostedImage">): { text: string; about: string; ready: boolean } | null {
  if (!runner.sizes?.length) return null;
  return runner.hostedImage
    ? {
        text: "In g1t's machine image",
        about: "Jobs that ask for one of g1t's machines run here in the same image they get there: Node, Python, Go, Rust and the rest.",
        ready: true,
      }
    : {
        text: "Without g1t's machine image",
        about:
          "It takes none of the jobs that ask for g1t's machines until g1t's machine image is on it. An x64 runner on g1t-runner 0.3.7 or later pulls it by itself, once.",
        ready: false,
      };
}
