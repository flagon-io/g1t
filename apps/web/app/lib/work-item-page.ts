/**
 * A work item's page, worked out: its keys, the list it was opened from
 * (for J and K), its Activity's filter, the stage it is in and why, and
 * what the pickers read from what is typed. Pure, so it is tested under
 * Node; the page draws it (routes/workspace/work/item.tsx).
 */
import type { Appetite, Claim, Horizon, WorkItem, WorkPull, WorkSession } from "@g1t/contracts";

import { STAGE_INFO, type Stage, stageOf } from "./board.ts";

export { ITEM_KEYS, type ItemCommand, itemCommandOf, keyFor } from "./item-keys.ts";
export { TRAIL_LIMIT, type WorkTrail, neighbours, trailOf, trailState } from "./work-trail.ts";

// --- Activity ---------------------------------------------------------------

export type ActivityFilter = "all" | "comments" | "events";

export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "comments", label: "Comments" },
  { value: "events", label: "Events" },
];

/** The filter an address asks for (`?activity=comments`); All otherwise. */
export function activityFilterOf(value: string | null | undefined): ActivityFilter {
  return ACTIVITY_FILTERS.find((one) => one.value === value)?.value ?? "all";
}

/**
 * The Activity stream, filtered: what people wrote is a comment; what
 * happened (a note the service wrote, `kind: "event"`, and every extra:
 * sessions, claims, handoffs) is an event. The conversation draws the
 * rest, oldest first (lib/comments.ts `interleave`).
 */
export function activityParts<C extends { kind: string }, X>(
  comments: readonly C[],
  extras: readonly X[],
  filter: ActivityFilter,
): { comments: C[]; extras: X[] } {
  if (filter === "comments") return { comments: comments.filter((one) => one.kind !== "event"), extras: [] };
  if (filter === "events") return { comments: comments.filter((one) => one.kind === "event"), extras: [...extras] };
  return { comments: [...comments], extras: [...extras] };
}

/** How many of each the stream holds, for the filter's buttons. */
export function activityCounts(comments: readonly { kind: string }[], extras: number): Record<ActivityFilter, number> {
  const events = comments.filter((one) => one.kind === "event").length + extras;
  return { all: comments.length + extras, comments: comments.length - (events - extras), events };
}

// --- Stage, with why ----------------------------------------------------------

/** The stage a work item is in, as Work's board reads it (lib/board.ts), with why in a few words. */
export type ItemStage = { stage: Stage | "closed"; label: string; why: string };

/**
 * Its stage, read from what is so, and the facts that put it there: "In
 * review: #318 open in acme/web". A closed one is Done for 14 days, then
 * Closed; one closed as not planned is Closed.
 */
export function itemStage(
  item: WorkItem,
  facts: {
    repos?: readonly { path: string; pulls: readonly Pick<WorkPull, "number" | "status">[] }[];
    claims?: readonly Claim[];
    sessions?: readonly WorkSession[];
  },
  now: number,
): ItemStage {
  const repos = facts.repos ?? [];
  const pulls = repos.flatMap((repo) => repo.pulls.map((pull) => ({ ...pull, repo: repo.path })));
  const claims = (facts.claims ?? []).filter((claim) => claim.state === "active");
  const live = (facts.sessions ?? []).filter((session) => session.state !== "ended" && !session.parentId);
  const stage = stageOf(
    item,
    {
      pulls: pulls.map((pull) => ({ key: `${pull.repo}#${pull.number}`.toLowerCase(), status: pull.status, part: false })),
      claimed: claims.length > 0,
      live: live.length > 0,
    },
    now,
  );
  if (stage == null) {
    return { stage: "closed", label: "Closed", why: item.reason === "not_planned" ? "Closed as not planned" : "Closed" };
  }
  const label = STAGE_INFO[stage].label;
  const pullAt = (pull: (typeof pulls)[number]) => `#${pull.number} ${pull.status === "draft" ? "draft" : pull.status} in ${pull.repo}`;
  switch (stage) {
    case "done":
      return {
        stage,
        label,
        why: item.resolutions.length > 0 ? `Landed in ${[...new Set(item.resolutions.map((one) => one.repo))].join(", ")}` : "Closed as completed",
      };
    case "landing": {
      const missing = item.repos.filter((repo) => repo.role === "target" && !repo.landed).map((repo) => repo.path);
      return { stage, label, why: missing.length > 0 ? `Still to land in ${missing.join(", ")}` : "Landing" };
    }
    case "review": {
      const open = pulls.filter((pull) => pull.status === "open");
      return { stage, label, why: open.map(pullAt).join(", ") };
    }
    case "progress": {
      const reasons: string[] = [];
      if (claims.length > 0) reasons.push(`claimed by ${[...new Set(claims.map((claim) => claim.actor.username))].join(", ")}`);
      if (live.length > 0) reasons.push(live.length === 1 ? "a session on it" : `${live.length} sessions on it`);
      const drafts = pulls.filter((pull) => pull.status === "draft");
      if (drafts.length > 0) reasons.push(drafts.map(pullAt).join(", "));
      if (reasons.length === 0 && item.assignees.length > 0) reasons.push(`assigned to ${item.assignees.join(", ")}`);
      if (reasons.length === 0 && pulls.some((pull) => pull.status === "merged")) reasons.push("a pull request merged without closing it");
      const text = reasons.join(", ");
      return { stage, label, why: text.charAt(0).toUpperCase() + text.slice(1) };
    }
    default:
      return { stage, label, why: "Nobody is on it yet" };
  }
}

// --- What the pickers read ----------------------------------------------------

/** A work item as a picker lists it (routes/workspace/work/items-json.ts). */
export type ItemChoice = { number: number; title: string; state: "open" | "closed" };

/**
 * A budget typed in the Plan picker, `5`, `$12.50` or `none`: dollars, or
 * null to clear it; undefined when what is typed is no budget.
 */
export function budgetOf(text: string): number | null | undefined {
  const word = text.trim().toLowerCase().replace(/^\$/, "");
  if (word === "none" || word === "no budget") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(word)) return undefined;
  const dollars = Number(word);
  return dollars > 0 && dollars <= 100_000 ? dollars : undefined;
}

/** A work item's number typed in a picker (`#212`, `212`), or null. */
export function typedNumber(text: string): number | null {
  const word = text.trim().replace(/^#/, "");
  return /^\d{1,9}$/.test(word) && Number(word) > 0 ? Number(word) : null;
}

/** A username typed in the assignee picker (`@ana`, `ana`), tidied; null for none or anything that cannot be one. */
export function typedUsername(text: string): string | null {
  const word = text.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(word) ? word : null;
}

/** A set with `value` taken out when it is in it, or added at the end when it is not. */
export function toggled<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((one) => one !== value) : [...values, value];
}

/** Whether two lists hold the same values, in any order. */
export function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((one) => b.includes(one));
}

/** The plan as one line for the panel: `Now · M · $5 · Urgent`. */
export function planSummary(
  item: { horizon: Horizon; appetite: Appetite | null; budgetUsd: number | null; urgent: boolean },
  horizonLabel: (h: Horizon) => string,
): string {
  const parts = [horizonLabel(item.horizon)];
  if (item.appetite) parts.push(item.appetite.charAt(0).toUpperCase());
  if (item.budgetUsd != null) parts.push(`$${Number.isInteger(item.budgetUsd) ? item.budgetUsd : item.budgetUsd.toFixed(2)}`);
  if (item.urgent) parts.push("Urgent");
  return parts.join(" · ");
}
