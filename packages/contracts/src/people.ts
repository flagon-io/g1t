/**
 * People: a workspace's directory of everyone in it, people and agents,
 * and each member's place in it: a title, who they report to, and what
 * they own. Kept by identity beside membership; mirrors
 * `crates/contracts/src/people.rs`. Agents come from the agents service,
 * which teams name by id.
 */
import type { User } from "./identity";
import type { Result } from "./result";
import type { TeamChannel, TeamLead, TeamRef, TeamRole, TeamVisibility } from "./teams";

/** The longest title. */
export const MAX_TITLE_LENGTH = 80;
/** The most things one person owns, as their profile lists them, and the longest of them. */
export const MAX_OWNS = 8;
export const MAX_OWNS_LENGTH = 60;

/** One member, as the directory, their profile and the org chart show them. */
export type DirectoryPerson = {
  user_id: string;
  username: string;
  display_username?: string;
  name: string | null;
  avatar: string | null;
  bio: string | null;
  location: string | null;
  pronouns: string | null;
  /** An IANA time zone, for their local time. */
  timezone: string | null;
  role: "owner" | "member";
  /** Their title in this workspace. */
  title: string | null;
  /** Who they report to, by username. */
  manager: string | null;
  /** What they own: a few short phrases. */
  owns: string[];
  joined_at: string;
};

export type TeamPersonRef = { username: string; role: TeamRole };

/** A team as the directory and the org chart need it. */
export type DirectoryTeam = {
  slug: string;
  name: string;
  description: string | null;
  visibility: TeamVisibility;
  parent: TeamRef | null;
  lead: TeamLead | null;
  channel: TeamChannel | null;
  budget_micros: number | null;
  /** Its own people. */
  people: TeamPersonRef[];
  /** Agents added to it, by id. Agents whose home team it is are on it too (`agentsOnTeam`). */
  agent_ids: string[];
  repos_count: number;
};

export type PeopleDirectory = {
  people: DirectoryPerson[];
  teams: DirectoryTeam[];
  /** What members get on every repository. */
  base_permission: "none" | "read" | "write" | "admin";
  /** Whether the viewer owns the workspace: they set anyone's title, manager and what they own. */
  can_manage: boolean;
};

/** What changes on a member's profile; the rest stays. `manager: ""` clears it (owners only). */
export type MemberProfileChanges = {
  title?: string;
  manager?: string;
  owns?: string[];
};

export interface PeopleClient {
  /** Everyone in a workspace and its teams, as the viewer may see them. Members only. */
  peopleDirectory(viewer: User | null, workspace: string): Promise<Result<PeopleDirectory>>;
  /** A member's title and what they own (themselves or an owner), and their manager (owners). */
  setMemberProfile(actor: User, workspace: string, username: string, changes: MemberProfileChanges): Promise<Result<DirectoryPerson>>;
}

/**
 * The agents on a team, by id: those added to it, then those whose home
 * team it is (their profile names it).
 */
export function agentsOnTeam(team: { slug: string; agent_ids: readonly string[] }, agents: readonly { id: string; team: string | null }[]): string[] {
  const ids = [...team.agent_ids];
  for (const agent of agents) if (agent.team === team.slug && !ids.includes(agent.id)) ids.push(agent.id);
  return ids;
}

/** What a team is made of. */
export type TeamKind = "mixed" | "people" | "agents" | "empty";

export function teamKind(people: number, agents: number): TeamKind {
  if (people && agents) return "mixed";
  if (people) return "people";
  if (agents) return "agents";
  return "empty";
}

/** "2 people and 1 agent", "People only", "Agents only", "No one yet". */
export function teamKindLabel(people: number, agents: number): string {
  const kind = teamKind(people, agents);
  if (kind === "people") return "People only";
  if (kind === "agents") return "Agents only";
  if (kind === "empty") return "No one yet";
  return `${people} ${people === 1 ? "person" : "people"} and ${agents} ${agents === 1 ? "agent" : "agents"}`;
}

/** What someone owns, as identity keeps it: trimmed, each once (ignoring case), at most eight. */
export function cleanOwns(owns: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of owns) {
    const phrase = raw.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_OWNS_LENGTH).replace(/[.,;]+$/, "").trim();
    if (!phrase || out.some((kept) => kept.toLowerCase() === phrase.toLowerCase())) continue;
    out.push(phrase);
    if (out.length === MAX_OWNS) break;
  }
  return out;
}
