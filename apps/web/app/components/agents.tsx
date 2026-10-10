/**
 * Agents at work, wherever they show: the project's Agents page, the
 * workspace's fleet, a pull request's Agent panel and the pull request
 * list. Stopping and messaging a run go through the project's
 * `agents.json` resource route, so every place behaves the same.
 */
import { Bot, CircleSlash, Clock, Coins, Gauge, Loader2, MessageSquare, OctagonX, Square, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { useRefreshWhile } from "../lib/refresh";

import {
  type AgentRun,
  type AgentRunStatus,
  type Confidence,
  type RunKind,
  RUN_KIND_LABEL,
  type Stage,
  isActiveRun,
  isAgentKind,
  takesMessages,
} from "@g1t/contracts";

import { RunAudit } from "./audit";
import { STAGE_LABEL, StageDots } from "./lifecycle";
import { SubmitButton, TimeAgo } from "./ui";
import { Hint } from "./ui/hint";
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
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { shownStep } from "../lib/agent-step";
import { inlinePlain } from "../lib/inline-markdown";
import { InlineMarkdown } from "./inline-markdown";
import { microsOf, money } from "../lib/money";

/** How often a page with something running asks again. */
export const LIVE_MS = 4000;

/** Revalidates the page every few seconds while `live`, as the merge queue does. */
export function useLiveRefresh(live: boolean) {
  useRefreshWhile(live, LIVE_MS);
}

export function formatCost(usd: number | null | undefined): string | null {
  return usd == null ? null : money(microsOf(usd));
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
    tone: "text-accent border-accent/40 bg-accent/10",
    icon: <Loader2 size={12} className="animate-spin" />,
  },
  succeeded: { label: "Done", tone: "text-success border-success/40 bg-success/10", icon: <Bot size={12} /> },
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
  const form = useRef<HTMLFormElement>(null);
  // Sent: the box empties, and the notice below says where it went.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
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
        <fetcher.Form ref={form} method="post" action={actionUrl(run)} className="space-y-3">
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
          {fetcher.data?.ok && fetcher.data.notice && <p className="text-sm text-success">{fetcher.data.notice}</p>}
          <div className="flex justify-end">
            <SubmitButton
              fetcher={fetcher}
              pending="Sending…">
              Send
            </SubmitButton>
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
        active ? "border-accent/30" : "border-line"
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
        <Hint label={inlinePlain(shownStep(run.step))}>
          <p className={`mt-2.5 truncate font-mono text-xs ${active ? "text-fg/85" : "text-muted"}`}>
            {active && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />}
            <InlineMarkdown text={shownStep(run.step)} />
          </p>
        </Hint>
      )}
      {run.status === "failed" && run.error && <p className="mt-1.5 text-xs text-danger">{run.error}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {run.startedAt || active ? <Elapsed from={run.startedAt ?? run.createdAt} to={run.finishedAt} /> : "—"}
        </span>
        {cost && (
          <Hint label={active ? "So far, as the harness reports it" : "As the harness reported it"}>
            <span className="flex items-center gap-1">
              <Coins size={12} />
              {cost}
              {active && " so far"}
            </span>
          </Hint>
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

export type Live = { runs: AgentRun[]; member: boolean };

/**
 * The runs of a project, fetched from its `agents.json`, every few seconds
 * while any is running. A page whose loader read them passes them as
 * `initial`, so they come with the page instead of appearing after it;
 * without, they are fetched once it is up.
 */
export function useRuns(
  owner: string,
  repo: string,
  query: Record<string, string>,
  initial?: Live | null,
): Live | null {
  const fetcher = useFetcher<Live>();
  const search = new URLSearchParams(query).toString();
  const url = `/${owner}/${repo}/agents.json?${search}`;
  const { load } = fetcher;
  const loaded = initial !== undefined;
  useEffect(() => {
    if (!loaded) load(url);
  }, [load, url, loaded]);
  // The newer of the page's runs and the last poll: the page revalidating
  // replaces an older poll, and a poll the runs the page came with.
  const [newest, setNewest] = useState<Live | null>(initial ?? null);
  useEffect(() => {
    if (loaded) setNewest(initial ?? null);
  }, [loaded, initial]);
  useEffect(() => {
    if (fetcher.data) setNewest(fetcher.data);
  }, [fetcher.data]);
  const data = loaded ? newest : (fetcher.data ?? null);
  const live = data?.runs.some((run) => isActiveRun(run.status)) ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(url);
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, load, url]);
  return data;
}

/** "Agent confidence: Low — tests not added, 3 revisions", and what the agent said it was unsure of. */
export function ConfidenceLine({ confidence }: { confidence: Confidence }) {
  const tone = confidence.level === "low" ? "text-danger" : confidence.level === "medium" ? "text-warn" : "text-success";
  const level = { low: "Low", medium: "Medium", high: "High" }[confidence.level];
  return (
    <div className="mt-3 text-xs leading-5">
      <p className="flex items-start gap-2">
        <Gauge size={13} className={`mt-1 shrink-0 ${tone}`} />
        <span className="min-w-0">
          <span className="text-muted">Agent confidence: </span>
          <span className={`font-medium ${tone}`}>{level}</span>
          {confidence.reasons.length > 0 && <span className="text-fg-soft"> — {confidence.reasons.join(", ")}</span>}
        </span>
      </p>
      {confidence.uncertainAbout.length > 0 && (
        <p className="mt-0.5 pl-[1.3125rem] text-muted">Unsure about: {confidence.uncertainAbout.join("; ")}</p>
      )}
    </div>
  );
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
  confidence,
  runs: initial,
}: {
  owner: string;
  repo: string;
  number: number;
  stage?: Stage | null;
  /** How sure g1t is of the change, once the agent has finished it. */
  confidence?: Confidence | null;
  /** Its latest five runs, from the page's loader, so the panel comes with the page. */
  runs?: Live | null;
}) {
  const data = useRuns(owner, repo, { number: String(number), limit: "5" }, initial);
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
      className={`mt-4 rounded-2xl bg-surface p-4 ring-1 ${active ? "ring-accent/40" : "ring-line"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={current.agent} size={24} />
        <p className="text-sm">
          <span className="font-medium">{current.agent}</span>{" "}
          {current.startedBy && current.startedBy !== current.agent && (
            current.startedBy === "g1t" ? (
              <span className="text-muted">
                (started by <span className="text-fg">g1t</span>){" "}
              </span>
            ) : (
              <span className="text-muted">
                on behalf of <span className="text-fg">{current.startedBy}</span>{" "}
              </span>
            )
          )}
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
        <Hint label={inlinePlain(shownStep(current.step))}>
          <p className="mt-3 truncate rounded-lg bg-bg px-3 py-2 font-mono text-xs text-fg/85 ring-1 ring-line">
            {active && <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />}
            <InlineMarkdown text={shownStep(current.step)} />
          </p>
        </Hint>
      )}
      {confidence && <ConfidenceLine confidence={confidence} />}
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
      {member && <RunAudit owner={owner} repo={repo} runIds={runs.map((run) => run.id)} live={active} />}
    </section>
  );
}

/** A small "agent working" mark for a row of the pull request list. */
export function AgentBadge({ run }: { run: AgentRun | undefined }) {
  if (!run) return null;
  return (
    <Hint label={run.step ? inlinePlain(shownStep(run.step)) : undefined}>
      <Badge tone="merged" size="md">
        <Loader2 size={11} className="animate-spin" />
        {RUN_KIND_LABEL[run.kind]}
      </Badge>
    </Hint>
  );
}

/** The active run on each pull request of a project, by number. */
export function useActiveRuns(owner: string, repo: string, initial?: Live | null): Map<number, AgentRun> {
  const data = useRuns(owner, repo, { active: "1", limit: "100" }, initial);
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
    <Card asChild tone="plain" className="flex items-start gap-2 border-dashed px-4 py-6 text-sm text-muted">
      <p>
        <CircleSlash size={15} className="mt-0.5 shrink-0 text-faint" />
        {/* One run of text: a link inside it stays in the sentence. */}
        <span className="min-w-0">{children}</span>
      </p>
    </Card>
  );
}

/**
 * What the agent on a pull request is doing this minute, as one line, for
 * an issue's sidebar: which agent picked the issue up, and where it is.
 */
export function AgentStepLine({
  owner,
  repo,
  number,
  runs: initial,
}: {
  owner: string;
  repo: string;
  number: number;
  /** The project's active runs, from the page's loader, so the line comes with the page. */
  runs?: Live | null;
}) {
  const data = useRuns(owner, repo, { number: String(number), active: "1", limit: "1" }, initial);
  const run = data?.runs.find((run) => run.number === number && isActiveRun(run.status));
  if (!run?.step) return null;
  return (
    <Hint label={inlinePlain(shownStep(run.step))}>
      <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-faint">
        {RUN_KIND_LABEL[run.kind]}: <InlineMarkdown text={shownStep(run.step)} />
      </span>
    </Hint>
  );
}
