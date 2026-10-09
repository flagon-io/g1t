/**
 * Who and where, for the docs service's folio code: the workspace by
 * slug, its people, agents and teams, how member keys show, and the
 * spaces with a person's role in each. Cached per request (one instance
 * per request). Docs' page code (src/index.ts, `Docs`) keeps its own copy
 * of these until Phase 7 of docs/ARTIFACTS_MODE.md removes it.
 */
import {
  fail,
  identityClient,
  newId,
  ok,
  parsePrincipalKey,
  principalKey,
  workspaceAgentsClient,
  type DocAgentMode,
  type DocRole,
  type DocSpace,
  type DocSpaceKind,
  type Member,
  type MemberProfile,
  type Principal,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  type Workspace,
  type WorkspaceAgent,
} from "@g1t/contracts";

import { roleOf, type Person, type SpaceRules } from "./access.ts";
import { freeSlug } from "./slugs.ts";

export type WhoEnv = { DB: D1Database; IDENTITY: ServiceBinding; AGENTS: ServiceBinding };

export type SpaceRow = {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  kind: DocSpaceKind;
  team: string | null;
  default_role: DocRole | null;
  agent_mode: DocAgentMode;
  /** 1: people with edit access may share what is in it (migration 0005). */
  editors_can_share: number;
  is_default: number;
  created_by: string;
  created_at: string;
  archived_at: string | null;
};

/** A space, with who is in it and the viewer's role (null: they can't read it). */
export type Space = { row: SpaceRow; members: { principal: string; role: DocRole }[]; projects: string[]; role: DocRole | null };

export const now = () => new Date().toISOString();

export function rulesOf(space: Pick<Space, "row" | "members">): SpaceRules {
  return { kind: space.row.kind, team: space.row.team, default_role: space.row.default_role, members: space.members };
}

export function isMember(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === String(workspace ?? "").toLowerCase());
}

export function userKey(viewer: Pick<User, "id">): string {
  return principalKey({ kind: "user", id: viewer.id });
}

export class Who {
  private readonly workspaces = new Map<string, Promise<Workspace | null>>();
  private readonly people = new Map<string, Promise<Map<string, Member>>>();
  private readonly teams = new Map<string, Promise<Map<string, Set<string>>>>();
  private readonly spaces = new Map<string, Promise<Omit<Space, "role">[]>>();
  readonly usernames = new Map<string, string>();
  private readonly agents = new Map<string, WorkspaceAgent | null>();

  constructor(private readonly env: WhoEnv) {}

  workspace(slug: string): Promise<Workspace | null> {
    const key = String(slug ?? "").toLowerCase();
    let found = this.workspaces.get(key);
    if (!found) {
      found = identityClient(this.env.IDENTITY).getWorkspace(key).catch(() => null);
      this.workspaces.set(key, found);
    }
    return found;
  }

  /** The workspace acting for itself: how this service asks identity about its members. */
  actor(workspace: Workspace): User {
    return { id: workspace.id, username: workspace.slug, kind: "workspace", verified: true, workspaces: [{ slug: workspace.slug, role: "member" }] };
  }

  /** The workspace's people by username (lowercased). */
  members(workspace: Workspace): Promise<Map<string, Member>> {
    let found = this.people.get(workspace.id);
    if (!found) {
      found = identityClient(this.env.IDENTITY)
        .listMembers(workspace.slug, this.actor(workspace))
        .then((r) => new Map(r.ok ? r.value.map((m) => [m.username.toLowerCase(), m]) : []))
        .catch(() => new Map<string, Member>());
      this.people.set(workspace.id, found);
    }
    return found;
  }

  /** Each member's teams (slugs, lowercased), by username. */
  teamsOf(workspace: Workspace): Promise<Map<string, Set<string>>> {
    let found = this.teams.get(workspace.id);
    if (!found) {
      found = identityClient(this.env.IDENTITY)
        .teamMemberships(this.actor(workspace), workspace.slug)
        .then((r) => new Map(r.ok ? r.value.map((m) => [m.username.toLowerCase(), new Set(m.teams.map((t) => t.slug.toLowerCase()))]) : []))
        .catch(() => new Map<string, Set<string>>());
      this.teams.set(workspace.id, found);
    }
    return found;
  }

  async nameUsers(ids: string[]): Promise<void> {
    const unnamed = [...new Set(ids)].filter((id) => !this.usernames.has(id));
    if (!unnamed.length) return;
    const named = await identityClient(this.env.IDENTITY)
      .usernames(unnamed)
      .catch(() => ({}) as Record<string, string>);
    for (const [id, username] of Object.entries(named)) this.usernames.set(id, username);
  }

  async agentsById(ids: string[]): Promise<Map<string, WorkspaceAgent | null>> {
    const wanted = [...new Set(ids)].filter((id) => !this.agents.has(id));
    if (wanted.length) {
      let found: WorkspaceAgent[] = [];
      try {
        found = await workspaceAgentsClient(this.env.AGENTS).byIds(wanted);
      } catch (error) {
        console.error("folios could not resolve agents", error);
      }
      for (const id of wanted) this.agents.set(id, found.find((a) => a.id === id) ?? null);
    }
    return new Map(ids.map((id) => [id, this.agents.get(id) ?? null]));
  }

  /** How member keys show. Anything that isn't a person or agent shows as g1t. */
  async profiles(workspace: Workspace, keys: string[]): Promise<Map<string, MemberProfile>> {
    const principals = [...new Set(keys)].map((k) => parsePrincipalKey(k)).filter((p): p is Principal => !!p);
    const userIds = principals.filter((p) => p.kind === "user").map((p) => p.id);
    const agentIds = principals.filter((p) => p.kind === "agent").map((p) => p.id);
    const [, people, agents] = await Promise.all([this.nameUsers(userIds), userIds.length ? this.members(workspace) : new Map<string, Member>(), this.agentsById(agentIds)]);
    const out = new Map<string, MemberProfile>();
    for (const p of principals) {
      if (p.kind === "user") {
        const username = this.usernames.get(p.id) ?? null;
        const person = username ? people.get(username.toLowerCase()) : undefined;
        out.set(principalKey(p), { ...p, name: username ?? "ghost", display_name: person?.name || username || "Former member", avatar: person?.avatar ?? null, role: null, title: null, avatar_seed: null });
      } else {
        const agent = agents.get(p.id) ?? null;
        out.set(principalKey(p), {
          ...p,
          name: agent?.handle ?? p.id,
          display_name: agent?.display_name ?? "Former agent",
          avatar: agent?.avatar ?? null,
          role: agent?.role ?? null,
          title: agent?.title || null,
          avatar_seed: agent?.avatar_seed ?? null,
        });
      }
    }
    for (const key of keys) {
      if (!out.has(key)) out.set(key, { kind: "user", id: key, name: "g1t", display_name: "g1t", avatar: null, role: null, title: null, avatar_seed: null });
    }
    return out;
  }

  async viewerWorkspace(slug: string, viewer: Viewer): Promise<Result<Workspace>> {
    if (!viewer?.id) return fail("unauthenticated", "Sign in to use Artifacts.");
    if (!slug || !isMember(viewer, slug)) return fail("forbidden", "Only members of a workspace can use its Artifacts.");
    const workspace = await this.workspace(slug);
    return workspace ? ok(workspace) : fail("not_found", "No such workspace.");
  }

  viewerOwner(viewer: User, slug: string): boolean {
    return !!viewer.workspaces?.some((m) => m.slug === slug.toLowerCase() && m.role === "owner");
  }

  /** A person as access sees them: their teams, and whether they own the workspace. */
  async personOf(workspace: Workspace, user: Pick<User, "id" | "username">, owner: boolean): Promise<Person> {
    const teams = (await this.teamsOf(workspace)).get(String(user.username ?? "").toLowerCase()) ?? new Set<string>();
    return { user_id: user.id, owner, teams };
  }

  /** The viewer as access sees them. */
  viewerPerson(workspace: Workspace, viewer: User): Promise<Person> {
    return this.personOf(workspace, viewer, this.viewerOwner(viewer, workspace.slug));
  }

  /** People by user id as access sees them: members' teams and ownership; anyone else reads nothing. */
  async peopleByIds(workspace: Workspace, ids: string[]): Promise<Person[]> {
    const unique = [...new Set(ids.map(String))].slice(0, 200);
    await this.nameUsers(unique);
    const [members, teams] = await Promise.all([this.members(workspace), this.teamsOf(workspace)]);
    return unique.map((id) => {
      const username = this.usernames.get(id)?.toLowerCase() ?? "";
      const member = members.get(username);
      return { user_id: member ? id : `outside:${id}`, owner: member?.role === "owner", teams: member ? (teams.get(username) ?? new Set()) : new Set() };
    });
  }

  /** Every space in the workspace (archived too), with members and projects. */
  allSpaces(workspace: Workspace): Promise<Omit<Space, "role">[]> {
    let found = this.spaces.get(workspace.id);
    if (!found) {
      found = (async () => {
        const db = this.env.DB;
        const [spaces, members, projects] = await Promise.all([
          db.prepare("SELECT * FROM spaces WHERE workspace_id = ? ORDER BY is_default DESC, name COLLATE NOCASE").bind(workspace.id).all<SpaceRow>(),
          db
            .prepare("SELECT m.space_id, m.principal, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.workspace_id = ?")
            .bind(workspace.id)
            .all<{ space_id: string; principal: string; role: DocRole }>(),
          db.prepare("SELECT p.space_id, p.repo FROM space_projects p JOIN spaces s ON s.id = p.space_id WHERE s.workspace_id = ?").bind(workspace.id).all<{ space_id: string; repo: string }>(),
        ]);
        return spaces.results.map((row) => ({
          row,
          members: members.results.filter((m) => m.space_id === row.id).map((m) => ({ principal: m.principal, role: m.role })),
          projects: projects.results.filter((p) => p.space_id === row.id).map((p) => p.repo),
        }));
      })();
      this.spaces.set(workspace.id, found);
    }
    return found;
  }

  /** Forget cached spaces after one changed. */
  forgetSpaces(): void {
    this.spaces.clear();
  }

  /** The spaces with `person`'s role in each (null: they can't read it). Archived spaces too. */
  async spacesFor(workspace: Workspace, person: Person): Promise<Space[]> {
    const spaces = await this.allSpaces(workspace);
    return spaces.map((s) => ({ ...s, role: roleOf(rulesOf(s), person) }));
  }

  /** Makes the workspace's General space, once. */
  async ensureDefault(workspace: Workspace, viewer: User): Promise<void> {
    const db = this.env.DB;
    const found = await db.prepare("SELECT id FROM spaces WHERE workspace_id = ? AND is_default = 1").bind(workspace.id).first<{ id: string }>();
    if (found) return;
    const taken = new Set((await db.prepare("SELECT slug FROM spaces WHERE workspace_id = ?").bind(workspace.id).all<{ slug: string }>()).results.map((r) => r.slug));
    await db
      .prepare(
        "INSERT OR IGNORE INTO spaces (id, workspace_id, slug, name, description, icon, kind, team, default_role, agent_mode, is_default, created_by, created_at) VALUES (?, ?, ?, 'General', 'Everything the whole workspace should know.', '📚', 'workspace', NULL, 'edit', 'suggest', 1, ?, ?)",
      )
      .bind(newId("spc"), workspace.id, freeSlug("general", taken), userKey(viewer), now())
      .run();
    this.forgetSpaces();
  }

  toSpace(space: Space, pageCount = 0): DocSpace {
    const created = parsePrincipalKey(space.row.created_by) ?? { kind: "user" as const, id: space.row.created_by };
    return {
      id: space.row.id,
      workspace_id: space.row.workspace_id,
      slug: space.row.slug,
      name: space.row.name,
      description: space.row.description,
      icon: space.row.icon,
      kind: space.row.kind,
      team: space.row.team,
      default_role: space.row.kind === "private" ? null : space.row.default_role,
      agent_mode: space.row.agent_mode,
      editors_can_share: !!space.row.editors_can_share,
      is_default: !!space.row.is_default,
      projects: space.projects,
      created_by: created,
      created_at: space.row.created_at,
      archived_at: space.row.archived_at,
      viewer_role: space.role ?? "view",
      page_count: pageCount,
    };
  }
}
