/**
 * The daily signal's reads: the work service's `workspaceSignals` for the
 * workspace's repositories, a hundred at a time; the agents' usage for the
 * weeks and for the quarter; and, for the Workspace overview, its teams.
 * Each comes back on its own, so one that fails leaves only what needs it
 * saying so. The shaping is in ./signals.ts.
 */
import type { Repo, RepoPath, Usage, User, WorkspaceSignals } from "@g1t/contracts";

import { billing, identity, work } from "./services.server";
import { type Group, type WeekTotals, mergeSignals, signalsRange, weekStarts, weekTotals, weeklySpend } from "./signals";

/** Repositories asked of the work service at once: its limit. */
const BATCH = 100;
/** Teams the rhythm reads the projects of. */
const MAX_TEAMS = 8;

export type SignalData = {
  slug: string;
  now: number;
  range: ReturnType<typeof signalsRange>;
  starts: string[];
  repos: Record<string, RepoPath>;
  signals: WorkspaceSignals;
  /** Every batch answered: otherwise the figures leave some projects out. */
  complete: boolean;
  weeks: WeekTotals[];
  /** Usage per week; null when billing did not answer. */
  spend: number[] | null;
  quarterUsage: Usage | null;
};

async function usageSince(viewer: User, slug: string, day: string): Promise<Usage | null> {
  const result = await billing.usage(slug, viewer, `${day}T00:00:00.000Z`).catch(() => null);
  return result?.ok ? result.value : null;
}

/** How long one reading of the work is used again: Home refreshes itself often, and the weeks barely move in minutes. */
const KEEP_MS = 5 * 60_000;
/** Readings kept in the isolate at once. */
const KEEP_MAX = 50;
/** Where readings are kept in the data centre's cache: a name nothing outside can ask for. */
const KEEP_ORIGIN = "https://signals.g1t.internal/";

const kept = new Map<string, { at: number; data: SignalData }>();

/**
 * What the workspace's work says, for a page drawn at `now`, read again
 * at most every five minutes per person (what each person can read
 * differs, so a reading is never shared between people). Kept in the
 * isolate and in the data centre's cache; only a reading every batch of
 * which answered is kept. Null when the work service answered none of
 * the batches: the page then says so.
 */
export async function loadSignalData(viewer: User, slug: string, now: number, owned: Repo[] | null): Promise<SignalData | null> {
  if (!owned) return null;
  const key = `${viewer.id}/${slug}/${await digest(
    owned
      .map((repo) => repo.id)
      .sort()
      .join(","),
  )}`;
  const memory = kept.get(key);
  if (memory && now - memory.at < KEEP_MS) return memory.data;
  const shared = sharedCache();
  const url = `${KEEP_ORIGIN}${encodeURIComponent(key)}`;
  const found = shared ? await shared.match(url).catch(() => undefined) : undefined;
  if (found) {
    const data = (await found.json().catch(() => null)) as SignalData | null;
    if (data && now - data.now < KEEP_MS) {
      remember(key, data);
      return data;
    }
  }
  const data = await readSignalData(viewer, slug, now, owned);
  if (data?.complete) {
    remember(key, data);
    const response = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "cache-control": `private, max-age=${KEEP_MS / 1000}` },
    });
    // Kept for the next page; the answer never waits for it.
    void shared?.put(url, response).catch(() => undefined);
  }
  return data;
}

function remember(key: string, data: SignalData) {
  kept.delete(key);
  kept.set(key, { at: data.now, data });
  while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value!);
}

/** The data centre's cache, or null where there is none (tests, local development). */
function sharedCache(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readSignalData(viewer: User, slug: string, now: number, owned: Repo[]): Promise<SignalData | null> {
  const range = signalsRange(now);
  const starts = weekStarts(range.until, range.weeks);
  const ids = owned.map((repo) => repo.id);
  const repos: Record<string, RepoPath> = {};
  for (const repo of owned) repos[repo.id] = { namespace: repo.namespace, name: repo.name };
  const [batches, weekly, quarterUsage] = await Promise.all([
    Promise.allSettled(
      Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, i) =>
        work.workspaceSignals(
          { workspace: slug, repoIds: ids.slice(i * BATCH, (i + 1) * BATCH), until: range.until, weeks: range.weeks, days: range.days, since: range.since },
          viewer,
        ),
      ),
    ),
    usageSince(viewer, slug, starts[0]!),
    usageSince(viewer, slug, range.quarter),
  ]);
  const answered = batches.flatMap((batch) => (batch.status === "fulfilled" ? [batch.value] : []));
  for (const batch of batches) if (batch.status === "rejected") console.warn("g1t: workspace signals could not be read:", batch.reason);
  if (ids.length > 0 && answered.length === 0) return null;
  const signals = mergeSignals(answered);
  const weeks = weekTotals(signals.weeks, starts);
  return {
    slug,
    now,
    range,
    starts,
    repos,
    signals,
    complete: answered.length === batches.length,
    weeks,
    // g1t's metered usage each week, and what the harness sessions started in it cost.
    spend: weeklySpend(weekly, starts)?.map((micros, i) => micros + Math.round((weeks[i]?.sessionCostUsd ?? 0) * 1_000_000)) ?? null,
    quarterUsage,
  };
}

/**
 * What the rhythm's rows are: the workspace's teams by the projects they
 * work on, with how many people each has; else, with no teams, the
 * projects themselves. Null when identity did not answer.
 */
export async function loadGroups(viewer: User, slug: string, owned: Repo[]): Promise<{ groups: Group[]; by: "team" | "project" } | null> {
  const projects = (): { groups: Group[]; by: "project" } => ({
    by: "project",
    groups: owned.map((repo) => ({ key: repo.id, label: repo.name, note: repo.namespace, to: `/${repo.namespace}/${repo.name}`, repoIds: [repo.id] })),
  });
  const listed = await identity.listTeams(viewer, slug).catch(() => null);
  if (!listed) return null;
  if (!listed.ok || listed.value.length === 0) return projects();
  const teams = listed.value.slice(0, MAX_TEAMS);
  const [repos, memberships] = await Promise.all([
    Promise.all(teams.map((team) => identity.teamRepos(viewer, slug, team.slug).catch(() => null))),
    identity.teamMemberships(viewer, slug).catch(() => null),
  ]);
  const people = new Map<string, number>();
  if (memberships?.ok) for (const member of memberships.value) for (const team of member.teams) people.set(team.slug, (people.get(team.slug) ?? 0) + 1);
  const groups = teams.flatMap((team, i) => {
    const found = repos[i];
    if (!found?.ok || found.value.length === 0) return [];
    const count = people.get(team.slug);
    return [
      {
        key: team.slug,
        label: team.name,
        note: count == null ? "" : `${count} ${count === 1 ? "person" : "people"}`,
        to: `/${slug}/-/teams/${team.slug}`,
        repoIds: found.value.map((repo) => repo.repo_id),
      },
    ];
  });
  return groups.length > 0 ? { by: "team", groups } : projects();
}
