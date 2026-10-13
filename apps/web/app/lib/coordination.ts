/**
 * Coordinating work, as the site shows it: who is on which issue (claims),
 * which harness sessions are running, what the merge queue found when it
 * combined changes, and the decision records behind the result. Pure: the
 * pages and components/coordination.tsx draw what these say.
 */
import type {
  Claim,
  ClaimState,
  Decision,
  DecisionConfidence,
  EventType,
  G1tEvent,
  Harness,
  LinkVia,
  SessionState,
  TouchKind,
  WorkSession,
} from "@g1t/contracts";

/** How each harness is named. */
export const HARNESS_NAMES: Record<Harness, string> = {
  claude_code: "Claude Code",
  claude_managed_agents: "Claude Managed Agents",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Another harness",
};

export function harnessName(harness: Harness | null | undefined): string | null {
  return harness ? (HARNESS_NAMES[harness] ?? harness) : null;
}

/** The coordination events the Work page lists, newest first. */
export const COORDINATION_TYPES = [
  "work.claimed",
  "work.released",
  "work.claim_expired",
  "work.handoff_requested",
  "session.started",
  "session.ended",
  "dependency.changed",
  "overlap.detected",
  "integration.failed",
  "integration.passed",
  "decision.recorded",
] as const satisfies readonly EventType[];

export type CoordinationType = (typeof COORDINATION_TYPES)[number];

// ── Time ────────────────────────────────────────────────────────────────

const MINUTE = 60_000;

/** "4m", "1h 20m", "2h": a span, for "expires in …". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** When an active claim lapses, in words; null for one that is not active. */
export function expiresIn(claim: Pick<Claim, "state" | "expiresAt">, now: number): string | null {
  if (claim.state !== "active") return null;
  const left = new Date(claim.expiresAt).getTime() - now;
  return left <= 0 ? "expiring now" : `expires in ${span(left)}`;
}

/** What became of a claim that is no longer active. */
export const CLAIM_ENDED: Record<Exclude<ClaimState, "active">, string> = {
  released: "Released",
  expired: "Expired",
  handed_off: "Handed off",
};

export const SESSION_STATES: Record<SessionState, { label: string; hint: string }> = {
  active: { label: "Active", hint: "Heard from in the last 15 minutes." },
  idle: { label: "Idle", hint: "Not heard from for 15 minutes. It may still come back." },
  ended: { label: "Ended", hint: "Ended, or not heard from for 2 hours." },
};

// ── Live now ────────────────────────────────────────────────────────────

/** One issue being worked on: its claims and the sessions on it. */
export type LiveIssue = { issue: number; claims: Claim[]; sessions: WorkSession[] };

/**
 * Active claims and sessions grouped by the issue they are on, the issue
 * with the most recent activity first; sessions on no issue last, together.
 */
export function liveByIssue(claims: Claim[], sessions: WorkSession[]): { issues: LiveIssue[]; loose: WorkSession[] } {
  const byIssue = new Map<number, LiveIssue>();
  const at = (issue: number) => {
    let group = byIssue.get(issue);
    if (!group) byIssue.set(issue, (group = { issue, claims: [], sessions: [] }));
    return group;
  };
  for (const claim of claims) at(claim.issue).claims.push(claim);
  const loose: WorkSession[] = [];
  for (const session of sessions) {
    if (session.issue != null) at(session.issue).sessions.push(session);
    else loose.push(session);
  }
  const latest = (group: LiveIssue) =>
    Math.max(
      0,
      ...group.claims.map((claim) => Date.parse(claim.createdAt)),
      ...group.sessions.map((session) => Date.parse(session.lastSeenAt)),
    );
  return { issues: [...byIssue.values()].sort((a, b) => latest(b) - latest(a) || a.issue - b.issue), loose };
}

// ── Decisions ───────────────────────────────────────────────────────────

export const CONFIDENCE: Record<DecisionConfidence, { label: string; hint: string; tone: "neutral" | "info" | "success" }> = {
  claimed: { label: "Claimed", hint: "Someone said so: an agent or a person recorded it.", tone: "neutral" },
  tested: { label: "Tested", hint: "A check or the merge queue proved it.", tone: "info" },
  approved: { label: "Approved", hint: "A person approved it.", tone: "success" },
};

export const DECISION_KINDS: Record<Decision["kind"], string> = {
  proposal: "Proposal",
  claim: "Claim",
  integration_failure: "Failed together",
  integration_passed: "Passed together",
  fix: "Fix",
  approval: "Approval",
  merge: "Merge",
  note: "Note",
};

/** The check a decision's evidence names. */
export type EvidenceCheck = { name: string; conclusion: string; url: string | null };

/** What a decision rests on, read from its evidence as far as it says. */
export type Evidence = {
  commit: string | null;
  check: EvidenceCheck | null;
  /** The pull requests tested together, in queue order. */
  combination: number[];
  /** Those ahead it fails with. */
  suspects: number[];
  bisected: boolean;
};

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
}

export function evidenceOf(decision: Pick<Decision, "evidence">): Evidence {
  const raw = (decision.evidence ?? {}) as Record<string, unknown>;
  const check = raw.check && typeof raw.check === "object" ? (raw.check as Record<string, unknown>) : null;
  return {
    commit: typeof raw.commit === "string" ? raw.commit : null,
    check:
      check && typeof check.name === "string"
        ? {
            name: check.name,
            conclusion: typeof check.conclusion === "string" ? check.conclusion : "failure",
            url: typeof check.url === "string" && check.url ? check.url : null,
          }
        : null,
    combination: numbers(raw.combination),
    suspects: numbers(raw.suspects),
    bisected: raw.bisected === true,
  };
}

/** Where a check's address leads on the site: its path when it is g1t's own, else the address as it is. */
export function checkHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "g1t.sh" || parsed.hostname.endsWith(".g1t.sh")) return parsed.pathname + parsed.search;
    return url;
  } catch {
    return url.startsWith("/") ? url : null;
  }
}

/**
 * The integration failure a pull request still answers for: its latest
 * `integration_failure`, unless it passed in the queue or merged since.
 * `decisions` in any order.
 */
export function standingFailure(decisions: Decision[], pull?: number): Decision | null {
  const mine = decisions
    .filter((decision) => pull == null || decision.pull === pull)
    .filter((decision) => ["integration_failure", "integration_passed", "merge"].includes(decision.kind))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return mine[0]?.kind === "integration_failure" ? mine[0] : null;
}

/** The decisions after a failure that answer it: a fix recorded since, and a combination that then passed. */
export function resolutionOf(decisions: Decision[], failure: Decision): { fix: Decision | null; passed: Decision | null } {
  const after = decisions
    .filter((decision) => Date.parse(decision.createdAt) > Date.parse(failure.createdAt))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return {
    fix: after.find((decision) => decision.kind === "fix" && (decision.pull === failure.pull || decision.issue === failure.issue)) ?? null,
    passed: after.find((decision) => decision.kind === "integration_passed" && decision.pull === failure.pull) ?? null,
  };
}

// ── The feed ────────────────────────────────────────────────────────────

/** One line of the coordination feed: what happened, in words, and what it links to. */
export type FeedLine = {
  id: string;
  time: string;
  type: CoordinationType;
  /** Who did it, by username; null for g1t itself. */
  who: string | null;
  /** The harness it came from, when it says. */
  harness: Harness | null;
  /** The sentence, after the name. Numbers in it are written `#N`. */
  text: string;
  /** The issue or pull request it is about. */
  number: number | null;
  /** The harness session it is about, by id, for a link to its page. */
  session?: string;
  tone: "neutral" | "accent" | "success" | "warn" | "danger" | "info";
};

const list = (all: number[]) => all.map((n) => `#${n}`).join(", ");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A coordination event as a line of the feed, or null for one it does not show. */
export function feedLine(event: G1tEvent): FeedLine | null {
  const base = { id: event.id, time: event.time, harness: null as Harness | null, number: null as number | null };
  const data = event.data as Record<string, unknown> & { number?: number };
  const number = typeof data.number === "number" ? data.number : null;
  switch (event.type) {
    case "work.claimed": {
      const { claim, others = [], tookOver } = event.data;
      const also = others.length > 0 ? ` (${others.map((other) => other.actor.username).join(", ")} ${plural(others.length, "is", "are")} on it too)` : "";
      return {
        ...base,
        type: event.type,
        who: claim.actor.username,
        harness: claim.harness,
        text: `${tookOver ? "took over" : "claimed"} #${claim.issue}${also}`,
        number: claim.issue,
        tone: others.length > 0 ? "warn" : "accent",
      };
    }
    case "work.released": {
      const { claim, reason } = event.data;
      return {
        ...base,
        type: event.type,
        who: claim.actor.username,
        harness: claim.harness,
        text: reason === "issue_closed" ? `no longer holds #${claim.issue}: the issue closed` : `released #${claim.issue}${reason ? `: ${reason}` : ""}`,
        number: claim.issue,
        tone: "neutral",
      };
    }
    case "work.claim_expired": {
      const { claim } = event.data;
      return { ...base, type: event.type, who: claim.actor.username, harness: claim.harness, text: `let the claim on #${claim.issue} expire`, number: claim.issue, tone: "neutral" };
    }
    case "work.handoff_requested": {
      const { claim, to, note } = event.data;
      return {
        ...base,
        type: event.type,
        who: claim.actor.username,
        harness: claim.harness,
        text: `handed #${claim.issue} off to ${to ?? "anyone"}${note ? `: ${note}` : ""}`,
        number: claim.issue,
        tone: "info",
      };
    }
    case "session.started":
    case "session.ended": {
      const { session } = event.data;
      const on = session.issue != null ? ` on #${session.issue}` : session.pull != null ? ` on #${session.pull}` : "";
      const why = event.type === "session.ended" && session.endReason === "timed_out" ? " (timed out)" : "";
      return {
        ...base,
        type: event.type,
        who: session.actor.username,
        harness: session.harness,
        text: `${event.type === "session.started" ? "started a session" : "ended a session"}${on}${why}`,
        number: session.issue ?? session.pull,
        tone: event.type === "session.started" ? "accent" : "neutral",
      };
    }
    case "dependency.changed": {
      const { issue, added, removed, cleared, remaining, mergedPull } = event.data;
      const parts = [
        added.length > 0 && `now waits on ${list(added)}`,
        removed.length > 0 && `no longer waits on ${list(removed)}`,
        cleared.length > 0 && `${list(cleared)} ${mergedPull ? `landed (#${mergedPull} merged)` : "closed"}`,
      ].filter(Boolean);
      // What it still waits on, unless that is only what was just added.
      const said = remaining.every((n) => added.includes(n)) && parts.length > 0;
      const left = remaining.length === 0 ? "unblocked" : said ? null : `still waits on ${list(remaining)}`;
      return {
        ...base,
        type: event.type,
        who: null,
        text: `#${issue} ${[...parts, left].filter(Boolean).join("; ")}`,
        number: issue,
        tone: remaining.length === 0 ? "success" : "info",
      };
    }
    case "overlap.detected": {
      if ("sessionId" in event.data) {
        const { sessionId, otherActor, files, issue } = event.data;
        return {
          ...base,
          type: event.type,
          who: otherActor,
          text: `touched the same ${plural(files.length, "file", "files")} in a session as another session: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`,
          number: issue ?? number,
          session: sessionId,
          tone: "warn",
        };
      }
      const { pull, otherPull, files } = event.data;
      return {
        ...base,
        type: event.type,
        who: null,
        text: `#${pull} and #${otherPull} change the same ${plural(files.length, "file", "files")}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`,
        number: pull,
        tone: "warn",
      };
    }
    case "integration.failed": {
      const { pull, combination, check, suspects } = event.data;
      const together = combination.length > 1 ? ` combined as ${list(combination)}` : " on its own";
      const with_ = suspects.length > 0 ? `; fails with ${list(suspects)}` : "";
      return { ...base, type: event.type, who: null, text: `#${pull} failed in the merge queue${together}: ${check.name}${with_}`, number: pull, tone: "danger" };
    }
    case "integration.passed": {
      const { pull, combination } = event.data;
      return {
        ...base,
        type: event.type,
        who: null,
        text: combination.length > 1 ? `#${pull} passed in the merge queue combined as ${list(combination)}` : `#${pull} passed in the merge queue`,
        number: pull,
        tone: "success",
      };
    }
    case "decision.recorded": {
      const { decision } = event.data;
      const kind = DECISION_KINDS[decision.kind as Decision["kind"]]?.toLowerCase() ?? decision.kind;
      return {
        ...base,
        type: event.type,
        who: decision.actor,
        text: `recorded ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}, ${decision.confidence}: ${decision.summary}`,
        number: decision.pull ?? decision.issue ?? number,
        tone: decision.kind === "integration_failure" ? "danger" : decision.confidence === "approved" ? "success" : "neutral",
      };
    }
    // Steps of a session as it goes: for the pages showing it, not the feed.
    case "session.progressed":
    default:
      return null;
  }
}

// ── Session trees ───────────────────────────────────────────────────────

/** A session with its subagents under it, and theirs under them. */
export type SessionNode = { session: WorkSession; children: SessionNode[] };

/**
 * Sessions as trees, by `parentId`: the roots in the order given, each
 * with its subagents in the order given. One whose parent is not in the
 * list is a root of its own.
 */
export function sessionTree(sessions: WorkSession[]): SessionNode[] {
  const nodes = new Map<string, SessionNode>();
  for (const session of sessions) if (!nodes.has(session.id)) nodes.set(session.id, { session, children: [] });
  const roots: SessionNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.session.parentId ? nodes.get(node.session.parentId) : undefined;
    // A parent that is the session itself or under it (a cycle) does not count.
    if (parent && !contains(node, parent)) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The sessions of several lists, each once (as the first list to have it says), in the order first given. */
export function mergeSessions(...lists: (WorkSession[] | null | undefined)[]): WorkSession[] {
  const seen = new Map<string, WorkSession>();
  for (const list of lists) for (const session of list ?? []) if (!seen.has(session.id)) seen.set(session.id, session);
  return [...seen.values()];
}

function contains(node: SessionNode, target: SessionNode): boolean {
  return node === target || node.children.some((child) => contains(child, target));
}

/** How many sessions are under a tree's root, at any depth. */
export function treeSize(node: SessionNode): number {
  return node.children.reduce((total, child) => total + 1 + treeSize(child), 0);
}

/** How a session was tied to an issue or pull request, in a few words. */
export const VIA_LABELS: Record<LinkVia, string> = {
  attached: "attached",
  claim: "claimed",
  branch: "its branch",
  commit: "its commit",
  trailer: "commit trailer",
  opened: "opened it",
  ref: "named it",
};

export function viaLabel(via: LinkVia): string {
  return VIA_LABELS[via] ?? via;
}

/** What each kind of thing a session touched is called. */
export const TOUCH_KINDS: Record<TouchKind, string> = {
  file: "Files",
  commit: "Commits",
  branch: "Branches",
  pull: "Pull requests",
  issue: "Issues",
};

/** What was touched, grouped by kind in TOUCH_KINDS' order, each value once, in the order given. */
export function touchedByKind(touched: { kind: TouchKind; value: string }[]): { kind: TouchKind; values: string[] }[] {
  return (Object.keys(TOUCH_KINDS) as TouchKind[])
    .map((kind) => ({ kind, values: [...new Set(touched.filter((one) => one.kind === kind).map((one) => one.value))] }))
    .filter((group) => group.values.length > 0);
}

/** "12s", "4m", "1h 20m": how long a session ran, or has run until `now`. */
export function duration(session: Pick<WorkSession, "startedAt" | "endedAt" | "lastSeenAt" | "state">, now: number): string {
  const end = session.endedAt ? Date.parse(session.endedAt) : session.state === "ended" ? Date.parse(session.lastSeenAt) : now;
  const ms = Math.max(0, end - Date.parse(session.startedAt));
  return ms < MINUTE ? `${Math.floor(ms / 1000)}s` : span(ms);
}

/** Splits text at `#N`, for linking each number. */
export function numberedParts(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let last = 0;
  for (const match of text.matchAll(/#(\d+)\b/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** `blocked_by` as typed: numbers, with or without `#`, by commas or spaces; null when any is not one. */
export function parseBlockedBy(text: string): number[] | null {
  const words = text.split(/[\s,]+/).map((word) => word.trim().replace(/^#/, "")).filter(Boolean);
  if (words.some((word) => !/^\d+$/.test(word) || Number(word) <= 0)) return null;
  return [...new Set(words.map(Number))];
}
