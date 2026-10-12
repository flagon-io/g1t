/**
 * Pieces of the Actions pages: how a run, job or step stands, how long it
 * took, and a job's log as GitHub shows one, with its groups folded and
 * its errors and warnings marked.
 */
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, CircleSlash, Clock, Hourglass, Info, Loader2, ShieldAlert, X } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import type { CommitStatus, Conclusion, LogChunk, WorkflowNote } from "@g1t/contracts";

import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { markSpans, parseAnsi, spanLook } from "../lib/ansi";
import { type Line, type Row, type StepLog, appendLog, emptyLog, groupOf, logRows, rowKey, searchStepLog } from "../lib/log-lines";
import { WINDOW_FROM, rowStarts, windowOf } from "../lib/log-window";
import { type PollAnswer, nextPoll, retryAfterMs } from "../lib/log-poll";

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

/** A line's time as the log shows it beside the line: GitHub's, to the millisecond. */
function shownTime(at: string): string {
  return at.replace(/(\.\d{3})\d*Z$/, "$1Z");
}

/** A line's text, coloured as the tool that printed it coloured it, and with a search's matches marked. */
function LineText({ text, ansi, query }: { text: string; ansi?: string; query: string }) {
  const spans = useMemo(() => (ansi ? parseAnsi(ansi) : [{ text, style: {} }]), [text, ansi]);
  const pieces = useMemo(() => markSpans(spans, query), [spans, query]);
  return (
    <>
      {pieces.map((piece, index) => {
        const look = spanLook(piece.style);
        const drawn = look.className || look.style ? (
          <span className={look.className} style={look.style}>
            {piece.text}
          </span>
        ) : (
          piece.text
        );
        return piece.match ? (
          <mark key={index} className="rounded-sm bg-accent/30 text-fg">
            {drawn}
          </mark>
        ) : (
          <Fragment key={index}>{drawn}</Fragment>
        );
      })}
    </>
  );
}

/** One line of a step's log: its number (a link to it), its time when asked for, and its text. Drawn again only when it changes. */
type LogLineProps = { line: Line; number: number; query?: string; timestamps?: boolean; anchor?: string; targeted?: boolean };

const LogLine = memo(function LogLine({ line, number, query = "", timestamps = false, anchor, targeted = false }: LogLineProps) {
  const label = /^(Error|Warning|Notice): /;
  const text = line.text.replace(label, "");
  const ansi = line.ansi?.replace(label, "");
  const id = anchor ? `${anchor}:${number}` : undefined;
  return (
    <div
      id={id}
      className={`flex scroll-mt-24 gap-4 px-4 hover:bg-raised/40 ${targeted ? "bg-accent/15" : line.kind === "error" ? "bg-danger/5" : ""}`}
    >
      {id ? (
        <a href={`#${id}`} className="w-8 shrink-0 select-none text-right text-faint/70 hover:text-fg hover:underline">
          {number}
        </a>
      ) : (
        <span className="w-8 shrink-0 select-none text-right text-faint/70">{number}</span>
      )}
      {timestamps && (
        <time dateTime={line.at} className="w-[24ch] shrink-0 select-none text-faint/70 tabular-nums">
          {line.at ? shownTime(line.at) : ""}
        </time>
      )}
      <span className={`min-w-0 whitespace-pre-wrap break-all ${LINE_STYLE[line.kind]}`}>
        {line.kind === "error" && <span className="font-semibold">Error: </span>}
        {line.kind === "warning" && <span className="font-semibold">Warning: </span>}
        <LineText text={text} ansi={ansi} query={query} />
      </span>
    </div>
  );
}, sameLine);

/** Whether a line would draw the same: a log that grows keeps its lines, but a search finds them again. */
function sameLine(a: LogLineProps, b: LogLineProps): boolean {
  return (
    a.number === b.number &&
    a.query === b.query &&
    a.timestamps === b.timestamps &&
    a.anchor === b.anchor &&
    a.targeted === b.targeted &&
    a.line === b.line
  );
}

/** A group's title: a row that folds and opens the lines under it. */
function GroupRow({ row, timestamps, onToggle }: { row: Extract<Row, { kind: "group" }>; timestamps: boolean; onToggle: (block: number) => void }) {
  return (
    <button
      type="button"
      aria-expanded={row.open}
      onClick={() => onToggle(row.block)}
      className="flex w-full cursor-pointer items-center gap-1.5 px-4 text-left text-fg/85 hover:bg-raised/40"
    >
      <span className="w-8 shrink-0" />
      {timestamps && (
        <time dateTime={row.at} className="ml-2.5 w-[24ch] shrink-0 select-none text-faint/70 tabular-nums">
          {row.at ? shownTime(row.at) : ""}
        </time>
      )}
      <ChevronRight size={12} className={`shrink-0 text-faint transition-transform ${row.open ? "rotate-90" : ""}`} />
      <span className="min-w-0 whitespace-pre-wrap break-all">{row.title}</span>
    </button>
  );
}

/**
 * A step's log. With `query`, only the lines holding it (any case), groups
 * opened, each match marked. With `timestamps`, each line's time beside it.
 * `anchor` names the step in each line's link (`step:3` gives `#step:3:12`),
 * and `target` is the line such a link names: its group opens, and it is
 * scrolled to and marked. A log of more than a few thousand rows draws only
 * those on screen (lib/log-window.ts).
 */
export function LogText({
  log,
  query = "",
  timestamps = false,
  anchor,
  target = null,
}: {
  log: StepLog;
  query?: string;
  timestamps?: boolean;
  anchor?: string;
  target?: number | null;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const searching = query.trim().length > 0;
  const found = useMemo(() => searchStepLog(log, query), [log, query]);
  const rows = useMemo<Row[]>(() => (searching ? found.map((entry) => ({ kind: "line", entry })) : logRows(log, open)), [searching, found, log, open]);
  // A link to a line in a folded group opens the group.
  const targetGroup = target === null ? null : groupOf(log, target);
  useEffect(() => {
    if (targetGroup !== null) setOpen((known) => (known.has(targetGroup) ? known : new Set(known).add(targetGroup)));
  }, [targetGroup]);
  const toggle = useCallback((block: number) => {
    setOpen((known) => {
      const next = new Set(known);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  }, []);
  if (!log.hasText && !log.tail) return <p className="px-4 py-2 text-xs text-faint">No output.</p>;
  return <LogRows rows={rows} query={searching ? query : ""} timestamps={timestamps} anchor={anchor} target={target} onToggle={toggle} />;
}

/** The rows of a step's log, every one, or past `WINDOW_FROM` those on screen and a few around them. */
function LogRows({
  rows,
  query,
  timestamps,
  anchor,
  target,
  onToggle,
}: {
  rows: Row[];
  query: string;
  timestamps: boolean;
  anchor?: string;
  target: number | null;
  onToggle: (block: number) => void;
}) {
  const windowed = rows.length > WINDOW_FROM;
  const box = useRef<HTMLDivElement>(null);
  /** Each drawn row's height, by its key, as it was last measured. */
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState(0);
  /** The part of the log on screen, from its top, in steps of `VIEW_STEP` pixels. */
  const [view, setView] = useState<[number, number]>([0, 0]);
  const starts = useMemo(
    () => (windowed ? rowStarts(rows.length, (index) => heights.current.get(rowKey(rows[index]!))) : null),
    // `measured` changes when a row's height does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, rows, measured],
  );
  const [from, to] = starts ? windowOf(starts, view[0], view[1]) : [0, rows.length];
  // Follow the screen: the view, as the window scrolls or is resized.
  useEffect(() => {
    if (!windowed) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      const top = Math.floor(-rect.top / VIEW_STEP) * VIEW_STEP;
      const bottom = Math.ceil((window.innerHeight - rect.top) / VIEW_STEP) * VIEW_STEP;
      setView((known) => (known[0] === top && known[1] === bottom ? known : [top, bottom]));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    look();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    // A step folded or opened moves the log without a scroll.
    document.addEventListener("toggle", soon, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      document.removeEventListener("toggle", soon, true);
    };
  }, [windowed]);
  // Measure what was drawn; a row whose height is not what was kept for it
  // has its space corrected.
  useLayoutEffect(() => {
    if (!windowed || !box.current) return;
    let changed = false;
    for (const element of box.current.querySelectorAll<HTMLElement>("[data-row]")) {
      const height = element.offsetHeight;
      const key = element.dataset.row!;
      if (height > 0 && heights.current.get(key) !== height) {
        heights.current.set(key, height);
        changed = true;
      }
    }
    if (changed) setMeasured((n) => n + 1);
  });
  // A link to a line: scroll to it once it is in the log.
  const targetRow = target === null ? -1 : rows.findIndex((row) => row.kind === "line" && row.entry.number === target);
  const scrolledTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (targetRow === -1 || scrolledTo.current === target || !box.current) return;
    scrolledTo.current = target;
    const top = box.current.getBoundingClientRect().top + window.scrollY + (starts ? starts[targetRow]! : 0);
    if (starts) window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3) });
    else document.getElementById(`${anchor}:${target}`)?.scrollIntoView({ block: "center" });
  }, [targetRow, target, starts, anchor]);
  const drawn = rows.slice(from, to).map((row) => {
    const key = rowKey(row);
    return (
      <div key={key} data-row={windowed ? key : undefined}>
        {row.kind === "line" ? (
          <LogLine
            line={row.entry.line}
            number={row.entry.number}
            query={query}
            timestamps={timestamps}
            anchor={anchor}
            targeted={row.entry.number === target}
          />
        ) : (
          <GroupRow row={row} timestamps={timestamps} onToggle={onToggle} />
        )}
      </div>
    );
  });
  return (
    <div ref={box} className="py-1 font-mono text-xs leading-5">
      {starts && <div aria-hidden style={{ height: starts[from] }} />}
      {drawn}
      {starts && <div aria-hidden style={{ height: starts[rows.length]! - starts[to]! }} />}
    </div>
  );
}

/** How finely the view of a windowed log is followed, in pixels: a scroll of less draws nothing new. */
const VIEW_STEP = 200;

/** A job's log as the page has it: each step's log, read as it came (0 is the job's setup), when each last grew, and whether asking for more is failing. */
export type JobLog = {
  byStep: Map<number, StepLog>;
  /** When a chunk of each step's last arrived, by this browser's clock. */
  grewAt: Map<number, number>;
  /** The last ask failed, and the page is waiting to ask again. */
  retrying: boolean;
};

/**
 * A job's log, fetched as it grows (lib/log-poll.ts says how often), split
 * by step. A failed fetch is tried again, waiting longer each time; while
 * the tab is hidden it waits, and asks at once when it is shown again.
 * `running` is whether one of the job's steps is running now.
 */
export function useJobLog(url: string, live: boolean, running: boolean): JobLog {
  // Each chunk is read once, into its step's log, as it arrives: a long
  // step's log is not read again from its start for every chunk.
  const steps = useRef(new Map<number, StepLog>());
  const [byStep, setByStep] = useState<Map<number, StepLog>>(new Map());
  const [grewAt, setGrewAt] = useState<Map<number, number>>(new Map());
  const [retrying, setRetrying] = useState(false);
  const after = useRef(0);
  const runningNow = useRef(running);
  runningNow.current = running;
  useEffect(() => {
    after.current = 0;
    steps.current = new Map();
    setByStep(new Map());
    setGrewAt(new Map());
  }, [url]);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delayMs: number | null) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (stopped || delayMs === null) return;
      timer = setTimeout(load, delayMs);
    };
    const load = async () => {
      timer = undefined;
      if (stopped || busy) return;
      // Hidden, a live log waits; it asks again when the tab is shown.
      if (live && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      busy = true;
      let answer: PollAnswer;
      try {
        const response = await fetch(`${url}?after=${after.current}`, { cache: "no-store" });
        if (!response.ok) {
          answer = { ok: false, status: response.status, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
        } else {
          const page = (await response.json()) as { chunks: LogChunk[]; done: boolean };
          if (stopped) return;
          if (page.chunks.length > 0) {
            after.current = page.chunks[page.chunks.length - 1]!.seq;
            const now = Date.now();
            for (const chunk of page.chunks) steps.current.set(chunk.step, appendLog(steps.current.get(chunk.step) ?? emptyLog(), chunk.text));
            setByStep(new Map(steps.current));
            setGrewAt((known) => {
              const next = new Map(known);
              for (const chunk of page.chunks) next.set(chunk.step, now);
              return next;
            });
          }
          answer = { ok: true, done: page.done, full: page.chunks.length >= LOG_PAGE };
        }
      } catch {
        answer = { ok: false };
      } finally {
        busy = false;
      }
      if (stopped) return;
      const next = nextPoll(answer, { failures, live, running: runningNow.current });
      failures = next.failures;
      setRetrying(!answer.ok && next.delayMs !== null);
      schedule(next.delayMs);
    };
    const shown = () => {
      if (document.visibilityState === "visible" && !timer && !busy && live) load();
      else if (document.visibilityState === "visible" && timer && live) schedule(0);
    };
    load();
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [url, live]);
  return { byStep, grewAt, retrying };
}

/** The most chunks one answer of the log carries (services/actions, `logs`). */
const LOG_PAGE = 500;

/** Now, as a number, again every `everyMs` while `on`: for times that count up as you watch. */
export function useNow(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
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
    <Card asChild className="group">
      <details open={blocking > 0}>
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
    </Card>
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
    <Card asChild className="p-4">
      <section>
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
    </Card>
  );
}
