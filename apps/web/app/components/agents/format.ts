/**
 * Agents mode's arithmetic and wording: how a session's status and kind
 * read, where it ran, how a routine's schedule and events read, a tree of
 * sessions in order, memories by scope, a month's days and spend against
 * a cap. Pure, with type-only imports, so it can be tested.
 */
import type {
  AgentMemory,
  AgentMemoryScope,
  AgentSessionKind,
  AgentSessionStatus,
  RoutineSchedule,
  SpendSlice,
} from "@g1t/contracts";

export type Tone = "neutral" | "accent" | "info" | "warn" | "success" | "danger";

/** The statuses of a session that is not over (the contract's `SESSION_LIVE`). */
export const LIVE_STATUSES: readonly AgentSessionStatus[] = ["queued", "working", "waiting", "needs_approval"];

export function isLive(status: AgentSessionStatus | string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** A session's status chip: its words, its tone, and whether it is moving now (a soft pulse). The same words as its card in chat. */
export function sessionStatus(status: AgentSessionStatus | string): { label: string; tone: Tone; moving: boolean } {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "neutral", moving: false };
    case "working":
      return { label: "Working", tone: "accent", moving: true };
    case "waiting":
      return { label: "Waiting on helpers", tone: "info", moving: true };
    case "needs_approval":
      return { label: "Needs approval", tone: "warn", moving: false };
    case "done":
      return { label: "Done", tone: "success", moving: false };
    case "failed":
      return { label: "Failed", tone: "danger", moving: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral", moving: false };
    default:
      return { label: String(status), tone: "neutral", moving: false };
  }
}

const KINDS: Record<AgentSessionKind, string> = { chat: "Chat", routine: "Routine", helper: "Helper", subagent: "Subagent" };

/** Where a session came from, in a word. */
export function kindLabel(kind: AgentSessionKind | string): string {
  return KINDS[kind as AgentSessionKind] ?? String(kind);
}

/** The conversation, as a person reads it: `#releases`, or a direct message. */
export function whereLabel(at: { channel_kind: "channel" | "dm"; channel_name: string | null }): string {
  if (at.channel_kind === "channel" && at.channel_name) return `#${at.channel_name}`;
  return at.channel_kind === "dm" ? "A direct message" : "A channel";
}

/** How much of a cap is spent, 0 to 1 (more when over); null with no cap. */
export function shareOf(spent: number, cap: number | null | undefined): number | null {
  if (cap == null || cap <= 0) return null;
  return Math.max(0, spent) / cap;
}

/** A meter's tone: calm, then warning at 75%, then danger at 100%. */
export function meterTone(share: number | null): "accent" | "warn" | "danger" {
  if (share == null || share < 0.75) return "accent";
  return share >= 1 ? "danger" : "warn";
}

/**
 * A tree of sessions as rows, each child under its parent, children oldest
 * first. A session whose parent is not in the list is a root; roots keep the
 * list's order. Cycles (which never happen) cannot loop.
 */
export function sessionRows<T extends { id: string; parent_id: string | null; created_at: string }>(sessions: T[]): { session: T; depth: number }[] {
  const ids = new Set(sessions.map((s) => s.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    if (session.parent_id && ids.has(session.parent_id) && session.parent_id !== session.id) {
      children.set(session.parent_id, [...(children.get(session.parent_id) ?? []), session]);
    } else roots.push(session);
  }
  const out: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (session: T, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    out.push({ session, depth });
    const kids = [...(children.get(session.id) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Anything only reachable through a cycle still shows, at the top.
  for (const session of sessions) if (!seen.has(session.id)) walk(session, 0);
  return out;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(day: number): string {
  return WEEKDAYS[((day % 7) + 7) % 7]!;
}

const two = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");

/** "Every weekday at 09:00 UTC", "Every hour at :15", "Every Monday at 17:30 UTC". */
export function scheduleInWords(schedule: RoutineSchedule): string {
  const time = `${two(schedule.hour)}:${two(schedule.minute)} UTC`;
  switch (schedule.every) {
    case "hour":
      return schedule.minute === 0 ? "Every hour, on the hour" : `Every hour at :${two(schedule.minute)}`;
    case "day":
      return `Every day at ${time}`;
    case "weekday":
      return `Every weekday at ${time}`;
    case "week":
      return `Every ${weekdayName(schedule.weekday)} at ${time}`;
    default:
      return time;
  }
}

/** "A pull request is merged" → "When a pull request is merged". */
export function whenEvent(label: string): string {
  return `When ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * When a routine runs, in words: its schedule, its events (`labels` names
 * each), and the repositories they come from. "Every weekday at 09:00 UTC",
 * "When a pull request is ready for review · acme/web".
 */
export function routineInWords(
  routine: { schedule: RoutineSchedule | null; events?: readonly string[] | null; repos?: readonly string[] | null },
  labels: Record<string, string>,
): string {
  const parts: string[] = [];
  if (routine.schedule) parts.push(scheduleInWords(routine.schedule));
  const events = routine.events ?? [];
  if (events.length > 0) {
    const named = events.map((key) => labels[key] ?? key);
    const first = whenEvent(named[0]!);
    const rest = named.slice(1).map((label) => label.charAt(0).toLowerCase() + label.slice(1));
    parts.push([first, ...rest].join(", or "));
    const repos = routine.repos ?? [];
    parts.push(repos.length > 0 ? repos.join(", ") : "Any repository");
  }
  return parts.length > 0 ? parts.join(" · ") : "Never: it has no schedule or events";
}

/** A schedule from the dialog's fields: how often, a time as `HH:MM`, and a weekday. */
export function scheduleFrom(every: string, time: string, weekday: string | number): RoutineSchedule | null {
  if (every !== "hour" && every !== "day" && every !== "weekday" && every !== "week") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  const hour = match ? Number(match[1]) : 9;
  const minute = match ? Number(match[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const day = String(weekday ?? "").trim() === "" ? Number.NaN : Number(weekday);
  return { every, hour, minute, weekday: Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1 };
}

/** `HH:MM` for a time field. */
export function timeField(schedule: Pick<RoutineSchedule, "hour" | "minute">): string {
  return `${two(schedule.hour)}:${two(schedule.minute)}`;
}

/** Repositories typed as a list, `acme/web, acme/api`: each `workspace/name`, lowercased, once. Null when one isn't. */
export function reposFrom(text: string): string[] | null {
  const parts = String(text ?? "")
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.some((p) => !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+$/.test(p))) return null;
  return [...new Set(parts)];
}

export type MemoryGroup = { scope: AgentMemoryScope; title: string; about: string; memories: AgentMemory[] };

/**
 * Memories by scope, in the order the page shows them, pinned first in each.
 * Empty groups are left out.
 */
export function memoryGroups(memories: AgentMemory[]): MemoryGroup[] {
  const order = (a: AgentMemory, b: AgentMemory) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at);
  const groups: MemoryGroup[] = [
    { scope: "workspace", title: "Workspace", about: "Recalled anywhere in the workspace, for anyone.", memories: [] },
    { scope: "channel", title: "Conversations", about: "Recalled only in the channel each came from.", memories: [] },
    { scope: "person", title: "Just you", about: "Recalled only in your direct messages with it.", memories: [] },
  ];
  for (const memory of memories) groups.find((g) => g.scope === memory.scope)?.memories.push(memory);
  return groups.filter((g) => g.memories.length > 0).map((g) => ({ ...g, memories: [...g.memories].sort(order) }));
}

/**
 * Every day of a month (`YYYY-MM`) up to today when it is this month, with
 * its spend; days with none are 0.
 */
export function monthDays(period: string, days: { day: string; micros: number }[], now = new Date()): { day: string; micros: number }[] {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return days;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const inMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const thisMonth = now.getUTCFullYear() === year && now.getUTCMonth() === month;
  const last = thisMonth ? now.getUTCDate() : inMonth;
  const spent = new Map(days.map((d) => [d.day, d.micros]));
  const out: { day: string; micros: number }[] = [];
  for (let d = 1; d <= last; d++) {
    const key = `${period}-${two(d)}`;
    out.push({ day: key, micros: spent.get(key) ?? 0 });
  }
  return out;
}

/** The first `n` slices, and the rest folded into one "Everything else". */
export function topSlices(slices: SpendSlice[], n = 5): SpendSlice[] {
  if (slices.length <= n + 1) return slices;
  const rest = slices.slice(n);
  return [
    ...slices.slice(0, n),
    {
      key: "__rest",
      label: `${rest.length} more`,
      micros: rest.reduce((sum, s) => sum + s.micros, 0),
      count: rest.reduce((sum, s) => sum + s.count, 0),
    },
  ];
}

/** "in 5m", "in 3h", "in 2d"; "now" when due. */
export function untilLabel(at: string, now = Date.now()): string {
  const ms = new Date(at).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 60_000) return "now";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

/** A short day for an axis or a hint: "Oct 3". */
export function shortDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A month key as words: "October 2026". */
export function monthName(period: string): string {
  const at = new Date(`${period}-01T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return period;
  return at.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const FIELD_LABELS: Record<string, string> = {
  display_name: "name",
  handle: "handle",
  title: "title",
  team: "team",
  department: "department",
  role: "role",
  responsibilities: "responsibilities",
  subagents: "subagents",
  instructions: "job",
  personality_preset: "personality",
  personality: "personality",
  routing: "models",
  budget: "budget",
  autonomy: "what it may do alone",
  capacity: "capacity",
  avatar_seed: "face",
  faces: "who it works with",
};

/**
 * What changed between two saved versions of an agent, in words: "job,
 * budget". The first version (no `before`) is "Created".
 */
export function versionChanges(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
  if (!before) return "Created";
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    const label = FIELD_LABELS[key];
    if (label && !changed.includes(label)) changed.push(label);
  }
  if (changed.length === 0) return "Saved with no changes";
  const text = changed.join(", ");
  return `Changed ${text}`;
}
