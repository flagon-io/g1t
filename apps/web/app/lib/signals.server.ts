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

/**
 * What the workspace's work says, for a page drawn at `now`. Null when
 * the work service answered none of the batches: the page then says so.
 */
export async function loadSignalData(viewer: User, slug: string, now: number, owned: Repo[] | null): Promise<SignalData | null> {
  if (!owned) return null;
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
  return {
    slug,
    now,
    range,
    starts,
    repos,
    signals,
    complete: answered.length === batches.length,
    weeks: weekTotals(signals.weeks, starts),
    spend: weeklySpend(weekly, starts),
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
