/**
 * People on the site: the directory (people and agents in one search),
 * profiles, teams of any mix, and the org chart. Types only from the
 * contracts, so this file runs under `node --test`.
 */
import type { DirectoryPerson, DirectoryTeam, PeopleDirectory, TeamLead, WorkspaceAgent } from "@g1t/contracts";

/** An agent as People's pages need it. */
export type PeopleAgent = Pick<
  WorkspaceAgent,
  "id" | "handle" | "display_name" | "avatar" | "avatar_seed" | "title" | "role" | "team" | "department" | "status" | "responsibilities" | "builtin" | "spent_month_micros"
>;

/** Just what People's pages read of an agent, so loaders send no more. */
export function peopleAgent(agent: PeopleAgent): PeopleAgent {
  const { id, handle, display_name, avatar, avatar_seed, title, role, team, department, status, responsibilities, builtin, spent_month_micros } = agent;
  return { id, handle, display_name, avatar, avatar_seed, title, role, team, department, status, responsibilities, builtin, spent_month_micros };
}

/** Where a person's profile is. */
export function personPath(workspace: string, username: string): string {
  return `/${workspace}/-/people/${username}`;
}

/** Where an agent's People profile is. */
export function agentPath(workspace: string, handle: string): string {
  return `/${workspace}/-/people/agents/${handle}`;
}

/** The agents on a team, by id: those added to it, then those whose home team it is. */
export function agentIdsOn(team: Pick<DirectoryTeam, "slug" | "agent_ids">, agents: readonly Pick<PeopleAgent, "id" | "team">[]): string[] {
  const ids = [...team.agent_ids];
  for (const agent of agents) if (agent.team === team.slug && !ids.includes(agent.id)) ids.push(agent.id);
  return ids;
}

/** The agents on a team, in order, as found among `agents`. */
export function agentsOn<A extends Pick<PeopleAgent, "id" | "team">>(team: Pick<DirectoryTeam, "slug" | "agent_ids">, agents: readonly A[]): A[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return agentIdsOn(team, agents)
    .map((id) => byId.get(id))
    .filter((agent): agent is A => !!agent);
}

/** The teams a person is on. */
export function teamsOfPerson<T extends Pick<DirectoryTeam, "people">>(teams: readonly T[], username: string): T[] {
  return teams.filter((team) => team.people.some((person) => person.username === username));
}

/** The teams an agent is on: added to, or its home team. */
export function teamsOfAgent<T extends Pick<DirectoryTeam, "slug" | "agent_ids">>(teams: readonly T[], agent: Pick<PeopleAgent, "id" | "team">): T[] {
  return teams.filter((team) => team.agent_ids.includes(agent.id) || team.slug === agent.team);
}

/** Whether `lead` is this person or this agent. */
export function leads(lead: TeamLead | null, who: { username: string } | { id: string }): boolean {
  if (!lead) return false;
  if ("username" in who) return lead.kind === "user" && lead.username === who.username;
  return lead.kind === "agent" && lead.agent_id === who.id;
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

export type DirectoryKind = "everyone" | "people" | "agents";

export function directoryKind(value: string | null): DirectoryKind {
  return value === "people" || value === "agents" ? value : "everyone";
}

/** One card in the directory: a person or an agent. */
export type DirectoryEntry =
  | { kind: "person"; person: DirectoryPerson; teams: DirectoryTeam[] }
  | { kind: "agent"; agent: PeopleAgent; teams: DirectoryTeam[] };

/**
 * Everyone matching `query`, people first by name, then agents (the
 * orchestrator first, then by name). People match on their name, title,
 * teams, what they own, where they are and their bio; agents on their
 * name, handle, title, role, teams and responsibilities.
 */
export function directoryEntries(directory: PeopleDirectory, agents: readonly PeopleAgent[], query: string, kind: DirectoryKind): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  if (kind !== "agents") {
    for (const person of directory.people) {
      const teams = teamsOfPerson(directory.teams, person.username);
      const fields = [person.username, person.name, person.title, person.location, person.bio, ...person.owns, ...teams.map((team) => team.name), person.role === "owner" ? "owner" : null];
      if (matches(query, fields)) out.push({ kind: "person", person, teams });
    }
  }
  if (kind !== "people") {
    for (const agent of agents) {
      const teams = teamsOfAgent(directory.teams, agent);
      const fields = [agent.handle, agent.display_name, agent.title, agent.role, agent.department, ...agent.responsibilities, ...teams.map((team) => team.name), "agent"];
      if (matches(query, fields)) out.push({ kind: "agent", agent, teams });
    }
  }
  return out;
}

/** One person in the org chart, with who reports to them and the agents of the teams they lead. */
export type OrgNode = { person: DirectoryPerson; agents: PeopleAgent[]; leads: DirectoryTeam[]; reports: OrgNode[] };

export type OrgChart = {
  /** Everyone at the top: no manager, or one who is no longer here. */
  roots: OrgNode[];
  /** Teams no person leads (an agent does, or no one), with their agents. */
  unled: { team: DirectoryTeam; agents: PeopleAgent[] }[];
};

/**
 * Reporting lines, with each team's agents beside the person who leads it.
 * A loop (which identity refuses) would leave its people out of `roots`;
 * they are put back at the top, so no one is ever missing.
 */
export function orgChart(directory: PeopleDirectory, agents: readonly PeopleAgent[]): OrgChart {
  const known = new Set(directory.people.map((person) => person.username));
  const byManager = new Map<string, DirectoryPerson[]>();
  for (const person of directory.people) {
    if (person.manager && known.has(person.manager) && person.manager !== person.username) {
      byManager.set(person.manager, [...(byManager.get(person.manager) ?? []), person]);
    }
  }
  const placed = new Set<string>();
  const node = (person: DirectoryPerson): OrgNode => {
    placed.add(person.username);
    const led = directory.teams.filter((team) => leads(team.lead, { username: person.username }));
    const theirAgents: PeopleAgent[] = [];
    for (const team of led) for (const agent of agentsOn(team, agents)) if (!theirAgents.includes(agent)) theirAgents.push(agent);
    const reports = (byManager.get(person.username) ?? []).filter((report) => !placed.has(report.username)).map(node);
    return { person, agents: theirAgents, leads: led, reports };
  };
  const roots = directory.people.filter((person) => !person.manager || !known.has(person.manager)).map(node);
  for (const person of directory.people) if (!placed.has(person.username)) roots.push(node(person));
  const unled = directory.teams
    .filter((team) => !team.lead || team.lead.kind === "agent")
    .map((team) => ({ team, agents: agentsOn(team, agents) }))
    .filter((entry) => entry.agents.length > 0);
  return { roots, unled };
}

/** Everyone who reports to `username`, directly. */
export function reportsOf(people: readonly DirectoryPerson[], username: string): DirectoryPerson[] {
  return people.filter((person) => person.manager === username && person.username !== username);
}

/** Who `username` could report to: anyone but themselves and the people under them. */
export function managerChoices(people: readonly DirectoryPerson[], username: string): DirectoryPerson[] {
  const below = new Set<string>([username]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const person of people) {
      if (person.manager && below.has(person.manager) && !below.has(person.username)) {
        below.add(person.username);
        grew = true;
      }
    }
  }
  return people.filter((person) => !below.has(person.username));
}

/** What someone owns, from a form's text: one per line or comma. */
export function ownsFromText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

/** A monthly budget in dollars from a form, as micro-dollars; 0 for none; null when it isn't a number. */
export function budgetFromText(text: string): number | null {
  const value = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!value) return 0;
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 1_000_000);
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

/** The part of what an agent is told that is about one team: its heading and what follows, up to the next. */
export function teamBlock(text: string | null, teamName: string): string | null {
  if (!text) return null;
  const blocks = text.split(/\n(?=### )/);
  const found = blocks.find((block) => block.startsWith(`### ${teamName}\n`) || block.trim() === `### ${teamName}`);
  return found ? found.trim() : null;
}
