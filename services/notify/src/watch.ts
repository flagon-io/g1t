/**
 * Live repository pages: the changes services tell of (`repo_changed`),
 * cleaned, and who hears them. Pure, for the Worker (src/index.ts), the
 * topics (src/topic.ts) and the feeds (src/feed.ts).
 *
 * A change says what kind of thing moved and where, never anything
 * written in the repository; anything else sent along is dropped here.
 */
import type { RepoChange } from "@g1t/contracts";

/** How long one watch lasts: REPO_WATCH_MS in @g1t/contracts, which the pages renew before. */
export const WATCH_MS = 15 * 60_000;

/** The most changes one call is taken with. */
export const MAX_CHANGES = 500;
/** The most people one repository's topic keeps watching it. */
export const MAX_WATCHERS = 5000;
/** The most repositories one person watches at once (tabs on many repositories). */
export const MAX_WATCHING = 50;

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PATH = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2 ** 32 ? value : null;
}

/** A repository id as services and the site send it, or null. */
export function cleanRepoId(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** An `owner/name`, or null. */
export function cleanRepoPath(value: unknown): string | null {
  return typeof value === "string" && PATH.test(value) ? value : null;
}

/** A change as a service sent it, with only what a change carries; null when it is not one. */
export function cleanChange(value: unknown): RepoChange | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const repo_id = cleanRepoId(given.repo_id);
  const kind = typeof given.kind === "string" && /^[a-z_]{1,40}\.[a-z_]{1,40}$/.test(given.kind) ? given.kind : null;
  if (!repo_id || !kind) return null;
  const change: RepoChange = { repo_id, kind, at: text(given.at, 40) ?? new Date().toISOString() };
  const ref = text(given.ref);
  const number = count(given.number);
  const sha = typeof given.sha === "string" && /^[0-9a-f]{4,64}$/i.test(given.sha) ? given.sha : null;
  const run = cleanRepoId(given.run);
  const commits = count(given.commits);
  if (ref) change.ref = ref;
  if (number != null) change.number = number;
  if (sha) change.sha = sha;
  if (run) change.run = run;
  if (commits != null) change.commits = commits;
  return change;
}

/** The changes of a call, cleaned, by repository, in the order they came. */
export function byRepo(values: unknown): Map<string, RepoChange[]> {
  const grouped = new Map<string, RepoChange[]>();
  const list = Array.isArray(values) ? values.slice(0, MAX_CHANGES) : [];
  for (const value of list) {
    const change = cleanChange(value);
    if (!change) continue;
    grouped.set(change.repo_id, [...(grouped.get(change.repo_id) ?? []), change]);
  }
  return grouped;
}

/** Each change named with the repository's `owner/name`, as its watcher asked for it. */
export function named(changes: RepoChange[], repo: string): RepoChange[] {
  return changes.map((change) => ({ ...change, repo }));
}

/** Until when a watch asked for at `now` lasts. */
export function watchUntil(now: number): number {
  return now + WATCH_MS;
}

/** Whether a watch kept until `until` still holds at `now`. */
export function stillWatching(until: number | null | undefined, now: number): boolean {
  return typeof until === "number" && until > now;
}
