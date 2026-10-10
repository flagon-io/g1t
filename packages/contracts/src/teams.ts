/**
 * Teams: groups of a workspace's members, given roles on repositories
 * together, mentioned together and asked to review together. Kept by the
 * identity service; mirrors `crates/contracts/src/teams.rs`.
 */
import type { RepoRole } from "./access";
import type { User } from "./identity";
import type { Result } from "./result";

export type TeamVisibility = "visible" | "secret";

/**
 * Who may create a workspace's teams: any member (the default) or its
 * owners only. Owners change it in the workspace's settings.
 */
export type TeamCreation = "members" | "owners";

/** Whether someone with `role` in a workspace may create its teams. */
export function mayCreateTeams(setting: TeamCreation | null | undefined, role: "owner" | "member" | null | undefined): boolean {
  if (!role) return false;
  return (setting ?? "members") === "members" || role === "owner";
}
export type TeamRole = "member" | "maintainer";
export type ReviewAlgorithm = "round_robin" | "load_balance";

export const TEAM_VISIBILITY_LABELS: Record<TeamVisibility, string> = {
  visible: "Visible",
  secret: "Secret",
};

export const TEAM_VISIBILITY_SUMMARIES: Record<TeamVisibility, string> = {
  visible: "Every member of the workspace can see it and mention it.",
  secret: "Only its own people and the workspace's owners can see it. Secret teams cannot be nested.",
};

export const REVIEW_ALGORITHM_LABELS: Record<ReviewAlgorithm, string> = {
  round_robin: "Round robin",
  load_balance: "Load balance",
};

export const REVIEW_ALGORITHM_SUMMARIES: Record<ReviewAlgorithm, string> = {
  round_robin: "Whoever this team asked least recently goes first.",
  load_balance: "Whoever has the fewest pull requests waiting on their review goes first.",
};

/** The most people review assignment picks for one request. */
export const MAX_ASSIGNED = 10;

export type ReviewAssignment = {
  enabled: boolean;
  algorithm: ReviewAlgorithm;
  count: number;
  skip_busy: boolean;
  busy_at: number;
  include_child_teams: boolean;
  excluded: string[];
  notify_team: boolean;
};

export const DEFAULT_REVIEW_ASSIGNMENT: ReviewAssignment = {
  enabled: false,
  algorithm: "round_robin",
  count: 1,
  skip_busy: false,
  busy_at: 5,
  include_child_teams: false,
  excluded: [],
  notify_team: false,
};

export type TeamRef = { slug: string; name: string };

/** Who leads a team: a person on it, or an agent on it (by its id in the agents service). */
export type TeamLead =
  | { kind: "user"; username: string; name: string | null; avatar: string | null }
  | { kind: "agent"; agent_id: string };

/** A team's chat channel: its id, and its name (without `#`) when it was chosen. */
export type TeamChannel = { id: string; name: string };

/** An agent added to a team. */
export type TeamAgent = {
  agent_id: string;
  /** Who added it, by username. */
  added_by: string | null;
  created_at: string;
};

/** A person on a team, as an agent on it is told of them (`agent_teams`). */
export type RosterPerson = {
  user_id: string;
  username: string;
  name: string | null;
  title: string | null;
  /** An IANA time zone, for their local time. */
  timezone: string | null;
  owns: string[];
  /** Who they report to, by username. */
  manager: string | null;
  maintainer: boolean;
};

/** A visible team an agent is on, with everyone on it. For the agents service. */
export type AgentTeam = {
  slug: string;
  name: string;
  description: string | null;
  lead: TeamLead | null;
  channel: TeamChannel | null;
  budget_micros: number | null;
  people: RosterPerson[];
  /** Agents added to it, by id. */
  agent_ids: string[];
};

/** How `update_team` takes a lead: `@username`, or `agent:<id>`; `""` for none. */
export function leadInput(lead: { kind: "user"; username: string } | { kind: "agent"; agent_id: string } | null): string {
  if (!lead) return "";
  return lead.kind === "user" ? `@${lead.username}` : `agent:${lead.agent_id}`;
}

export type Team = {
  id: string;
  workspace: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: TeamVisibility;
  parent: TeamRef | null;
  notify: boolean;
  review_assignment: ReviewAssignment;
  members_count: number;
  repos_count: number;
  child_teams_count: number;
  /** Agents added to it. Agents whose home team it is are on it too. */
  agents_count: number;
  lead: TeamLead | null;
  channel: TeamChannel | null;
  /** What its agents may spend together in a calendar month, in micro-dollars; null for none. */
  budget_micros: number | null;
  viewer_role: TeamRole | null;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
};

export type TeamMember = {
  username: string;
  name: string | null;
  avatar: string | null;
  role: TeamRole;
  /** The child team they are in, when listed through one. */
  via: string | null;
};

export type TeamRepo = {
  /** `workspace/name`. */
  repo: string;
  repo_id: string;
  role: RepoRole;
  /** The parent team it comes from, when inherited. */
  inherited_from: string | null;
};

/** A team with a role on a repository, as its Access settings list it. */
export type RepoTeam = {
  slug: string;
  name: string;
  role: RepoRole;
  members_count: number;
  visibility: TeamVisibility;
};

export type NewTeam = {
  name: string;
  slug?: string | null;
  description?: string | null;
  visibility?: TeamVisibility | null;
  parent?: string | null;
  notify?: boolean | null;
  members?: string[];
};

/** What changes; the rest stays. `parent: ""` takes the team out from under its parent. */
export type TeamChanges = {
  name?: string;
  slug?: string;
  description?: string;
  visibility?: TeamVisibility;
  parent?: string;
  notify?: boolean;
  review_assignment?: ReviewAssignment;
  /** `@username` or `agent:<id>`, someone on the team (see `leadInput`); `""` for no lead. */
  lead?: string;
  /** The chat channel's id; `""` for none. Given with `channel_name`. */
  channel_id?: string;
  channel_name?: string;
  /** What its agents may spend together in a month, in micro-dollars; 0 for no team budget. */
  budget_micros?: number;
};

/** `@acme/backend`, the way a team is mentioned. */
export function teamHandle(team: { workspace: string; slug: string }): string {
  return `@${team.workspace}/${team.slug}`;
}

/** A team's slug from its name, as identity makes it. Null when nothing is left. */
export function teamSlug(name: string): string | null {
  let slug = "";
  for (const c of name.trim()) {
    if (/[A-Za-z0-9]/.test(c)) slug += c.toLowerCase();
    else if (slug && !slug.endsWith("-")) slug += "-";
  }
  slug = slug.replace(/-+$/, "").slice(0, 60).replace(/-+$/, "");
  return slug ? slug : null;
}

/** One person's teams in a workspace, for the Members page. */
export type MemberTeams = { username: string; teams: TeamRef[] };

/** Identity's team methods. */
export interface TeamsClient {
  listTeams(viewer: User | null, workspace: string, query?: string | null): Promise<Result<Team[]>>;
  getTeam(viewer: User | null, workspace: string, team: string): Promise<Result<Team>>;
  createTeam(actor: User, workspace: string, team: NewTeam): Promise<Result<Team>>;
  /** Who may create the workspace's teams. Owners only. */
  setTeamCreation(actor: User, slug: string, setting: TeamCreation): Promise<Result<TeamCreation>>;
  updateTeam(actor: User, workspace: string, team: string, changes: TeamChanges): Promise<Result<Team>>;
  deleteTeam(actor: User, workspace: string, team: string): Promise<Result<boolean>>;
  teamMembers(viewer: User | null, workspace: string, team: string, includeChildTeams?: boolean): Promise<Result<TeamMember[]>>;
  setTeamMember(actor: User, workspace: string, team: string, username: string, role: TeamRole): Promise<Result<TeamMember>>;
  removeTeamMember(actor: User, workspace: string, team: string, username: string): Promise<Result<boolean>>;
  childTeams(viewer: User | null, workspace: string, team: string): Promise<Result<Team[]>>;
  teamRepos(viewer: User | null, workspace: string, team: string): Promise<Result<TeamRepo[]>>;
  setTeamRepo(actor: User, workspace: string, team: string, owner: string, name: string, role: RepoRole): Promise<Result<TeamRepo>>;
  removeTeamRepo(actor: User, workspace: string, team: string, owner: string, name: string): Promise<Result<boolean>>;
  /** The agents added to a team. Agents whose home team it is are on it too (`agentsOnTeam`). */
  teamAgents(viewer: User | null, workspace: string, team: string): Promise<Result<TeamAgent[]>>;
  /** Adds one of the workspace's agents, by id; check it is the workspace's first. Owners and maintainers. */
  setTeamAgent(actor: User, workspace: string, team: string, agentId: string): Promise<Result<TeamAgent>>;
  removeTeamAgent(actor: User, workspace: string, team: string, agentId: string): Promise<Result<boolean>>;
  /** For the agents service: the visible teams an agent is on, with everyone on each. */
  agentTeams(workspace: string, agentId: string, homeTeam: string | null): Promise<AgentTeam[]>;
  userTeams(viewer: User | null, workspace: string, username: string): Promise<Result<Team[]>>;
  /** Each member's teams the viewer can see. Members only. */
  teamMemberships(viewer: User | null, workspace: string): Promise<Result<MemberTeams[]>>;
}
