/**
 * People on the site: the directory, profiles, and teams. People only.
 * Types only from the contracts, so this file runs under `node --test`.
 */
import type { DirectoryPerson, DirectoryTeam, PeopleDirectory, TeamLead } from "@g1t/contracts";

/** Where a person's profile is. */
export function personPath(workspace: string, username: string): string {
  return `/${workspace}/-/people/${username}`;
}

/** The teams a person is on. */
export function teamsOfPerson<T extends Pick<DirectoryTeam, "people">>(teams: readonly T[], username: string): T[] {
  return teams.filter((team) => team.people.some((person) => person.username === username));
}

/** Whether `lead` is this person. An old agent lead (agents no longer exist) is nobody's. */
export function leads(lead: TeamLead | null, who: { username: string }): boolean {
  return !!lead && lead.kind === "user" && lead.username === who.username;
}

/** A person's name as pages show it. */
export function personName(person: Pick<DirectoryPerson, "username" | "name" | "display_username">): string {
  return person.name?.trim() || person.display_username || person.username;
}

/** Whether every word of `query` is somewhere in `fields`. */
export function matches(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** One card in the directory: a person and their teams. */
export type DirectoryEntry = { person: DirectoryPerson; teams: DirectoryTeam[] };

/**
 * The people matching `query`, in the directory's order (by name). A
 * person matches on their name, username, title, teams, what they own,
 * where they are and their bio.
 */
export function directoryEntries(directory: PeopleDirectory, query: string): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  for (const person of directory.people) {
    const teams = teamsOfPerson(directory.teams, person.username);
    const fields = [
      person.username,
      person.name,
      person.title,
      person.location,
      person.bio,
      ...person.owns,
      ...teams.map((team) => team.name),
      person.role === "owner" ? "owner" : null,
    ];
    if (matches(query, fields)) out.push({ person, teams });
  }
  return out;
}

/** What someone owns, from a form's text: one per line or comma. */
export function ownsFromText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

/** The access to Code a member has, in words: their role, the base permission, and the teams that add to it. */
export function codeAccessWords(
  person: Pick<DirectoryPerson, "role">,
  base: PeopleDirectory["base_permission"],
  teams: readonly Pick<DirectoryTeam, "name" | "repos_count">[],
): { summary: string; through: string[] } {
  const summary =
    person.role === "owner"
      ? "Admin on every repository, as an owner"
      : base === "none"
        ? "Only repositories they're given a role on"
        : `${base[0]!.toUpperCase()}${base.slice(1)} on every repository, the workspace's base permission`;
  const through = teams
    .filter((team) => team.repos_count > 0)
    .map((team) => `Roles on ${team.repos_count} ${team.repos_count === 1 ? "repository" : "repositories"} through ${team.name}`);
  return { summary, through };
}
