/**
 * People: a workspace's directory of the people in it, and each member's
 * place in it: a title and what they own. Kept by identity beside
 * membership; mirrors `crates/contracts/src/people.rs`.
 */
import type { User } from "./identity";
import type { Result } from "./result";
import type { TeamChannel, TeamLead, TeamRef, TeamRole, TeamVisibility } from "./teams";

/** The longest title. */
export const MAX_TITLE_LENGTH = 80;
/** The most things one person owns, as their profile lists them, and the longest of them. */
export const MAX_OWNS = 8;
export const MAX_OWNS_LENGTH = 60;

/** One member, as the directory and their profile show them. */
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
  /** What they own: a few short phrases. */
  owns: string[];
  joined_at: string;
};

export type TeamPersonRef = { username: string; role: TeamRole };

/** A team as the directory needs it. */
export type DirectoryTeam = {
  slug: string;
  name: string;
  description: string | null;
  visibility: TeamVisibility;
  parent: TeamRef | null;
  lead: TeamLead | null;
  channel: TeamChannel | null;
  /** Its own people. */
  people: TeamPersonRef[];
  repos_count: number;
};

export type PeopleDirectory = {
  people: DirectoryPerson[];
  teams: DirectoryTeam[];
  /** What members get on every repository. */
  base_permission: "none" | "read" | "write" | "admin";
  /** Whether the viewer owns the workspace: they set anyone's title and what they own. */
  can_manage: boolean;
};

/** What changes on a member's profile; the rest stays. */
export type MemberProfileChanges = {
  title?: string;
  owns?: string[];
};

export interface PeopleClient {
  /** Everyone in a workspace and its teams, as the viewer may see them. Members only. */
  peopleDirectory(viewer: User | null, workspace: string): Promise<Result<PeopleDirectory>>;
  /** A member's title and what they own: themselves, or an owner. */
  setMemberProfile(actor: User, workspace: string, username: string, changes: MemberProfileChanges): Promise<Result<DirectoryPerson>>;
}

/** What someone owns, as identity keeps it: trimmed, each once (ignoring case), at most eight. */
export function cleanOwns(owns: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of owns) {
    const phrase = raw
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .slice(0, MAX_OWNS_LENGTH)
      .replace(/[.,;]+$/, "")
      .trim();
    if (!phrase || out.some((kept) => kept.toLowerCase() === phrase.toLowerCase())) continue;
    out.push(phrase);
    if (out.length === MAX_OWNS) break;
  }
  return out;
}
