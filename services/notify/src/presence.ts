/**
 * Presence and status, apart from the Durable Objects that keep them: how
 * a person's open tabs make them active, away or offline; what a status
 * may say and when it clears; when Do Not Disturb holds. Pure, so the
 * rules are tested on their own (presence.test.ts).
 *
 * - **Presence** comes from the tabs: none open is `offline`; every tab
 *   idle (no input for a while, as each tab reports), or away set by hand,
 *   is `away`; otherwise `active`.
 * - **Status** is an emoji and a few words with an optional time it clears
 *   at. Past that time it is gone, whether or not anyone has looked.
 * - **Source**: a status set by hand is never replaced by a calendar's or
 *   an integration's; theirs replace each other.
 */
import type { OwnPresence, PersonStatus, Presence, PresenceChange, PresenceEntry, StatusSource } from "@g1t/contracts";

/** The longest a status's words may be. */
export const MAX_STATUS_TEXT = 100;
/** The longest an emoji may be: a flag or a family is several code points; `:custom-name:` fits too. */
const MAX_EMOJI = 40;
/** The furthest ahead a status or Do Not Disturb may be set to end: a year. */
export const MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;
/** How long the last tab may be gone before its person shows offline: a reload or a workspace switch is not leaving. */
export const OFFLINE_GRACE_MS = 30_000;

const SOURCES: readonly StatusSource[] = ["manual", "calendar", "integration"];

/** A tab as presence sees it. */
export type PresenceTab = { idle: boolean };

/** What the feed keeps of its person's presence. */
export type Kept = {
  away_manual: boolean;
  dnd_until: string | null;
  status: PersonStatus | null;
};

export const NOTHING_KEPT: Kept = { away_manual: false, dnd_until: null, status: null };

/** Presence from the open tabs and whether they set themselves away. */
export function presenceOf(tabs: PresenceTab[], awayManual: boolean): Presence {
  if (tabs.length === 0) return "offline";
  if (awayManual) return "away";
  return tabs.every((tab) => tab.idle) ? "away" : "active";
}

function time(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** A time to end at, checked: in the future and within a year; null when it is not one. */
export function futureTime(value: unknown, now: number): string | null {
  const at = time(typeof value === "string" ? value : null);
  if (at == null || at <= now || at > now + MAX_AHEAD_MS) return null;
  return new Date(at).toISOString();
}

/** Whether Do Not Disturb holds at `now`. */
export function dndOn(dndUntil: string | null | undefined, now: number): boolean {
  const at = time(dndUntil);
  return at != null && at > now;
}

/** A status as it stands at `now`: gone once its time has passed. */
export function liveStatus(status: PersonStatus | null | undefined, now: number): PersonStatus | null {
  if (!status) return null;
  const clear = time(status.clear_at);
  return clear != null && clear <= now ? null : status;
}

/** What is kept, with everything that has run out taken away. */
export function current(kept: Kept, now: number): Kept {
  return {
    away_manual: kept.away_manual,
    dnd_until: dndOn(kept.dnd_until, now) ? kept.dnd_until : null,
    status: liveStatus(kept.status, now),
  };
}

/** A status as sent, checked and trimmed; null when it says nothing. */
export function cleanStatus(value: unknown, now: number): PersonStatus | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const text = typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim().slice(0, MAX_STATUS_TEXT) : "";
  const emoji = typeof s.emoji === "string" ? s.emoji.trim().slice(0, MAX_EMOJI) : "";
  if (!text && !emoji) return null;
  const source = SOURCES.find((known) => known === s.source) ?? "manual";
  // A time already past, or too far off, is no time: kept until changed only when none was given.
  const clearAt = s.clear_at == null ? null : futureTime(s.clear_at, now);
  if (s.clear_at != null && clearAt == null) return null;
  return { emoji: emoji || null, text, clear_at: clearAt, source, set_at: new Date(now).toISOString() };
}

/**
 * What is kept after a change. A status from a calendar or an integration
 * never replaces one set by hand, and clearing from one of them clears only
 * a status of theirs.
 */
export function applyChange(before: Kept, change: PresenceChange | null | undefined, now: number): Kept {
  const kept = current(before, now);
  const c = (change && typeof change === "object" ? change : {}) as PresenceChange;
  const next: Kept = { ...kept };
  if (typeof c.away === "boolean") next.away_manual = c.away;
  if ("dnd_until" in c) next.dnd_until = c.dnd_until == null ? null : futureTime(c.dnd_until, now);
  if ("status" in c) {
    const source: StatusSource = (c.status && SOURCES.find((known) => known === c.status!.source)) || "manual";
    const byHand = kept.status?.source === "manual";
    if (source === "manual" || !byHand) next.status = c.status == null ? null : cleanStatus({ ...c.status, source }, now);
  }
  return next;
}

/** The next time something kept runs out, in ms; null when nothing will. */
export function nextExpiry(kept: Kept, now: number): number | null {
  const times = [time(kept.status?.clear_at), time(kept.dnd_until)].filter((at): at is number => at != null && at > now);
  return times.length ? Math.min(...times) : null;
}

/** How a person shows to others. */
export function entryOf(person: { user_id: string; username: string }, presence: Presence, kept: Kept, now: number): PresenceEntry {
  const live = current(kept, now);
  return { user_id: person.user_id, username: person.username, presence, dnd_until: live.dnd_until, status: live.status, at: now };
}

export function ownOf(entry: PresenceEntry, kept: Kept): OwnPresence {
  return { ...entry, away_manual: kept.away_manual };
}

/** Whether two entries would show the same, whenever they were made. */
export function sameEntry(a: PresenceEntry | null | undefined, b: PresenceEntry | null | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.presence === b.presence &&
    a.username === b.username &&
    a.dnd_until === b.dnd_until &&
    JSON.stringify(a.status) === JSON.stringify(b.status)
  );
}

/** An entry as it stands at `now`: Do Not Disturb and a status past their time are gone. */
export function liveEntry(entry: PresenceEntry, now: number): PresenceEntry {
  const status = liveStatus(entry.status, now);
  const dnd = dndOn(entry.dnd_until, now) ? entry.dnd_until : null;
  return status === entry.status && dnd === entry.dnd_until ? entry : { ...entry, status, dnd_until: dnd };
}

/** The entries for `ids`, or every entry when none are named. */
export function onlyPeople(entries: PresenceEntry[], ids: unknown[] | null): PresenceEntry[] {
  if (!ids) return entries;
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string").slice(0, 5000));
  return entries.filter((entry) => wanted.has(entry.user_id));
}

/** What is kept, read back; nothing for anything that is not it. */
export function readKept(json: string | null | undefined): Kept {
  if (!json) return { ...NOTHING_KEPT };
  try {
    const value = JSON.parse(json) as Partial<Kept>;
    return {
      away_manual: value.away_manual === true,
      dnd_until: typeof value.dnd_until === "string" ? value.dnd_until : null,
      status: value.status && typeof value.status === "object" ? (value.status as PersonStatus) : null,
    };
  } catch {
    return { ...NOTHING_KEPT };
  }
}

/** Workspace slugs as the site sent them: lowercased, distinct, at most 200. */
export function cleanWorkspaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const slug of value) {
    if (typeof slug !== "string") continue;
    const clean = slug.trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,38}$/.test(clean)) out.add(clean);
    if (out.size >= 200) break;
  }
  return [...out];
}
