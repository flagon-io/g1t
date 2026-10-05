/**
 * Agents at work, wherever they show: the project's Agents page, the
 * workspace's fleet, a pull request's Agent panel and the pull request
 * list. Stopping and messaging a run go through the project's
 * `agents.json` resource route, so every place behaves the same.
 */
import { Bot, CircleSlash, Clock, Coins, Loader2, MessageSquare, OctagonX, Square, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";

import {
  type AgentRun,
  type AgentRunStatus,
  type RunKind,
  RUN_KIND_LABEL,
  type Stage,
  isActiveRun,
  isAgentKind,
  takesMessages,
} from "@g1t/contracts";

import { STAGE_LABEL, StageDots } from "./lifecycle";
import { Avatar, TimeAgo } from "./ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

/** How often a page with something running asks again. */
export const LIVE_MS = 4000;

/** Revalidates the page every few seconds while `live`, as the merge queue does. */
export function useLiveRefresh(live: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, revalidator]);
}

export function formatCost(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** How long a run has gone on, ticking while it runs. */
export function Elapsed({ from, to }: { from: string; to?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (to) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [to]);
  const end = to ? new Date(to).getTime() : now;
  return (
    <span suppressHydrationWarning className="tabular-nums">
      {span(end - new Date(from).getTime())}
    </span>
  );
}

const STATUS: Record<AgentRunStatus, { label: string; tone: string; icon: ReactNode }> = {
  queued: { label: "Starting", tone: "text-muted border-line", icon: <Clock size={12} /> },
  running: {
    label: "Running",
    tone: "text-merged border-merged/40 bg-merged/10",
    icon: <Loader2 size={12} className="animate-spin" />,
  },
  succeeded: { label: "Done", tone: "text-accent border-accent/40 bg-accent/10", icon: <Bot size={12} /> },
  failed: { label: "Failed", tone: "text-danger border-danger/40 bg-danger/10", icon: <TriangleAlert size={12} /> },
  stopped: { label: "Stopped", tone: "text-warn border-warn/40 bg-warn/10", icon: <OctagonX size={12} /> },
};

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const { label, tone, icon } = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {icon}
      {label}
    </span>
  );
}

export function KindLabel({ kind }: { kind: RunKind }) {
  return (
    <span className="rounded border border-line px-1.5 py-px font-mono text-[0.6875rem] text-muted">
      {RUN_KIND_LABEL[kind].toLowerCase()}
    </span>
  );
}

/** Where a project's agent actions are posted. */
function actionUrl(run: AgentRun): string {
  return `/${run.repo.namespace}/${run.repo.name}/agents.json`;
}

type ActionResult = { ok: boolean; notice?: string; error?: string } | undefined;

/** Stop a run, after saying what that does. */
export function StopRun({ run, compact }: { run: AgentRun; compact?: boolean }) {
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  const onPull = run.number != null && isAgentKind(run.kind);
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
        >
          <Square size={11} />
          {busy ? "Stopping…" : compact ? "Stop" : "Stop run"}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this {RUN_KIND_LABEL[run.kind].toLowerCase()} run?</AlertDialogTitle>
            <AlertDialogDescription>
              Its sandbox is shut down at once and nothing more is pushed.
              {onPull &&
                ` g1t stops seeing #${run.number} through and leaves it for a person; what the agent already pushed stays on it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => fetcher.submit({ intent: "stop", run: run.id }, { method: "post", action: actionUrl(run) })}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </>
  );
}

/** Send the agent on a run's pull request a message. */
export function MessageRun({ run }: { run: AgentRun }) {
  const fetcher = useFetcher<ActionResult>();
  const [open, setOpen] = useState(false);
  const live = takesMessages(run.kind) && isActiveRun(run.status);
  if (run.number == null) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg">
        <MessageSquare size={11} />
        Message
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Message the agent on #{run.number}</DialogTitle>
          <DialogDescription>
            {live
              ? "It reads this at its next step, between tool calls, without starting over."
              : "This run does not read messages while it works. Your message waits on the pull request and is given to the agent's next run there."}
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={actionUrl(run)} className="space-y-3">
          <input type="hidden" name="intent" value="message" />
          <input type="hidden" name="number" value={run.number} />
          <textarea
            name="body"
            required
            rows={4}
            autoComplete="off"
            data-1p-ignore
            placeholder="Keep the old flag working too…"
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
          />
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
          {fetcher.data?.ok && fetcher.data.notice && <p className="text-sm text-accent">{fetcher.data.notice}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              className="inline-flex items-center gap-2 rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
            >
              {fetcher.state !== "idle" ? "Sending…" : "Send"}
            </button>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** What a run is on, as a link: its pull request, or the plan it writes. */
function RunTarget({ run, showRepo }: { run: AgentRun; showRepo?: boolean }) {
  const base = `/${run.repo.namespace}/${run.repo.name}`;
  const repo = showRepo ? (
    <Link to={base} className="font-mono text-xs text-faint hover:text-muted">
      {run.repo.namespace}/{run.repo.name}
    </Link>
  ) : null;
  if (run.number != null) {
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {repo}
        <Link to={`${base}/pull/${run.number}`} prefetch="intent" className="min-w-0 truncate font-medium hover:text-accent">
          {run.title ?? "Pull request"} <span className="font-normal text-faint">#{run.number}</span>
        </Link>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      {repo}
      <Link to={`${base}/plans`} className="min-w-0 truncate font-medium hover:text-accent">
        {run.title ?? "A plan"}
      </Link>
    </span>
  );
}

/** One run, live or finished, with what can be done about it. */
export function RunCard({ run, member, showRepo }: { run: AgentRun; member: boolean; showRepo?: boolean }) {
  const base = `/${run.repo.namespace}/${run.repo.name}`;
  const active = isActiveRun(run.status);
  const cost = formatCost(run.costUsd);
  return (
    <li
      className={`rounded-xl border bg-surface p-4 transition-colors hover:border-line-strong ${
        active ? "border-merged/30" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={run.agent} size={22} />
        <span className="text-sm font-medium">{run.agent}</span>
        <KindLabel kind={run.kind} />
        <span className="min-w-0 grow">
          <RunTarget run={run} showRepo={showRepo} />
        </span>
        <RunStatusBadge status={run.status} />
      </div>
      {run.step && (
        <p className={`mt-2.5 truncate font-mono text-xs ${active ? "text-fg/85" : "text-muted"}`} title={run.step}>
          {active && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-merged align-middle" />}
          {run.step}
        </p>
      )}
      {run.status === "failed" && run.error && <p className="mt-1.5 text-xs text-danger">{run.error}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {run.startedAt || active ? <Elapsed from={run.startedAt ?? run.createdAt} to={run.finishedAt} /> : "—"}
        </span>
        {cost && (
          <span className="flex items-center gap-1" title={active ? "So far, as the harness reports it" : "As the harness reported it"}>
            <Coins size={12} />
            {cost}
            {active && " so far"}
          </span>
        )}
        {run.model && <span className="font-mono">{run.model}</span>}
        {run.startedBy && <span>started by {run.startedBy}</span>}
        <span>
          <TimeAgo at={run.createdAt} />
        </span>
        <span className="grow" />
        <Link to={`${base}/agents/runs/${run.id}`} className="hover:text-fg">
          {run.stepCount} {run.stepCount === 1 ? "step" : "steps"}
        </Link>
        {run.number != null && (
          <Link to={`${base}/sessions/${run.number}`} className="hover:text-fg">
            Session
          </Link>
        )}
        {member && active && <MessageRun run={run} />}
        {member && active && <StopRun run={run} compact />}
      </div>
    </li>
  );
}

/** The runs that are on now, newest first, then the rest. */
export function splitRuns(runs: AgentRun[]): { live: AgentRun[]; done: AgentRun[] } {
  return {
    live: runs.filter((run) => isActiveRun(run.status)),
    done: runs.filter((run) => !isActiveRun(run.status)),
  };
}

type Live = { runs: AgentRun[]; member: boolean };

/**
 * The runs of a project, fetched from its `agents.json`, every few seconds
 * while any is running. For pages whose own loader does not have them.
 */
export function useRuns(owner: string, repo: string, query: Record<string, string>): Live | null {
  const fetcher = useFetcher<Live>();
  const search = new URLSearchParams(query).toString();
  const url = `/${owner}/${repo}/agents.json?${search}`;
  const { load } = fetcher;
  useEffect(() => {
    load(url);
  }, [load, url]);
  const live = fetcher.data?.runs.some((run) => isActiveRun(run.status)) ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(url);
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, load, url]);
  return fetcher.data ?? null;
}

/**
 * The agent on a pull request, near the top of its page: who is working
 * on it, at what stage, what it is doing this minute, for how long and at
 * what cost, with its session, and Stop and Message for members.
 */
export function AgentPanel({
  owner,
  repo,
  number,
  stage,
}: {
  owner: string;
  repo: string;
  number: number;
  stage?: Stage | null;
}) {
  const data = useRuns(owner, repo, { number: String(number), limit: "5" });
  const runs = data?.runs ?? [];
  const member = data?.member ?? false;
  const current = runs.find((run) => isActiveRun(run.status)) ?? runs[0];
  if (!current) return null;
  const active = isActiveRun(current.status);
  const base = `/${owner}/${repo}`;
  const cost = formatCost(current.costUsd);
  const spent = formatCost(runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) || null);
  return (
    <section
      aria-label="Agent"
      className={`mt-4 rounded-2xl bg-surface p-4 ring-1 ${active ? "ring-merged/40" : "ring-line"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={current.agent} size={24} />
        <p className="text-sm">
          <span className="font-medium">{current.agent}</span>{" "}
          <span className="text-muted">
            {active
              ? `is ${RUN_KIND_LABEL[current.kind].toLowerCase()}`
              : `${current.status === "succeeded" ? "finished" : current.status} its ${RUN_KIND_LABEL[current.kind].toLowerCase()} run`}
          </span>
        </p>
        {stage && (
          <span className="flex items-center gap-2 text-xs text-muted">
            <StageDots stage={stage} />
            {STAGE_LABEL[stage]}
          </span>
        )}
        <span className="grow" />
        <RunStatusBadge status={current.status} />
      </div>
      {current.step && (
        <p className="mt-3 truncate rounded-lg bg-bg px-3 py-2 font-mono text-xs text-fg/85 ring-1 ring-line" title={current.step}>
          {active && <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-merged align-middle" />}
          {current.step}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Clock size={12} />
          <Elapsed from={current.startedAt ?? current.createdAt} to={current.finishedAt} />
        </span>
        {cost && (
          <span className="flex items-center gap-1">
            <Coins size={12} />
            {cost}
            {active ? " so far" : ""}
            {runs.length > 1 && spent && ` · ${spent} over ${runs.length} runs`}
          </span>
        )}
        {current.model && <span className="font-mono">{current.model}</span>}
        <span className="grow" />
        <Link to={`${base}/agents/runs/${current.id}`} className="hover:text-fg">
          Run
        </Link>
        <Link to={`${base}/sessions/${number}`} className="hover:text-fg">
          Session
        </Link>
        {member && active && <MessageRun run={current} />}
        {member && active && <StopRun run={current} />}
      </div>
    </section>
  );
}

/** A small "agent working" mark for a row of the pull request list. */
export function AgentBadge({ run }: { run: AgentRun | undefined }) {
  if (!run) return null;
  return (
    <span
      title={run.step ?? undefined}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-merged/40 bg-merged/10 px-2 py-0.5 text-xs text-merged"
    >
      <Loader2 size={11} className="animate-spin" />
      {RUN_KIND_LABEL[run.kind]}
    </span>
  );
}

/** The active run on each pull request of a project, by number. */
export function useActiveRuns(owner: string, repo: string): Map<number, AgentRun> {
  const data = useRuns(owner, repo, { active: "1", limit: "100" });
  return useMemo(() => {
    const byNumber = new Map<number, AgentRun>();
    for (const run of data?.runs ?? []) {
      if (run.number != null && !byNumber.has(run.number)) byNumber.set(run.number, run);
    }
    return byNumber;
  }, [data]);
}

/** Nothing running, said plainly. */
export function Idle({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
      <CircleSlash size={15} className="text-faint" />
      {children}
    </p>
  );
}

/**
 * What the agent on a pull request is doing this minute, as one line, for
 * an issue's sidebar: which agent picked the issue up, and where it is.
 */
export function AgentStepLine({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const data = useRuns(owner, repo, { number: String(number), active: "1", limit: "1" });
  const run = data?.runs[0];
  if (!run?.step) return null;
  return (
    <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-faint" title={run.step}>
      {RUN_KIND_LABEL[run.kind]}: {run.step}
    </span>
  );
}
