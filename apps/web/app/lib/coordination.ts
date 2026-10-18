/**
 * Coordinating work, as the site shows it: who is on which work item (claims),
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

/** The coordination events the Sessions page lists, newest first. */
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
  ended: { label: "Ended", hint: "Ended, or not heard from for 30 minutes. One that went quiet comes back when it is heard from again." },
};

// ── Ending a session by hand ────────────────────────────────────────────

/** How the reason of a session ended by hand starts (g1t_contracts::work::ENDED_BY_HAND). */
export const ENDED_BY_HAND = "ended by hand by @";

/**
 * Whether the viewer may end a session by hand, for one its harness left
 * behind: one not ended yet, their own, or anyone's when they have write
 * access (`canPush`) to the repository. The work service checks the same.
 * One g1t runs on the workspace's Anthropic account is stopped from its
 * page instead, which stops the run too.
 */
export function mayEndSession(
  session: Pick<WorkSession, "state" | "actor" | "harness">,
  viewerId: string | null | undefined,
  canPush: boolean,
): boolean {
  if (!viewerId || session.state === "ended" || session.harness === "claude_managed_agents") return false;
  return session.actor.id === viewerId || canPush;
}

/** Who may end which session from a list: the viewer, and whether they may end anyone's. */
export type SessionEnder = { viewerId: string | null; canPush: boolean };

/** Why a session ended, in words: "timed out", "ended by hand by @ana", or what its harness said. */
export function endReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason === "timed_out" ? "timed out" : reason;
}

// ── Session titles ──────────────────────────────────────────────────────

/** The most of a prompt's intent that titles a session. */
export const TITLE_LIMIT = 80;

/** A turn the harness starts itself, as a tag: `<command-name>`, `<task-notification>`, one with attributes. */
const HARNESS_TAG = /^\s*<[a-z][\w-]*(?:\s[^>]*)?>/i;

/** What an editor adds ahead of a prompt, a whole block at a time: `<ide_opened_file>…</ide_opened_file>`. */
const IDE_CONTEXT = /^\s*<(ide_[a-z_]+|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/i;

/**
 * What a prompt is for, as a session's title: its first line or sentence,
 * without code blocks or markdown, whitespace collapsed, clipped at
 * TITLE_LIMIT on a word with "…". Null for a slash command, a turn the
 * harness starts itself, or nothing to say. The Claude Code plugin
 * (plugins/claude-code/hooks/g1t.mjs) titles its sessions the same way.
 */
export function intentTitle(prompt: string | null | undefined): string | null {
  let text = String(prompt ?? "").replace(/^\uFEFF/, "");
  // What the harness pasted in or attached is not what the prompt is for:
  // pasted text (Claude Code's <pasted_content id="…">…</pasted_content>)
  // and image placeholders ([Image #1], [Image: source: …]) go first.
  text = text
    .replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/gi, "\n")
    .replace(/\[Image(?: #\d+)?(?::[^\]\n]*)?\]/g, " ");
  // Context an editor puts before what was typed (VS Code's
  // <ide_opened_file>, <ide_selection>) is not a turn the harness started.
  while (IDE_CONTEXT.test(text)) text = text.replace(IDE_CONTEXT, "");
  if (/^\s*\//.test(text) || HARNESS_TAG.test(text)) return null;
  text = text
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "").replace(/(\*\*|__|~~)(.+?)\1/g, "$2").trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return null;
  let intent = line.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=\S)/)[0].trim();
  if (intent.length > TITLE_LIMIT) {
    const cut = intent.slice(0, TITLE_LIMIT - 1);
    const space = cut.lastIndexOf(" ");
    intent = `${(space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
  } else {
    intent = intent.replace(/[\s,;:.]+$/, "");
  }
  if (intent.length < 2) return null;
  return intent[0].toLocaleUpperCase() + intent.slice(1);
}

/**
 * What a session is called, never nothing: its title, else what its first
 * prompt was for, else the branch it is on, else "Untitled session".
 * `firstPrompt` stands in for the session's own when given.
 */
export function sessionTitle(
  session: Pick<WorkSession, "title" | "branch" | "firstPrompt">,
  firstPrompt: string | null | undefined = session.firstPrompt,
): string {
  // A title that is only a harness tag (an early plugin's from a pasted prompt) reads as none.
  const title = session.title?.trim();
  if (title && !HARNESS_TAG.test(title)) return title;
  const intent = intentTitle(firstPrompt);
  if (intent) return intent;
  return session.branch ? `Session on ${session.branch}` : "Untitled session";
}

// ── Live now ────────────────────────────────────────────────────────────

/** One work item being worked on: its claims and the sessions on it. */
export type LiveItem = { item: number; claims: Claim[]; sessions: WorkSession[] };

/** Sessions on no work item yet, together: on one pull request, on one branch of their own, or on neither. */
export type LiveGroup =
  | { kind: "pull"; pull: number; sessions: WorkSession[] }
  | { kind: "branch"; branch: string; sessions: WorkSession[] }
  | { kind: "none"; sessions: WorkSession[] };

/**
 * Whether a session has done nothing since it started: no title, no work item
 * or pull request, never heard from again. Opening a Claude Code tab starts
 * one before anything is typed in it, and it is nothing to show yet.
 */
export function startedOnly(session: WorkSession): boolean {
  return !session.title && session.item == null && session.pull == null && session.lastSeenAt === session.startedAt;
}

/**
 * The sessions Live now lists, and those it folds away: one not heard from
 * for 15 minutes (idle) is someone's open tab more often than work going
 * on, so it waits under the list until it is heard from or times out. One
 * that has done nothing since it started is in neither.
 */
export function awakeAndIdle(sessions: WorkSession[]): { awake: WorkSession[]; idle: WorkSession[] } {
  const awake: WorkSession[] = [];
  const idle: WorkSession[] = [];
  for (const session of sessions) {
    if (!startedOnly(session)) (session.state === "idle" ? idle : awake).push(session);
  }
  idle.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  return { awake, idle };
}

const latestSeen = (sessions: WorkSession[]) => Math.max(0, ...sessions.map((session) => Date.parse(session.lastSeenAt)));

/**
 * Active claims and sessions grouped by the work item they are on, the item
 * with the most recent activity first. Sessions on no work item are grouped
 * after them (`groups`): by their pull request, else by their branch when
 * it is not `defaultBranch`, the most recently heard from first; the rest,
 * on no branch of their own, last together. `loose` is every session on no
 * work item, as the groups hold them.
 */
export function liveByItem(
  claims: Claim[],
  sessions: WorkSession[],
  defaultBranch?: string | null,
): { items: LiveItem[]; groups: LiveGroup[]; loose: WorkSession[] } {
  const byItem = new Map<number, LiveItem>();
  const at = (item: number) => {
    let group = byItem.get(item);
    if (!group) byItem.set(item, (group = { item, claims: [], sessions: [] }));
    return group;
  };
  for (const claim of claims) at(claim.item).claims.push(claim);
  const byPull = new Map<number, LiveGroup & { kind: "pull" }>();
  const byBranch = new Map<string, LiveGroup & { kind: "branch" }>();
  const rest: WorkSession[] = [];
  for (const session of sessions) {
    if (session.item != null) at(session.item).sessions.push(session);
    else if (session.pull != null) {
      const group = byPull.get(session.pull) ?? { kind: "pull" as const, pull: session.pull, sessions: [] };
      byPull.set(session.pull, group);
      group.sessions.push(session);
    } else if (session.branch && session.branch !== defaultBranch) {
      const group = byBranch.get(session.branch) ?? { kind: "branch" as const, branch: session.branch, sessions: [] };
      byBranch.set(session.branch, group);
      group.sessions.push(session);
    } else rest.push(session);
  }
  const latest = (group: LiveItem) => Math.max(latestSeen(group.sessions), ...group.claims.map((claim) => Date.parse(claim.createdAt)));
  const recent = (a: LiveGroup, b: LiveGroup) => latestSeen(b.sessions) - latestSeen(a.sessions);
  const groups: LiveGroup[] = [...byPull.values(), ...byBranch.values()].sort(recent);
  if (rest.length > 0) groups.push({ kind: "none", sessions: rest });
  for (const group of groups) group.sessions.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  return {
    items: [...byItem.values()].sort((a, b) => latest(b) - latest(a) || a.item - b.item),
    groups,
    loose: groups.flatMap((group) => group.sessions),
  };
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
    fix: after.find((decision) => decision.kind === "fix" && (decision.pull === failure.pull || decision.item === failure.item)) ?? null,
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
  /** The work item or pull request it is about. */
  number: number | null;
  /** The harness session it is about, by id, for a link to its page. */
  session?: string;
  tone: "neutral" | "accent" | "success" | "warn" | "danger" | "info";
};

const list = (all: number[]) => all.map((n) => `#${n}`).join(", ");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A session's pending updates as lines of the feed, oldest first. */
export function pendingLines(updates: { id: string; kind: string; data: unknown; at: string }[]): FeedLine[] {
  return updates.flatMap((update) => {
    if (!(COORDINATION_TYPES as readonly string[]).includes(update.kind)) return [];
    const event = { id: update.id, type: update.kind, time: update.at, source: "work", repoId: null, actor: null, data: update.data } as G1tEvent;
    return feedLine(event) ?? [];
  });
}

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
        text: `${tookOver ? "took over" : "claimed"} #${claim.item}${also}`,
        number: claim.item,
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
        text: reason === "item_closed" ? `no longer holds #${claim.item}: the work item closed` : `released #${claim.item}${reason ? `: ${reason}` : ""}`,
        number: claim.item,
        tone: "neutral",
      };
    }
    case "work.claim_expired": {
      const { claim } = event.data;
      return { ...base, type: event.type, who: claim.actor.username, harness: claim.harness, text: `let the claim on #${claim.item} expire`, number: claim.item, tone: "neutral" };
    }
    case "work.handoff_requested": {
      const { claim, to, note } = event.data;
      return {
        ...base,
        type: event.type,
        who: claim.actor.username,
        harness: claim.harness,
        text: `handed #${claim.item} off to ${to ?? "anyone"}${note ? `: ${note}` : ""}`,
        number: claim.item,
        tone: "info",
      };
    }
    case "session.started":
    case "session.ended": {
      const { session } = event.data;
      const on = session.item != null ? ` on #${session.item}` : session.pull != null ? ` on #${session.pull}` : "";
      const why = event.type === "session.ended" && session.endReason === "timed_out" ? " (timed out)" : "";
      // Ended by hand: by whoever ran it, or by someone with write access for them.
      const byHand = event.type === "session.ended" && session.endReason?.startsWith(ENDED_BY_HAND) ? session.endReason.slice(ENDED_BY_HAND.length) : null;
      if (byHand) {
        const own = byHand === session.actor.username;
        return {
          ...base,
          type: event.type,
          who: byHand,
          harness: own ? session.harness : null,
          text: own ? `ended a session${on} by hand` : `ended ${session.actor.username}'s session${on} by hand`,
          number: session.item ?? session.pull,
          tone: "neutral",
        };
      }
      return {
        ...base,
        type: event.type,
        who: session.actor.username,
        harness: session.harness,
        text: `${event.type === "session.started" ? "started a session" : "ended a session"}${on}${why}`,
        number: session.item ?? session.pull,
        tone: event.type === "session.started" ? "accent" : "neutral",
      };
    }
    case "dependency.changed": {
      const { item, added, removed, cleared, remaining, mergedPull } = event.data;
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
        text: `#${item} ${[...parts, left].filter(Boolean).join("; ")}`,
        number: item,
        tone: remaining.length === 0 ? "success" : "info",
      };
    }
    case "overlap.detected": {
      if ("sessionId" in event.data) {
        const { sessionId, otherActor, files, item } = event.data;
        return {
          ...base,
          type: event.type,
          who: otherActor,
          text: `touched the same ${plural(files.length, "file", "files")} in a session as another session: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`,
          number: item ?? number,
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
        number: decision.pull ?? decision.item ?? number,
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

/** How a session was tied to a work item or pull request, in a few words. */
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
  item: "Work items",
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
