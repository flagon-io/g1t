/**
 * Pieces of the Actions pages: how a run, job or step stands, how long it
 * took, and a job's log as GitHub shows one, with its groups folded and
 * its errors and warnings marked.
 */
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, CircleSlash, Clock, Hourglass, Info, Loader2, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import type { CommitStatus, Conclusion, LogChunk, WorkflowNote } from "@g1t/contracts";

import { Hint } from "./ui/hint";
import { type Line, blocks, highlight, searchLog } from "../lib/log-lines";

/**
 * Where a run, job or step stands. `of` says which: a run's `pending` waits
 * for its concurrency group and its `waiting` for its environments' rules,
 * while a job's `pending` is held at its environment and its `waiting`
 * waits for the jobs it needs. `environment` is the job's.
 */
type Standing = { status: string; conclusion: Conclusion | null; of?: "run" | "job"; environment?: string | null };

/** Held until a person (or a wait timer) lets it through. */
function heldWord({ status, of = "run", environment }: Standing): string | null {
  if (of === "run" && status === "action_required") return "Approval required";
  if (of === "run" && status === "waiting") return "Waiting for review";
  if (of === "job" && status === "pending") return environment ? `Waiting to deploy to ${environment}` : "Waiting at its environment";
  return null;
}

/** One icon for where a run, job or step stands. */
export function StatusIcon({ status, conclusion, of = "run", environment, size = 16 }: Standing & { size?: number }) {
  if (status === "in_progress") return <Loader2 size={size} className="shrink-0 animate-spin text-warn" aria-label="Running" />;
  const held = heldWord({ status, conclusion, of, environment });
  if (held)
    return status === "action_required" ? (
      <ShieldAlert size={size} className="shrink-0 text-warn" aria-label={held} />
    ) : (
      <Hourglass size={size} className="shrink-0 text-warn" aria-label={held} />
    );
  if (status !== "completed")
    return <Clock size={size} className="shrink-0 text-faint" aria-label={status === "pending" ? "Waiting its turn" : "Queued"} />;
  switch (conclusion) {
    case "success":
      return (
        <span className="inline-flex shrink-0 rounded-full bg-success/15 p-0.5 text-success" aria-label="Succeeded">
          <Check size={size - 4} strokeWidth={3} />
        </span>
      );
    case "failure":
      return (
        <span className="inline-flex shrink-0 rounded-full bg-danger/15 p-0.5 text-danger" aria-label="Failed">
          <X size={size - 4} strokeWidth={3} />
        </span>
      );
    case "cancelled":
      return <Ban size={size} className="shrink-0 text-faint" aria-label="Cancelled" />;
    default:
      return <CircleDashed size={size} className="shrink-0 text-faint" aria-label="Skipped" />;
  }
}

export function standingWord(standing: Standing): string {
  const { status, conclusion } = standing;
  if (status === "in_progress") return "Running";
  const held = heldWord(standing);
  if (held) return held;
  if (status === "pending") return "Waiting for its concurrency group";
  if (status === "waiting") return "Waiting for the jobs it needs";
  if (status === "calling") return "Running the workflow it calls";
  if (status !== "completed") return "Queued";
  return { success: "Succeeded", failure: "Failed", cancelled: "Cancelled", skipped: "Skipped" }[conclusion ?? "skipped"];
}

/** `1m 12s`, from two times, or from a start until now. */
export function duration(start: string | null, end: string | null): string {
  if (!start) return "";
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How long something ran, as text. While it is still running the server and
 * the browser count to a different now, so the text may differ on hydration
 * (as TimeAgo's does).
 */
export function Duration({ start, end, className }: { start: string | null; end: string | null; className?: string }) {
  return (
    <span className={className} suppressHydrationWarning>
      {duration(start, end)}
    </span>
  );
}

/** `main` from `refs/heads/main`, `v1.2` from a tag, `#12` for a pull request. */
export function shortRef(ref: string): string {
  const pull = /^refs\/pull\/(\d+)\//.exec(ref);
  if (pull) return `#${pull[1]}`;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

const LINE_STYLE: Record<Line["kind"], string> = {
  text: "text-fg/85",
  error: "text-danger",
  warning: "text-warn",
  notice: "text-accent",
  debug: "text-faint",
  command: "text-muted",
};

function LogLine({ line, number, query = "" }: { line: Line; number: number; query?: string }) {
  const text = line.text.replace(/^(Error|Warning|Notice): /, "");
  return (
    <div className={`flex gap-4 px-4 hover:bg-raised/40 ${line.kind === "error" ? "bg-danger/5" : ""}`}>
      <span className="w-8 shrink-0 select-none text-right text-faint/70">{number}</span>
      <span className={`min-w-0 whitespace-pre-wrap break-all ${LINE_STYLE[line.kind]}`}>
        {line.kind === "error" && <span className="font-semibold">Error: </span>}
        {line.kind === "warning" && <span className="font-semibold">Warning: </span>}
        {query
          ? highlight(text, query).map((piece, index) =>
              piece.match ? (
                <mark key={index} className="rounded-sm bg-accent/30 text-fg">
                  {piece.text}
                </mark>
              ) : (
                piece.text
              ),
            )
          : text}
      </span>
    </div>
  );
}

/**
 * A step's log. With `query`, only the lines holding it (any case), groups
 * opened, each match marked.
 */
export function LogText({ text, query = "" }: { text: string; query?: string }) {
  const parsed = useMemo(() => blocks(text), [text]);
  const found = useMemo(() => searchLog(text, query), [text, query]);
  if (!text.trim()) return <p className="px-4 py-2 text-xs text-faint">No output.</p>;
  if (query.trim()) {
    return (
      <div className="py-1 font-mono text-xs leading-5">
        {found.map(({ line, number }) => (
          <LogLine key={number} line={line} number={number} query={query} />
        ))}
      </div>
    );
  }
  return (
    <div className="py-1 font-mono text-xs leading-5">
      {parsed.map((block, index) =>
        block.kind === "line" ? (
          <LogLine key={index} line={block.line} number={block.number} />
        ) : (
          <details key={index} className="group/log">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 text-fg/85 hover:bg-raised/40">
              <span className="w-8 shrink-0" />
              <ChevronRight size={12} className="shrink-0 text-faint transition-transform group-open/log:rotate-90" />
              {block.title}
            </summary>
            {block.lines.map(({ line, number }) => (
              <LogLine key={number} line={line} number={number} />
            ))}
          </details>
        ),
      )}
    </div>
  );
}

/**
 * A job's log, fetched as it grows, split by step: `render` gets each
 * step's text (0 is the job's setup).
 */
export function useJobLog(url: string, live: boolean): Map<number, string> {
  const [chunks, setChunks] = useState<LogChunk[]>([]);
  const after = useRef(0);
  useEffect(() => {
    after.current = 0;
    setChunks([]);
  }, [url]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        // Pages of up to 500 chunks, until there is no more for now.
        for (;;) {
          const response = await fetch(`${url}?after=${after.current}`);
          if (!response.ok) break;
          const page = (await response.json()) as { chunks: LogChunk[]; done: boolean };
          if (stopped) return;
          if (page.chunks.length > 0) {
            after.current = page.chunks[page.chunks.length - 1].seq;
            setChunks((known) => [...known, ...page.chunks]);
          }
          if (page.chunks.length < 500) {
            if (!page.done && live) timer = setTimeout(load, 2000);
            break;
          }
        }
      } catch {
        if (!stopped && live) timer = setTimeout(load, 4000);
      }
    };
    load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, live]);
  return useMemo(() => {
    const byStep = new Map<number, string>();
    for (const chunk of chunks) byStep.set(chunk.step, (byStep.get(chunk.step) ?? "") + chunk.text);
    return byStep;
  }, [chunks]);
}

const NOTE_ICON = {
  info: <Info size={14} className="mt-0.5 shrink-0 text-muted" />,
  warning: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />,
  unsupported: <CircleSlash size={14} className="mt-0.5 shrink-0 text-danger" />,
};

/** What in a workflow runs differently on g1t, worst first. */
export function Notes({ notes }: { notes: WorkflowNote[] }) {
  if (notes.length === 0) return null;
  const order = { unsupported: 0, warning: 1, info: 2 };
  const sorted = [...notes].sort((a, b) => order[a.severity] - order[b.severity]);
  const blocking = notes.filter((n) => n.severity === "unsupported").length;
  return (
    <details className="group rounded-xl border border-line bg-surface" open={blocking > 0}>
      <summary className="cursor-pointer list-none px-4 py-2.5 text-sm">
        <span className="font-medium">How this runs on g1t</span>
        <span className="text-muted">
          {" · "}
          {blocking > 0 ? `${blocking} thing${blocking === 1 ? "" : "s"} g1t cannot run yet` : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
        </span>
      </summary>
      <ul className="space-y-2 border-t border-line px-4 py-3 text-sm">
        {sorted.map((note, index) => (
          <li key={index} className="flex gap-2">
            {NOTE_ICON[note.severity]}
            <span>
              {note.job && <span className="font-mono text-xs text-muted">{note.job}: </span>}
              {note.message}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}


/** What workflow runs said about a pull request's head, each linking to its run. */
export function WorkflowStatuses({ statuses }: { statuses: CommitStatus[] }) {
  if (statuses.length === 0) return null;
  const standing = (state: CommitStatus["state"]) =>
    state === "pending"
      ? { status: "in_progress", conclusion: null }
      : { status: "completed", conclusion: (state === "success" ? "success" : "failure") as Conclusion };
  const failed = statuses.filter((s) => s.state === "failure" || s.state === "error").length;
  const pending = statuses.filter((s) => s.state === "pending").length;
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-medium">
        {failed > 0 ? `${failed} workflow${failed === 1 ? "" : "s"} failed` : pending > 0 ? "Workflows running" : "Workflows passed"}
      </h3>
      <ul className="mt-3 space-y-2 text-sm">
        {statuses.map((status) => {
          const path = status.targetUrl?.replace(/^https:\/\/g1t\.sh/, "") ?? null;
          const row = (
            <>
              <StatusIcon {...standing(status.state)} size={14} />
              <span className="min-w-0 truncate">{status.context}</span>
            </>
          );
          return (
            <li key={status.context}>
              {path ? (
                <Hint label={status.description}>
                  <Link to={path} className="flex items-center gap-2 hover:text-fg">
                    {row}
                  </Link>
                </Hint>
              ) : (
                <span className="flex items-center gap-2">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
