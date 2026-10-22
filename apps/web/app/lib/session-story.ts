/**
 * A session's page told as an answer (routes/workspace/work/sessions/session.tsx,
 * components/session-story.tsx): first what it came to, in its own words;
 * then a few figures (how long it worked and how busily, what it changed,
 * what it cost); then the highlights, each citing where it comes from; then
 * what it delivered. The transcript is the evidence, folded under them.
 * No Workers or React imports, so it can be tested under Node.
 */
import type { Decision, LinkVia, SessionEntry, SessionLink, SessionTouch, WorkSession } from "@g1t/contracts";

import { isAcknowledgement } from "./coordination.ts";

/**
 * What the session came to, in its own words: what it reported, else, once
 * it has ended, the last thing it said. Null while it is still going and
 * has reported nothing: the transcript is the story so far.
 */
export function sessionAnswer(session: Pick<WorkSession, "result" | "state">, entries: SessionEntry[]): string | null {
  const reported = session.result?.trim();
  if (reported) return reported;
  if (session.state !== "ended") return null;
  const last = entries.findLast((entry) => entry.kind === "message" && !entry.withheld && entry.text.trim() !== "");
  return last?.text.trim() ?? null;
}

/** One bar of a session's activity: what it recorded in one slice of its run. */
export type ActivityBar = { from: number; to: number; entries: number; tools: number };

/**
 * How busily it worked: its run from start to end (or now) cut into `bars`
 * equal slices, with how many entries, and of them tool calls, each holds.
 * An entry outside the run (a clock that disagreed) counts in the nearest
 * slice. Empty when it recorded nothing.
 */
export function activity(entries: SessionEntry[], startedAt: string, endedAt: string | null, now: number, bars = 24): ActivityBar[] {
  if (entries.length === 0) return [];
  const start = Date.parse(startedAt);
  const end = Math.max(endedAt ? Date.parse(endedAt) : now, start + 1);
  const width = (end - start) / bars;
  const out: ActivityBar[] = Array.from({ length: bars }, (_, index) => ({
    from: start + index * width,
    to: start + (index + 1) * width,
    entries: 0,
    tools: 0,
  }));
  for (const entry of entries) {
    const index = Math.min(bars - 1, Math.max(0, Math.floor((Date.parse(entry.at) - start) / width)));
    const bar = out[index]!;
    bar.entries += 1;
    if (entry.kind === "tool_call") bar.tools += 1;
  }
  return out;
}

/** Where a highlight comes from: an entry of the transcript, or a decision kept on a pull request or work item. */
export type Citation = { kind: "entry"; seq: number } | { kind: "decision"; to: string };

export type Highlight = { text: string; at: string; cite: Citation };

/** At most this many highlights: the page is a summary. */
const MAX_HIGHLIGHTS = 6;

/**
 * The highlights: the decisions the session (or its subagents, `ids`) kept,
 * each citing the pull request or work item it was kept on, and the notes
 * it wrote, each citing its place in the transcript; oldest first, at most
 * six, the latest kept when there are more. `where` gives a decision's
 * page: its pull request, else its work item.
 */
export function highlights(
  decisions: Decision[],
  entries: SessionEntry[],
  ids: ReadonlySet<string>,
  where: (decision: Decision) => string | null,
): Highlight[] {
  const kept = decisions
    .filter((decision) => decision.sessionId != null && ids.has(decision.sessionId))
    .flatMap((decision): Highlight[] => {
      const to = where(decision);
      return to ? [{ text: decision.summary, at: decision.createdAt, cite: { kind: "decision", to } }] : [];
    });
  const notes = entries
    // Acknowledging coordination updates is bookkeeping, not something the session did.
    .filter((entry) => entry.kind === "note" && !entry.withheld && entry.text.trim() !== "" && !isAcknowledgement(entry.text))
    .map((entry): Highlight => ({ text: entry.text.trim(), at: entry.at, cite: { kind: "entry", seq: entry.seq } }));
  // One decision recorded twice (on the pull request and its work item) is one highlight.
  const seen = new Set<string>();
  return [...kept, ...notes]
    .filter((highlight) => !seen.has(highlight.text) && seen.add(highlight.text))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_HIGHLIGHTS);
}

/** Something the session delivered, as its card shows it. */
export type Deliverable =
  | { kind: "pull"; number: number; title: string; state: string; via: LinkVia[] }
  | { kind: "item"; number: number; title: string; state: string; via: LinkVia[] }
  | { kind: "commits"; shas: string[] };

/**
 * What it delivered: its pull requests, then the work items it worked on
 * (each with how it was tied to the session),
 * then its commits as one card, each once, in the order it touched them.
 */
export function deliverables(links: SessionLink[], touched: SessionTouch[]): Deliverable[] {
  const pulls = links
    .filter((link) => link.kind === "pull")
    .map((link): Deliverable => ({ kind: "pull", number: link.number, title: link.title, state: link.state, via: link.via }));
  const items = links
    .filter((link) => link.kind === "item")
    .map((link): Deliverable => ({ kind: "item", number: link.number, title: link.title, state: link.state, via: link.via }));
  const shas = [...new Set(touched.filter((touch) => touch.kind === "commit").map((touch) => touch.value))];
  return [...pulls, ...items, ...(shas.length > 0 ? [{ kind: "commits" as const, shas }] : [])];
}

/** The files it touched, each once, in the order it touched them. */
export function filesTouched(touched: SessionTouch[]): string[] {
  return [...new Set(touched.filter((touch) => touch.kind === "file").map((touch) => touch.value))];
}
