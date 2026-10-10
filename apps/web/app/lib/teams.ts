/**
 * Teams on the site: finding them, and reading their forms. Types only from
 * the contracts, so this file runs under `node --test`.
 */
import type { NewTeam, ReviewAlgorithm, ReviewAssignment, Team, TeamChanges, TeamVisibility } from "@g1t/contracts";

/** The most people review assignment picks; the same as the contracts' `MAX_ASSIGNED`. */
const MAX_ASSIGNED = 10;

/** Where a team's pages are. */
export function teamPath(workspace: string, slug: string, tab?: "teams" | "repositories" | "settings"): string {
  return `/${workspace}/-/teams/${slug}${tab ? `/${tab}` : ""}`;
}

/** The teams whose name, slug or description has every word of `query`, in their order. */
export function filterTeams<T extends Pick<Team, "name" | "slug" | "description">>(teams: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return teams;
  return teams.filter((team) => {
    const text = `${team.name} ${team.slug} ${team.description ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The viewer's teams, then the rest, keeping the order given. */
export function splitTeams<T extends Pick<Team, "viewer_role">>(teams: T[]): { mine: T[]; others: T[] } {
  return {
    mine: teams.filter((team) => team.viewer_role != null),
    others: teams.filter((team) => team.viewer_role == null),
  };
}

/** The teams `team` could go under: visible, not itself, and not one of its own children. */
export function parentChoices<T extends Pick<Team, "slug" | "visibility" | "parent">>(teams: T[], team: string | null): T[] {
  if (!team) return teams.filter((other) => other.visibility === "visible");
  // Everything under `team`, by following parents.
  const below = new Set<string>([team]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const other of teams) {
      if (other.parent && below.has(other.parent.slug) && !below.has(other.slug)) {
        below.add(other.slug);
        grew = true;
      }
    }
  }
  return teams.filter((other) => other.visibility === "visible" && !below.has(other.slug));
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function visibilityOf(value: string): TeamVisibility | undefined {
  return value === "secret" || value === "visible" ? value : undefined;
}

/** A new team from the form on the New team page. */
export function newTeamFromForm(form: FormData): NewTeam {
  const members = text(form, "members")
    .split(/[\s,]+/)
    .map((name) => name.replace(/^@/, ""))
    .filter(Boolean);
  return {
    name: text(form, "name"),
    slug: text(form, "slug") || null,
    description: text(form, "description") || null,
    visibility: visibilityOf(text(form, "visibility")) ?? "visible",
    parent: text(form, "parent") || null,
    members,
  };
}

/** What the team's settings form changes: only the fields it has. */
export function teamChangesFromForm(form: FormData): TeamChanges {
  const changes: TeamChanges = {};
  if (form.has("name")) changes.name = text(form, "name");
  if (form.has("slug")) changes.slug = text(form, "slug");
  if (form.has("description")) changes.description = text(form, "description");
  const visibility = visibilityOf(text(form, "visibility"));
  if (visibility) changes.visibility = visibility;
  // "" takes it out from under its parent.
  if (form.has("parent")) changes.parent = text(form, "parent");
  if (form.has("notify-shown")) changes.notify = form.get("notify") != null;
  return changes;
}

function count(value: string, fallback: number, low: number, high: number): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, number));
}

/** Review assignment from its form, within bounds; `current` fills what the form leaves out. */
export function reviewAssignmentFromForm(form: FormData, current: ReviewAssignment): ReviewAssignment {
  const algorithm = text(form, "algorithm");
  return {
    enabled: form.get("enabled") != null,
    algorithm: (algorithm === "round_robin" || algorithm === "load_balance" ? algorithm : current.algorithm) as ReviewAlgorithm,
    count: count(text(form, "count"), current.count, 1, MAX_ASSIGNED),
    skip_busy: form.get("skip_busy") != null,
    busy_at: count(text(form, "busy_at"), current.busy_at, 1, 100),
    include_child_teams: form.get("include_child_teams") != null,
    excluded: [
      ...new Set(
        text(form, "excluded")
          .split(/[\s,]+/)
          .map((name) => name.replace(/^@/, "").toLowerCase())
          .filter(Boolean),
      ),
    ],
    notify_team: form.get("notify_team") != null,
  };
}

/** "3 members · 2 repositories · 1 child team", leaving out what is none. */
export function teamCounts(team: Pick<Team, "members_count" | "repos_count" | "child_teams_count">, agents = 0): string {
  const part = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`);
  const parts = [
    part(team.members_count, "member", "members"),
    part(agents, "agent", "agents"),
    part(team.repos_count, "repository", "repositories"),
    part(team.child_teams_count, "child team", "child teams"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No members yet";
}
