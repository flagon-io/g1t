/**
 * The parts of a session's page that tell it as an answer (lib/session-story.ts):
 * what it was asked, how long it worked (which opens the transcript), what
 * it came to, a few figures, the highlights with their citations, and what
 * it delivered.
 */
import { ChevronRight, GitCommitHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import type { LinkVia, Pull, State } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { viaLabel } from "../lib/coordination";
import type { MarkdownRepo } from "../lib/markdown-plugins";
import { itemPath } from "../lib/refs";
import type { ActivityBar, Deliverable, Highlight } from "../lib/session-story";
import { MarkGlyph } from "./logo";
import { Markdown } from "./markdown";
import { entryAnchor } from "./session-entries";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { ItemIcon, PullIcon } from "./work-icons";

/** What it was asked, as the person asked it: their words on the right, as a conversation has them. */
export function AskedBubble({ text, repo }: { text: string; repo?: MarkdownRepo }) {
  const [all, setAll] = useState(false);
  // About six lines' worth: longer ones fold, with a way to read them whole.
  const long = text.length > 480 || text.split("\n").length > 6;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[0.9375rem] leading-relaxed text-fg">
        <div className={long && !all ? "line-clamp-6" : undefined}>
          <Markdown source={text} repo={repo} />
        </div>
        {long && (
          <button
            type="button"
            onClick={() => setAll((open) => !open)}
            aria-expanded={all}
            className="mt-1 rounded text-xs font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            {all ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * How long it worked, or that it is working: g1t's mark, still or
 * breathing, and the words; a button that shows or hides the transcript.
 */
export function WorkedFor({ live, span, tools, open, onToggle }: { live: boolean; span: string; tools: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="transcript-entries"
      className="group inline-flex items-center gap-2 rounded-md py-1 pr-1.5 text-sm text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className={cn("flex text-fg", live && "animate-pulse motion-reduce:animate-none")}>
        <MarkGlyph className="h-4" />
      </span>
      <span>
        {live ? "Working for" : "Worked for"} <span suppressHydrationWarning>{span}</span>
        {tools > 0 && <span className="text-faint"> · {tools === 1 ? "1 tool call" : `${tools} tool calls`}</span>}
      </span>
      <ChevronRight size={14} className={cn("text-faint transition-transform", open && "rotate-90")} />
    </button>
  );
}

/** What it came to, in its own words: the first thing to read. */
export function SessionAnswer({ text, repo }: { text: string; repo?: MarkdownRepo }) {
  return (
    <div className="text-[1.0625rem] leading-relaxed text-fg [&_p]:my-0 [&_p+p]:mt-3">
      <Markdown source={text} repo={repo} />
    </div>
  );
}

/** One figure: what it is, its value large, a line under it, and a picture of it when there is one. */
export function StatTile({ label, value, detail, children }: { label: string; value: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <Card tone="plain" radius="lg" className="flex min-w-0 flex-col p-4">
      <p className="text-[0.8125rem] text-muted">{label}</p>
      <p className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-faint">{detail}</p>}
      {children && <div className="mt-auto pt-4">{children}</div>}
    </Card>
  );
}

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * How busily it worked, as bars: one series, so one colour and no legend
 * (the tile's label names it). Each bar is a slice of the run, 4px rounded
 * at its top and standing on the baseline, 2px apart; an empty slice is a
 * stub, so the run's length still reads. Each says its slice on hover.
 */
export function ActivityBars({ bars }: { bars: ActivityBar[] }) {
  const most = Math.max(1, ...bars.map((bar) => bar.entries));
  return (
    <div role="img" aria-label={`Activity over the run: ${bars.reduce((sum, bar) => sum + bar.entries, 0)} entries`} className="flex h-12 items-end gap-0.5">
      {bars.map((bar) => (
        <Hint
          key={bar.from}
          side="top"
          label={
            <span className="tabular-nums">
              {CLOCK.format(bar.from)}–{CLOCK.format(bar.to)} · {bar.entries === 1 ? "1 entry" : `${bar.entries} entries`}
              {bar.tools > 0 && `, ${bar.tools === 1 ? "1 tool call" : `${bar.tools} tool calls`}`}
            </span>
          }
        >
          {/* The hit target is the whole column, taller than the bar. */}
          <span className="flex h-full min-w-0 flex-1 items-end">
            {/* A live session's run grows with the clock, so the server's bars and the browser's may differ by a slice. */}
            <span
              suppressHydrationWarning
              className={cn("w-full rounded-t-sm transition-opacity", bar.entries > 0 ? "bg-accent hover:opacity-80" : "bg-line")}
              style={{ height: bar.entries > 0 ? `${Math.max(10, (bar.entries / most) * 100)}%` : "2px" }}
            />
          </span>
        </Hint>
      ))}
    </div>
  );
}

/**
 * The highlights: each a line, with a small number after it that goes to
 * where it comes from: its place in the transcript (`onCite` opens the
 * transcript first), or the pull request or work item it was kept on.
 */
export function Highlights({ items, onCite }: { items: Highlight[]; onCite: (seq: number) => void }) {
  return (
    <ul className="space-y-2.5">
      {items.map((highlight, index) => (
        <li key={`${index}-${highlight.text}`} className="flex gap-3 text-[0.9375rem] leading-relaxed text-fg-soft">
          <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-faint" />
          <span className="min-w-0">
            {highlight.text} <Citation number={index + 1} highlight={highlight} onCite={onCite} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const CHIP =
  "ml-0.5 inline-flex h-5 min-w-5 -translate-y-px items-center justify-center rounded-md bg-raised px-1 align-middle text-[0.6875rem] font-medium text-muted tabular-nums no-underline outline-none transition-colors hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent";

function Citation({ number, highlight, onCite }: { number: number; highlight: Highlight; onCite: (seq: number) => void }) {
  const { cite } = highlight;
  if (cite.kind === "decision") {
    return (
      <Hint label="Kept as a decision: open where">
        <Link to={cite.to} prefetch="intent" className={CHIP} aria-label={`Source ${number}: the decision`}>
          {number}
        </Link>
      </Hint>
    );
  }
  return (
    <Hint label="Its place in the transcript">
      <a
        href={`#${entryAnchor(cite.seq)}`}
        className={CHIP}
        aria-label={`Source ${number}: the transcript`}
        onClick={(event) => {
          event.preventDefault();
          onCite(cite.seq);
        }}
      >
        {number}
      </a>
    </Hint>
  );
}

const PULL_STATES: Pull["status"][] = ["open", "draft", "merged", "closed"];

/** A pull request's status as its icon wants it; anything unknown reads as open. */
function pullStatus(state: string): Pull["status"] {
  return (PULL_STATES as string[]).includes(state) ? (state as Pull["status"]) : "open";
}

/**
 * What it delivered, as cards: a picture of each up top (its mark and
 * number, or the commits' hashes) and under it what it is called and what
 * kind of thing it is.
 */
export function Deliverables({ items, base, workspace }: { items: Deliverable[]; base: string; workspace: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => {
        const key = item.kind === "commits" ? "commits" : `${item.kind}-${item.number}`;
        const to =
          item.kind === "pull" ? `${base}/pull/${item.number}` : item.kind === "item" ? itemPath(workspace, item.number) : `${base}/commit/${item.shas[0]}`;
        return (
          <li key={key}>
            <Link
              to={to}
              prefetch="intent"
              className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-bg outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
            >
              <div className="flex h-24 items-end bg-surface px-4 pb-0">
                <div className="h-18 w-full rounded-t-lg border border-b-0 border-line bg-bg px-3 pt-2.5 shadow-xs transition-transform group-hover:-translate-y-0.5">
                  <DeliverablePreview item={item} />
                </div>
              </div>
              <div className="border-t border-line px-4 py-3">
                <p className="truncate text-sm text-fg">
                  {item.kind === "commits" ? `${item.shas.length === 1 ? "1 commit" : `${item.shas.length} commits`}` : item.title}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  {item.kind === "pull" ? (
                    <>
                      <PullIcon status={pullStatus(item.state)} size={12} /> Pull request · {item.state}
                      <TiedBy via={item.via} />
                    </>
                  ) : item.kind === "item" ? (
                    <>
                      <ItemIcon item={{ state: (item.state === "closed" ? "closed" : "open") as State, reason: null }} size={12} /> Work item · {item.state}
                      <TiedBy via={item.via} />
                    </>
                  ) : (
                    <>
                      <GitCommitHorizontal size={12} /> Commits
                    </>
                  )}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** How it was tied to the session, faint after its kind: opened by it, claimed, by a commit. */
function TiedBy({ via }: { via: LinkVia[] }) {
  if (via.length === 0) return null;
  return <span className="truncate text-faint">· {via.map(viaLabel).join(", ")}</span>;
}

function DeliverablePreview({ item }: { item: Deliverable }) {
  if (item.kind === "commits") {
    return (
      <ul className="space-y-1 font-mono text-[0.6875rem] text-muted">
        {item.shas.slice(0, 3).map((sha) => (
          <li key={sha} className="flex items-center gap-1.5">
            <GitCommitHorizontal size={11} className="text-faint" />
            {sha.slice(0, 7)}
          </li>
        ))}
      </ul>
    );
  }
  // The page in miniature: its mark and number, and lines where its words are (the title is under it, in full).
  return (
    <div>
      <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted">
        {item.kind === "pull" ? (
          <PullIcon status={pullStatus(item.state)} size={12} />
        ) : (
          <ItemIcon item={{ state: (item.state === "closed" ? "closed" : "open") as State, reason: null }} size={12} />
        )}
        #{item.number}
      </p>
      <div aria-hidden="true" className="mt-2.5 space-y-2">
        <div className="h-1.5 w-4/5 rounded-full bg-raised" />
        <div className="h-1.5 w-3/5 rounded-full bg-raised" />
        <div className="h-1.5 w-2/5 rounded-full bg-raised" />
      </div>
    </div>
  );
}

/** The files it touched, by name: the first few, faint, under the Changed figure. */
export function FileNames({ paths, shown = 3 }: { paths: string[]; shown?: number }) {
  if (paths.length === 0) return null;
  return (
    <ul className="space-y-1 font-mono text-[0.6875rem] text-faint">
      {paths.slice(0, shown).map((path) => (
        <li key={path} className="truncate">
          <Hint label={path}>
            <span>{path.split("/").pop()}</span>
          </Hint>
        </li>
      ))}
      {paths.length > shown && <li>and {paths.length - shown} more</li>}
    </ul>
  );
}
