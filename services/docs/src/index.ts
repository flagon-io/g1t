/**
 * The docs service: a workspace's spaces and pages, their live documents,
 * history, comments, agents' suggestions, templates and search. Plan:
 * docs/WORKSPACE.md, "Docs".
 *
 * Reached through service bindings: `POST /rpc/<method>` with snake_case
 * bodies (`docsClient` in @g1t/contracts); `GET /live` for a page's socket
 * and `PUT /files` for uploads, which the site forwards after checking the
 * session; `GET /files/<key>` for the usercontent origin to serve a file.
 *
 * Each page has a room (src/room.ts), a Durable Object that owns its Yjs
 * document. Everything that changes a page's content goes through the
 * room; this Worker decides who may ask.
 */

import {
  DOCS_VIEWER_HEADER,
  DOC_MAX_FILE_BYTES,
  fail,
  identityClient,
  newId,
  notifyClient,
  ok,
  openD1,
  parsePrincipalKey,
  principalKey,
  workspaceAgentsClient,
  type DocAgentAbilities,
  type DocAgentEditResult,
  type DocAgentMode,
  type DocAgentPage,
  type DocAudience,
  type DocEditTarget,
  type DocFile,
  type DocMove,
  type DocPage,
  type DocPageChange,
  type DocPageDetail,
  type DocPageRef,
  type DocRole,
  type DocSearchHit,
  type DocSearchQuery,
  type DocSpace,
  type DocSpaceChange,
  type DocSpaceKind,
  type DocSpaceMember,
  type DocSuggestion,
  type DocTemplate,
  type DocThread,
  type DocThreadAction,
  type DocTreeNode,
  type DocVersion,
  type DocVersionDetail,
  type DocsHome,
  type DocsLiveEvent,
  type DocsSidebar,
  type Member,
  type MemberProfile,
  type NewDocPage,
  type NewDocSpace,
  type Principal,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  type Workspace,
  type WorkspaceAgent,
} from "@g1t/contracts";

import { RANK, agentAbilities, atLeast, isRole, leavesNoManager, memberKey, readableByAll, readableByWorkspace, roleOf, type Person, type SpaceRules } from "./access.ts";
import { diffLines } from "./diff.ts";
import { r2FileStore, safeName, servedType } from "./files.ts";
import { excerpt, searchText } from "./markdown.ts";
import { ROOM_MEMBER_HEADER, type Origin, type PageRoom, type RoomMember } from "./room.ts";
import { ftsQuery, inProject, projectRef, searchSpaces } from "./search.ts";
import { freeSlug, pageSlug, validSpaceSlug } from "./slugs.ts";
import { BUILTIN_TEMPLATES, builtinTemplate } from "./templates.ts";
import type { ThreadResult } from "./threads.ts";
import { descendants, exportPaths, lastPosition, placeBefore, wouldCycle, ancestors } from "./tree.ts";

export { PageRoom } from "./room.ts";

type Env = {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  AGENTS: ServiceBinding;
  NOTIFY?: ServiceBinding;
  PAGES: DurableObjectNamespace<PageRoom>;
  FILES: R2Bucket;
};

type SpaceRow = {
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
  is_default: number;
  created_by: string;
  created_at: string;
  archived_at: string | null;
};

type PageRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string | null;
  cover: string | null;
  markdown: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
};

type SuggestionRow = {
  id: string;
  page_id: string;
  author: string;
  asked_by: string | null;
  target: string;
  before_markdown: string;
  after_markdown: string;
  note: string | null;
  status: DocSuggestion["status"];
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

type VersionRow = { id: string; page_id: string; created_at: string; kind: DocVersion["kind"]; authors: string; note: string | null; markdown: string; state: ArrayBuffer | null };

/** A space, with who is in it and the viewer's role. */
type Space = { row: SpaceRow; members: { principal: string; role: DocRole }[]; projects: string[]; role: DocRole | null };

/** The page columns lists read: everything but the Markdown. */
const PAGE_COLUMNS = "id, workspace_id, space_id, parent_id, position, title, icon, cover, '' AS markdown, created_by, created_at, updated_by, updated_at, archived_at, archived_by";

const MAX_TITLE = 200;
const MAX_MARKDOWN = 512 * 1024;
const MAX_NOTE = 500;

const now = () => new Date().toISOString();

function isMember(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === String(workspace ?? "").toLowerCase());
}

function rulesOf(space: Space): SpaceRules {
  return { kind: space.row.kind, team: space.row.team, default_role: space.row.default_role, members: space.members };
}

function cleanTitle(title: unknown): string {
  return String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
}

/** One emoji (or a few characters), or null. */
function cleanIcon(icon: unknown): string | null {
  const s = String(icon ?? "").trim();
  if (!s) return null;
  return [...s].slice(0, 4).join("");
}

function cleanCover(cover: unknown): string | null {
  const s = String(cover ?? "").trim();
  if (!s) return null;
  if (/^gradient:\d{1,2}$/.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]{1,500}$/.test(s)) return s;
  return null;
}

function cleanProjects(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((p) => projectRef(String(p))).filter((p): p is string => !!p))].slice(0, 20);
}

function cleanTarget(target: unknown): DocEditTarget | null {
  const t = target as DocEditTarget | null;
  if (!t || typeof t !== "object") return null;
  switch (t.kind) {
    case "append":
    case "document":
      return { kind: t.kind };
    case "section":
      return typeof t.heading === "string" && t.heading.trim() ? { kind: "section", heading: t.heading.trim().slice(0, 300) } : null;
    case "blocks":
      return typeof t.from_block === "string" && typeof t.to_block === "string" ? { kind: "blocks", from_block: t.from_block, to_block: t.to_block } : null;
    default:
      return null;
  }
}

class Docs {
  private readonly workspaces = new Map<string, Promise<Workspace | null>>();
  private readonly people = new Map<string, Promise<Map<string, Member>>>();
  private readonly teams = new Map<string, Promise<Map<string, Set<string>>>>();
  private readonly usernames = new Map<string, string>();
  private readonly agents = new Map<string, WorkspaceAgent | null>();

  constructor(
    private readonly env: Env,
    private readonly defer: (work: Promise<unknown>) => void = () => {},
  ) {}

  private get db() {
    return this.env.DB;
  }

  // ── Who and where ───────────────────────────────────────────────────────

  private workspace(slug: string): Promise<Workspace | null> {
    const key = String(slug ?? "").toLowerCase();
    let found = this.workspaces.get(key);
    if (!found) {
      found = identityClient(this.env.IDENTITY).getWorkspace(key).catch(() => null);
      this.workspaces.set(key, found);
    }
    return found;
  }

  /** The workspace acting for itself: how this service asks identity about its members. */
  private actor(workspace: Workspace): User {
    return { id: workspace.id, username: workspace.slug, kind: "workspace", verified: true, workspaces: [{ slug: workspace.slug, role: "member" }] };
  }

  /** The workspace's people by username. */
  private members(workspace: Workspace): Promise<Map<string, Member>> {
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
  private teamsOf(workspace: Workspace): Promise<Map<string, Set<string>>> {
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

  private async nameUsers(ids: string[]): Promise<void> {
    const unnamed = [...new Set(ids)].filter((id) => !this.usernames.has(id));
    if (!unnamed.length) return;
    const named = await identityClient(this.env.IDENTITY)
      .usernames(unnamed)
      .catch(() => ({}) as Record<string, string>);
    for (const [id, username] of Object.entries(named)) this.usernames.set(id, username);
  }

  private async agentsById(ids: string[]): Promise<Map<string, WorkspaceAgent | null>> {
    const wanted = [...new Set(ids)].filter((id) => !this.agents.has(id));
    if (wanted.length) {
      let found: WorkspaceAgent[] = [];
      try {
        found = await workspaceAgentsClient(this.env.AGENTS).byIds(wanted);
      } catch (error) {
        console.error("docs could not resolve agents", error);
      }
      for (const id of wanted) this.agents.set(id, found.find((a) => a.id === id) ?? null);
    }
    return new Map(ids.map((id) => [id, this.agents.get(id) ?? null]));
  }

  /** How member keys show. Teams show by slug. */
  private async profiles(workspace: Workspace, keys: string[]): Promise<Map<string, MemberProfile>> {
    const principals = [...new Set(keys)].map((k) => parsePrincipalKey(k)).filter((p): p is Principal => !!p);
    const userIds = principals.filter((p) => p.kind === "user").map((p) => p.id);
    const agentIds = principals.filter((p) => p.kind === "agent").map((p) => p.id);
    const [, people, agents] = await Promise.all([this.nameUsers(userIds), userIds.length ? this.members(workspace) : new Map<string, Member>(), this.agentsById(agentIds)]);
    const out = new Map<string, MemberProfile>();
    for (const p of principals) {
      if (p.kind === "user") {
        const username = this.usernames.get(p.id) ?? null;
        const person = username ? people.get(username.toLowerCase()) : undefined;
        out.set(principalKey(p), {
          ...p,
          name: username ?? "ghost",
          display_name: person?.name || username || "Former member",
          avatar: person?.avatar ?? null,
          role: null,
          title: null,
          avatar_seed: null,
        });
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
    // Anything else (system, ghost keys): a plain name.
    for (const key of keys) {
      if (!out.has(key)) out.set(key, { kind: "user", id: key, name: "g1t", display_name: "g1t", avatar: null, role: null, title: null, avatar_seed: null });
    }
    return out;
  }

  private async viewerWorkspace(slug: string, viewer: Viewer): Promise<Result<Workspace>> {
    if (!viewer?.id) return fail("unauthenticated", "Sign in to use Docs.");
    if (!slug || !isMember(viewer, slug)) return fail("forbidden", "Only members of a workspace can use its Docs.");
    const workspace = await this.workspace(slug);
    return workspace ? ok(workspace) : fail("not_found", "No such workspace.");
  }

  /** A person as access sees them. */
  private async personOf(workspace: Workspace, user: Pick<User, "id" | "username">, owner: boolean, needTeams: boolean): Promise<Person> {
    const teams = needTeams ? ((await this.teamsOf(workspace)).get(user.username.toLowerCase()) ?? new Set<string>()) : new Set<string>();
    return { user_id: user.id, owner, teams };
  }

  private viewerOwner(viewer: User, slug: string): boolean {
    return !!viewer.workspaces?.some((m) => m.slug === slug.toLowerCase() && m.role === "owner");
  }

  /** Every space in the workspace (archived ones too when asked), with members and projects. */
  private async allSpaces(workspace: Workspace, archived = false): Promise<Omit<Space, "role">[]> {
    const [spaces, members, projects] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM spaces WHERE workspace_id = ? ${archived ? "" : "AND archived_at IS NULL"} ORDER BY is_default DESC, name COLLATE NOCASE`)
        .bind(workspace.id)
        .all<SpaceRow>(),
      this.db
        .prepare("SELECT m.space_id, m.principal, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.workspace_id = ?")
        .bind(workspace.id)
        .all<{ space_id: string; principal: string; role: DocRole }>(),
      this.db
        .prepare("SELECT p.space_id, p.repo FROM space_projects p JOIN spaces s ON s.id = p.space_id WHERE s.workspace_id = ?")
        .bind(workspace.id)
        .all<{ space_id: string; repo: string }>(),
    ]);
    return spaces.results.map((row) => ({
      row,
      members: members.results.filter((m) => m.space_id === row.id).map((m) => ({ principal: m.principal, role: m.role })),
      projects: projects.results.filter((p) => p.space_id === row.id).map((p) => p.repo),
    }));
  }

  /** Whether any space's access depends on teams. */
  private needsTeams(spaces: Omit<Space, "role">[]): boolean {
    return spaces.some((s) => s.row.kind === "team" || s.members.some((m) => m.principal.startsWith("team:")));
  }

  /** The spaces, each with the viewer's role (null: they can't read it). */
  private async spacesFor(workspace: Workspace, viewer: User, archived = false): Promise<Space[]> {
    const spaces = await this.allSpaces(workspace, archived);
    const person = await this.personOf(workspace, viewer, this.viewerOwner(viewer, workspace.slug), this.needsTeams(spaces));
    return spaces.map((s) => ({ ...s, role: roleOf(rulesOf({ ...s, role: null }), person) }));
  }

  /** Makes the workspace's General space, once. */
  private async ensureDefault(workspace: Workspace, viewer: User): Promise<boolean> {
    const found = await this.db.prepare("SELECT id FROM spaces WHERE workspace_id = ? AND is_default = 1").bind(workspace.id).first<{ id: string }>();
    if (found) return false;
    const taken = new Set((await this.db.prepare("SELECT slug FROM spaces WHERE workspace_id = ?").bind(workspace.id).all<{ slug: string }>()).results.map((r) => r.slug));
    const id = newId("spc");
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO spaces (id, workspace_id, slug, name, description, icon, kind, team, default_role, agent_mode, is_default, created_by, created_at) VALUES (?, ?, ?, 'General', 'Everything the whole workspace should know.', '📚', 'workspace', NULL, 'edit', 'suggest', 1, ?, ?)",
      )
      .bind(id, workspace.id, freeSlug("general", taken), principalKey({ kind: "user", id: viewer.id }), now())
      .run();
    return true;
  }

  private toSpace(space: Space, pageCount = 0): DocSpace {
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
      is_default: !!space.row.is_default,
      projects: space.projects,
      created_by: created,
      created_at: space.row.created_at,
      archived_at: space.row.archived_at,
      viewer_role: space.role ?? "view",
      page_count: pageCount,
    };
  }

  private ref(slug: string, space: Pick<SpaceRow, "id" | "slug">, row: Pick<PageRow, "id" | "title" | "icon">): DocPageRef {
    const s = pageSlug(row.title, row.id);
    return { id: row.id, space_id: space.id, space_slug: space.slug, title: row.title, icon: row.icon, slug: s, path: `/${slug}/-/docs/${space.slug}/${s}` };
  }

  /** Pages as the site shows them, with owners, projects and people resolved. */
  private async toPages(workspace: Workspace, spaces: Map<string, SpaceRow>, rows: PageRow[]): Promise<DocPage[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const [owners, projects, kids] = await Promise.all([
      this.db.prepare(`SELECT page_id, principal FROM page_owners WHERE page_id IN (${marks})`).bind(...ids).all<{ page_id: string; principal: string }>(),
      this.db.prepare(`SELECT page_id, repo FROM page_projects WHERE page_id IN (${marks})`).bind(...ids).all<{ page_id: string; repo: string }>(),
      this.db
        .prepare(`SELECT DISTINCT parent_id FROM pages WHERE parent_id IN (${marks}) AND archived_at IS NULL`)
        .bind(...ids)
        .all<{ parent_id: string }>(),
    ]);
    const keys = [...rows.flatMap((r) => [r.created_by, r.updated_by ?? r.created_by]), ...owners.results.map((o) => o.principal)];
    const people = await this.profiles(workspace, keys);
    const parents = new Set(kids.results.map((k) => k.parent_id));
    return rows.map((row) => {
      const space = spaces.get(row.space_id)!;
      return {
        ...this.ref(workspace.slug, space, row),
        parent_id: row.parent_id,
        position: row.position,
        cover: row.cover,
        created_by: people.get(row.created_by)!,
        created_at: row.created_at,
        updated_by: row.updated_by ? (people.get(row.updated_by) ?? null) : null,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
        has_children: parents.has(row.id),
        projects: projects.results.filter((p) => p.page_id === row.id).map((p) => p.repo),
        owners: owners.results.filter((o) => o.page_id === row.id).map((o) => people.get(o.principal)!),
        excerpt: excerpt(row.markdown ?? ""),
      };
    });
  }

  /** A page and its space, with the viewer's role; not found when they can't read it. */
  private async pageFor(slug: string, pageId: string, viewer: Viewer, need: DocRole): Promise<Result<{ workspace: Workspace; page: PageRow; space: Space; spaces: Space[] }>> {
    const found = await this.viewerWorkspace(slug, viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const page = await this.db.prepare("SELECT * FROM pages WHERE id = ? AND workspace_id = ?").bind(String(pageId ?? ""), workspace.id).first<PageRow>();
    if (!page) return fail("not_found", "No such page.");
    const spaces = await this.spacesFor(workspace, viewer!, true);
    const space = spaces.find((s) => s.row.id === page.space_id);
    if (!space || !space.role) return fail("not_found", "No such page.");
    if (!atLeast(space.role, need)) return fail("forbidden", need === "comment" ? "You can read this page but not comment on it." : "You can read this page but not change it.");
    return ok({ workspace, page, space, spaces });
  }

  private room(pageId: string) {
    return this.env.PAGES.get(this.env.PAGES.idFromName(pageId));
  }

  private tell(pageId: string, event: DocsLiveEvent): void {
    this.defer(
      this.room(pageId)
        .notice(event)
        .catch((error: unknown) => console.error("docs could not tell page", pageId, error)),
    );
  }

  private userKey(viewer: User): string {
    return principalKey({ kind: "user", id: viewer.id });
  }

  // ── Sidebar and home ────────────────────────────────────────────────────

  async sidebar(a: { workspace: string; viewer: Viewer }): Promise<Result<DocsSidebar>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const viewer = a.viewer!;
    await this.ensureDefault(workspace, viewer);
    const spaces = (await this.spacesFor(workspace, viewer)).filter((s) => s.role);
    const ids = spaces.map((s) => s.row.id);
    if (!ids.length) return ok({ spaces: [], favorites: [], recent: [], can_create_space: true, trash_count: 0 });
    const marks = ids.map(() => "?").join(",");
    const [pages, favorites, recent, trash] = await Promise.all([
      this.db
        .prepare(`SELECT id, space_id, parent_id, position, title, icon FROM pages WHERE space_id IN (${marks}) AND archived_at IS NULL ORDER BY position`)
        .bind(...ids)
        .all<Pick<PageRow, "id" | "space_id" | "parent_id" | "position" | "title" | "icon">>(),
      this.db
        .prepare(`SELECT p.id, p.space_id, p.title, p.icon FROM favorites f JOIN pages p ON p.id = f.page_id WHERE f.user_id = ? AND p.space_id IN (${marks}) AND p.archived_at IS NULL ORDER BY f.created_at`)
        .bind(viewer.id, ...ids)
        .all<Pick<PageRow, "id" | "space_id" | "title" | "icon">>(),
      this.db
        .prepare(`SELECT p.id, p.space_id, p.title, p.icon FROM page_views v JOIN pages p ON p.id = v.page_id WHERE v.user_id = ? AND p.space_id IN (${marks}) AND p.archived_at IS NULL ORDER BY v.viewed_at DESC LIMIT 8`)
        .bind(viewer.id, ...ids)
        .all<Pick<PageRow, "id" | "space_id" | "title" | "icon">>(),
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pages WHERE space_id IN (${marks}) AND archived_at IS NOT NULL`)
        .bind(...ids)
        .first<{ n: number }>(),
    ]);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const ref = (r: Pick<PageRow, "id" | "space_id" | "title" | "icon">) => this.ref(workspace.slug, bySpace.get(r.space_id)!, r);
    return ok({
      spaces: spaces.map((s) => {
        const mine = pages.results.filter((p) => p.space_id === s.row.id);
        return {
          ...this.toSpace(s, mine.length),
          pages: mine.map((p): DocTreeNode => ({ id: p.id, parent_id: p.parent_id, position: p.position, title: p.title, icon: p.icon, slug: pageSlug(p.title, p.id) })),
        };
      }),
      favorites: favorites.results.map(ref),
      recent: recent.results.map(ref),
      can_create_space: true,
      trash_count: trash?.n ?? 0,
    });
  }

  async home(a: { workspace: string; viewer: Viewer; project: string | null }): Promise<Result<DocsHome>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const viewer = a.viewer!;
    await this.ensureDefault(workspace, viewer);
    const spaces = (await this.spacesFor(workspace, viewer)).filter((s) => s.role);
    const project = a.project ? projectRef(a.project) : null;
    const ids = spaces.map((s) => s.row.id);
    const allProjects = new Set(spaces.flatMap((s) => s.projects));
    if (!ids.length) return ok({ recent: [], mine: [], spaces: [], projects: [...allProjects].sort(), project });
    const marks = ids.map(() => "?").join(",");
    const [recentRows, mineRows, pageProjects, counts] = await Promise.all([
      this.db
        .prepare(`SELECT id, workspace_id, space_id, parent_id, position, title, icon, cover, substr(markdown, 1, 600) AS markdown, created_by, created_at, updated_by, updated_at, archived_at, archived_by FROM pages WHERE space_id IN (${marks}) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 60`)
        .bind(...ids)
        .all<PageRow>(),
      this.db
        .prepare(
          `SELECT id, workspace_id, space_id, parent_id, position, title, icon, cover, substr(markdown, 1, 600) AS markdown, created_by, created_at, updated_by, updated_at, archived_at, archived_by FROM pages WHERE space_id IN (${marks}) AND archived_at IS NULL AND (created_by = ? OR id IN (SELECT page_id FROM page_owners WHERE principal = ?)) ORDER BY updated_at DESC LIMIT 12`,
        )
        .bind(...ids, this.userKey(viewer), this.userKey(viewer))
        .all<PageRow>(),
      this.db
        .prepare(`SELECT pp.page_id, pp.repo FROM page_projects pp JOIN pages p ON p.id = pp.page_id WHERE p.space_id IN (${marks})`)
        .bind(...ids)
        .all<{ page_id: string; repo: string }>(),
      this.db
        .prepare(`SELECT space_id, COUNT(*) AS n FROM pages WHERE space_id IN (${marks}) AND archived_at IS NULL GROUP BY space_id`)
        .bind(...ids)
        .all<{ space_id: string; n: number }>(),
    ]);
    for (const p of pageProjects.results) allProjects.add(p.repo);
    const projectsOf = (pageId: string) => pageProjects.results.filter((p) => p.page_id === pageId).map((p) => p.repo);
    const spaceProjects = new Map(spaces.map((s) => [s.row.id, s.projects]));
    const keep = (r: PageRow) => inProject(project, projectsOf(r.id), spaceProjects.get(r.space_id) ?? []);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const [recent, mine] = await Promise.all([this.toPages(workspace, bySpace, recentRows.results.filter(keep).slice(0, 12)), this.toPages(workspace, bySpace, mineRows.results.filter(keep).slice(0, 8))]);
    const count = new Map(counts.results.map((c) => [c.space_id, c.n]));
    return ok({
      recent,
      mine,
      spaces: spaces.filter((s) => !project || s.projects.includes(project) || recentRows.results.some((r) => r.space_id === s.row.id && keep(r))).map((s) => this.toSpace(s, count.get(s.row.id) ?? 0)),
      projects: [...allProjects].sort(),
      project,
    });
  }

  // ── Spaces ──────────────────────────────────────────────────────────────

  private async spaceMembers(workspace: Workspace, space: Space): Promise<DocSpaceMember[]> {
    const people = await this.profiles(
      workspace,
      space.members.filter((m) => !m.principal.startsWith("team:")).map((m) => m.principal),
    );
    return space.members
      .map((m): DocSpaceMember => {
        const key = memberKey(m.principal);
        if (key?.kind === "team") return { key: m.principal, kind: "team", name: key.id, display_name: `@${workspace.slug}/${key.id}`, avatar: null, role: m.role };
        const p = people.get(m.principal)!;
        return { key: m.principal, kind: p.kind, name: p.name, display_name: p.display_name, avatar: p.avatar, avatar_seed: p.avatar_seed ?? null, role: m.role };
      })
      .sort((x, y) => RANK[y.role] - RANK[x.role] || x.display_name.localeCompare(y.display_name));
  }

  async space(a: { workspace: string; space: string; viewer: Viewer }): Promise<Result<{ space: DocSpace; members: DocSpaceMember[]; pages: DocPage[] }>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = await this.spacesFor(workspace, a.viewer!, true);
    const space = spaces.find((s) => s.row.slug === String(a.space ?? "").toLowerCase() || s.row.id === a.space);
    if (!space?.role) return fail("not_found", "No such space.");
    const rows = (
      await this.db
        .prepare("SELECT id, workspace_id, space_id, parent_id, position, title, icon, cover, substr(markdown, 1, 600) AS markdown, created_by, created_at, updated_by, updated_at, archived_at, archived_by FROM pages WHERE space_id = ? AND archived_at IS NULL ORDER BY position")
        .bind(space.row.id)
        .all<PageRow>()
    ).results;
    const [members, pages] = await Promise.all([this.spaceMembers(workspace, space), this.toPages(workspace, new Map([[space.row.id, space.row]]), rows)]);
    return ok({ space: this.toSpace(space, rows.length), members, pages });
  }

  async createSpace(a: { workspace: string; viewer: Viewer; input: NewDocSpace }): Promise<Result<DocSpace>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const viewer = a.viewer!;
    const input = a.input ?? ({} as NewDocSpace);
    const name = cleanTitle(input.name).slice(0, 80);
    if (!name) return fail("invalid", "Name the space.");
    const kind: DocSpaceKind = input.kind === "team" || input.kind === "private" ? input.kind : "workspace";
    const team = kind === "team" ? String(input.team ?? "").trim().toLowerCase() : null;
    if (kind === "team") {
      if (!team) return fail("invalid", "Choose the team the space is for.");
      const teams = await this.teamsOf(workspace);
      const known = [...teams.values()].some((set) => set.has(team));
      if (!known) return fail("invalid", "No such team in this workspace.");
    }
    const taken = new Set((await this.db.prepare("SELECT slug FROM spaces WHERE workspace_id = ?").bind(workspace.id).all<{ slug: string }>()).results.map((r) => r.slug));
    let slug: string;
    if (input.slug) {
      const wanted = validSpaceSlug(input.slug);
      if (!wanted) return fail("invalid", "A space's address is lowercase letters, numbers and hyphens.");
      if (taken.has(wanted)) return fail("conflict", "Another space has that address.");
      slug = wanted;
    } else slug = freeSlug(name, taken);
    const defaultRole: DocRole | null = kind === "private" ? null : isRole(input.default_role) ? input.default_role : "edit";
    const id = newId("spc");
    const at = now();
    const me = this.userKey(viewer);
    const projects = cleanProjects(input.projects);
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO spaces (id, workspace_id, slug, name, description, icon, kind, team, default_role, agent_mode, is_default, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .bind(id, workspace.id, slug, name, String(input.description ?? "").trim().slice(0, 300) || null, cleanIcon(input.icon), kind, team, defaultRole, input.agent_mode === "edit" ? "edit" : "suggest", me, at),
      // Whoever makes a space manages it.
      this.db.prepare("INSERT INTO space_members (space_id, principal, role, added_by, added_at) VALUES (?, ?, 'manage', ?, ?)").bind(id, me, me, at),
      ...projects.map((repo) => this.db.prepare("INSERT INTO space_projects (space_id, repo) VALUES (?, ?)").bind(id, repo)),
    ]);
    const spaces = await this.spacesFor(workspace, viewer);
    const space = spaces.find((s) => s.row.id === id)!;
    return ok(this.toSpace(space));
  }

  async updateSpace(a: { workspace: string; space_id: string; viewer: Viewer; change: DocSpaceChange }): Promise<Result<DocSpace>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = await this.spacesFor(workspace, a.viewer!, true);
    const space = spaces.find((s) => s.row.id === a.space_id);
    if (!space?.role) return fail("not_found", "No such space.");
    if (!atLeast(space.role, "manage")) return fail("forbidden", "Only people with full access can change a space.");
    const c = a.change ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (c.name !== undefined) {
      const name = cleanTitle(c.name).slice(0, 80);
      if (!name) return fail("invalid", "Name the space.");
      set("name", name);
    }
    if (c.description !== undefined) set("description", String(c.description ?? "").trim().slice(0, 300) || null);
    if (c.icon !== undefined) set("icon", cleanIcon(c.icon));
    if (c.slug !== undefined && c.slug !== space.row.slug) {
      const wanted = validSpaceSlug(String(c.slug ?? ""));
      if (!wanted) return fail("invalid", "A space's address is lowercase letters, numbers and hyphens.");
      const clash = await this.db.prepare("SELECT 1 FROM spaces WHERE workspace_id = ? AND slug = ? AND id <> ?").bind(workspace.id, wanted, space.row.id).first();
      if (clash) return fail("conflict", "Another space has that address.");
      set("slug", wanted);
    }
    if (c.kind !== undefined && c.kind !== space.row.kind) {
      if (space.row.is_default) return fail("invalid", "The General space is always the whole workspace's.");
      if (c.kind !== "workspace" && c.kind !== "team" && c.kind !== "private") return fail("invalid", "Choose who the space is for.");
      set("kind", c.kind);
      if (c.kind === "private") set("default_role", null);
      else if (!space.row.default_role) set("default_role", "edit");
      if (c.kind === "private" && !space.members.some((m) => m.role === "manage")) {
        // Someone must still manage it: whoever made it private.
        await this.db
          .prepare("INSERT INTO space_members (space_id, principal, role, added_by, added_at) VALUES (?, ?, 'manage', ?, ?) ON CONFLICT (space_id, principal) DO UPDATE SET role = 'manage'")
          .bind(space.row.id, this.userKey(a.viewer!), this.userKey(a.viewer!), now())
          .run();
      }
    }
    if (c.team !== undefined) set("team", c.team ? String(c.team).trim().toLowerCase() : null);
    if (c.default_role !== undefined && (c.kind ?? space.row.kind) !== "private") set("default_role", isRole(c.default_role) ? c.default_role : null);
    if (c.agent_mode !== undefined) set("agent_mode", c.agent_mode === "edit" ? "edit" : "suggest");
    if (c.archived !== undefined) {
      if (space.row.is_default && c.archived) return fail("invalid", "The General space can't be archived.");
      set("archived_at", c.archived ? now() : null);
    }
    const statements: D1PreparedStatement[] = [];
    if (sets.length) statements.push(this.db.prepare(`UPDATE spaces SET ${sets.join(", ")} WHERE id = ?`).bind(...values, space.row.id));
    if (c.projects !== undefined) {
      statements.push(this.db.prepare("DELETE FROM space_projects WHERE space_id = ?").bind(space.row.id));
      for (const repo of cleanProjects(c.projects)) statements.push(this.db.prepare("INSERT INTO space_projects (space_id, repo) VALUES (?, ?)").bind(space.row.id, repo));
    }
    if (statements.length) await this.db.batch(statements);
    this.workspaces.clear();
    const after = (await this.spacesFor(workspace, a.viewer!, true)).find((s) => s.row.id === space.row.id)!;
    return ok(this.toSpace(after));
  }

  async setSpaceMember(a: { workspace: string; space_id: string; viewer: Viewer; member: string; role: DocRole | null }): Promise<Result<DocSpaceMember[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = await this.spacesFor(workspace, a.viewer!, true);
    const space = spaces.find((s) => s.row.id === a.space_id);
    if (!space?.role) return fail("not_found", "No such space.");
    if (!atLeast(space.role, "manage")) return fail("forbidden", "Only people with full access can change who is in a space.");
    const key = memberKey(String(a.member ?? ""));
    if (!key) return fail("invalid", "Choose a person, agent or team.");
    const role = a.role === null ? null : isRole(a.role) ? a.role : null;
    if (a.role !== null && !role) return fail("invalid", "Choose a role.");
    // They must belong to the workspace.
    if (key.kind === "user") {
      await this.nameUsers([key.id]);
      const username = this.usernames.get(key.id);
      if (!username || !(await this.members(workspace)).has(username.toLowerCase())) return fail("invalid", "Only members of the workspace can be added.");
    } else if (key.kind === "agent") {
      const agent = (await this.agentsById([key.id])).get(key.id);
      if (!agent || agent.workspace_id !== workspace.id || agent.archived_at) return fail("invalid", "No such agent in this workspace.");
    } else {
      const teams = await this.teamsOf(workspace);
      if (![...teams.values()].some((set) => set.has(key.id.toLowerCase()))) return fail("invalid", "No such team in this workspace.");
    }
    const principal = key.kind === "team" ? `team:${key.id.toLowerCase()}` : `${key.kind}:${key.id}`;
    if (leavesNoManager(space.row.kind, space.members, principal, role)) return fail("invalid", "Someone must keep full access to a private space.");
    if (role) {
      await this.db
        .prepare("INSERT INTO space_members (space_id, principal, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (space_id, principal) DO UPDATE SET role = excluded.role")
        .bind(space.row.id, principal, role, this.userKey(a.viewer!), now())
        .run();
    } else {
      await this.db.prepare("DELETE FROM space_members WHERE space_id = ? AND principal = ?").bind(space.row.id, principal).run();
    }
    const after = (await this.spacesFor(workspace, a.viewer!, true)).find((s) => s.row.id === space.row.id)!;
    return ok(await this.spaceMembers(workspace, after));
  }

  // ── Pages ───────────────────────────────────────────────────────────────

  async page(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocPageDetail>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    const { workspace, page, space, spaces } = found.value;
    const viewer = a.viewer!;
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const readable = new Set(spaces.filter((s) => s.role).map((s) => s.row.id));
    const [tree, backlinks, children, favorite, viewed, suggestions] = await Promise.all([
      this.db.prepare("SELECT id, space_id, parent_id, position, title, icon FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>(),
      this.db
        .prepare("SELECT p.id, p.space_id, p.title, p.icon FROM page_links l JOIN pages p ON p.id = l.from_page WHERE l.to_page = ? AND p.archived_at IS NULL LIMIT 50")
        .bind(page.id)
        .all<PageRow>(),
      this.db.prepare("SELECT id, space_id, title, icon FROM pages WHERE parent_id = ? AND archived_at IS NULL ORDER BY position").bind(page.id).all<PageRow>(),
      this.db.prepare("SELECT 1 AS yes FROM favorites WHERE user_id = ? AND page_id = ?").bind(viewer.id, page.id).first<{ yes: number }>(),
      this.db.prepare("SELECT viewed_at FROM page_views WHERE user_id = ? AND page_id = ?").bind(viewer.id, page.id).first<{ viewed_at: string }>(),
      this.openSuggestions(workspace, page.id),
    ]);
    this.defer(
      this.db
        .prepare("INSERT INTO page_views (page_id, user_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT (page_id, user_id) DO UPDATE SET viewed_at = excluded.viewed_at")
        .bind(page.id, viewer.id, now())
        .run(),
    );
    const [detail] = await this.toPages(workspace, bySpace, [page]);
    return ok({
      page: detail!,
      space: this.toSpace(space),
      breadcrumbs: ancestors(tree.results, page.id).map((r) => this.ref(workspace.slug, space.row, r)),
      markdown: page.markdown,
      role: space.role!,
      backlinks: backlinks.results.filter((r) => readable.has(r.space_id)).map((r) => this.ref(workspace.slug, bySpace.get(r.space_id)!, r)),
      children: children.results.map((r) => this.ref(workspace.slug, space.row, r)),
      favorite: !!favorite,
      last_viewed_at: viewed?.viewed_at ?? null,
      suggestions,
    });
  }

  /** Where a new page in `space` from `input` starts: its Markdown and title. */
  private async startingPoint(workspace: Workspace, input: NewDocPage): Promise<{ markdown: string; title: string; icon: string | null }> {
    let markdown = String(input.markdown ?? "").slice(0, MAX_MARKDOWN);
    let title = cleanTitle(input.title);
    let icon = cleanIcon(input.icon);
    if (input.template_id) {
      const template = builtinTemplate(input.template_id) ?? (await this.savedTemplate(workspace, input.template_id));
      if (template) {
        markdown = template.markdown;
        if (!title) title = template.name;
        if (!icon) icon = template.icon;
      }
    }
    return { markdown, title, icon };
  }

  private async savedTemplate(workspace: Workspace, id: string): Promise<DocTemplate | null> {
    const row = await this.db
      .prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?")
      .bind(id, workspace.id)
      .first<{ id: string; name: string; description: string; icon: string; markdown: string; created_by: string }>();
    if (!row) return null;
    return { id: row.id, name: row.name, description: row.description, icon: row.icon, markdown: row.markdown, builtin: false, created_by: parsePrincipalKey(row.created_by) };
  }

  /** Inserts a page row and fills its room. */
  private async insertPage(
    workspace: Workspace,
    space: SpaceRow,
    author: string,
    input: { parent_id: string | null; title: string; icon: string | null; markdown: string; state?: Uint8Array | null; projects?: string[]; owners?: string[]; position?: number },
  ): Promise<PageRow> {
    const rows = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(space.id).all<PageRow>()).results;
    const id = newId("pag");
    const at = now();
    const position = input.position ?? lastPosition(rows, input.parent_id);
    const row: PageRow = {
      id,
      workspace_id: workspace.id,
      space_id: space.id,
      parent_id: input.parent_id,
      position,
      title: input.title,
      icon: input.icon,
      cover: null,
      markdown: input.markdown,
      created_by: author,
      created_at: at,
      updated_by: author,
      updated_at: at,
      archived_at: null,
      archived_by: null,
    };
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO pages (id, workspace_id, space_id, parent_id, position, title, icon, cover, markdown, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(id, workspace.id, space.id, input.parent_id, position, input.title, input.icon, input.markdown, author, at, author, at),
      this.db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").bind(id, input.title, searchText(input.markdown)),
      this.db.prepare("INSERT INTO page_owners (page_id, principal) VALUES (?, ?)").bind(id, author),
      ...(input.owners ?? []).filter((o) => o !== author).map((o) => this.db.prepare("INSERT OR IGNORE INTO page_owners (page_id, principal) VALUES (?, ?)").bind(id, o)),
      ...(input.projects ?? []).map((repo) => this.db.prepare("INSERT OR IGNORE INTO page_projects (page_id, repo) VALUES (?, ?)").bind(id, repo)),
      this.db
        .prepare("INSERT INTO page_versions (id, page_id, created_at, kind, authors, note, markdown, state) VALUES (?, ?, ?, 'created', ?, NULL, ?, NULL)")
        .bind(newId("ver"), id, at, JSON.stringify([author]), input.markdown),
    ]);
    await this.room(id).ensure({ page_id: id, workspace_slug: workspace.slug, markdown: input.markdown, state: input.state ?? null });
    return row;
  }

  async createPage(a: { workspace: string; viewer: Viewer; input: NewDocPage }): Promise<Result<DocPage>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const input = a.input ?? ({} as NewDocPage);
    const spaces = await this.spacesFor(workspace, a.viewer!);
    const space = spaces.find((s) => s.row.id === input.space_id) ?? (input.space_id ? null : spaces.find((s) => s.row.is_default));
    if (!space?.role) return fail("not_found", "No such space.");
    if (!atLeast(space.role, "edit")) return fail("forbidden", "You can read this space but not add pages to it.");
    const parent = input.parent_id
      ? await this.db.prepare("SELECT id FROM pages WHERE id = ? AND space_id = ? AND archived_at IS NULL").bind(input.parent_id, space.row.id).first<{ id: string }>()
      : null;
    if (input.parent_id && !parent) return fail("not_found", "No such parent page.");
    const start = await this.startingPoint(workspace, input);
    const row = await this.insertPage(workspace, space.row, this.userKey(a.viewer!), {
      parent_id: parent?.id ?? null,
      title: start.title,
      icon: start.icon,
      markdown: start.markdown,
      projects: cleanProjects(input.projects),
    });
    const [page] = await this.toPages(workspace, new Map([[space.row.id, space.row]]), [row]);
    return ok(page!);
  }

  async updatePage(a: { workspace: string; page_id: string; viewer: Viewer; change: DocPageChange }): Promise<Result<DocPage>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    const c = a.change ?? {};
    const statements: D1PreparedStatement[] = [];
    const sets: string[] = [];
    const values: unknown[] = [];
    if (c.title !== undefined) {
      sets.push("title = ?");
      values.push(cleanTitle(c.title));
      statements.push(this.db.prepare("UPDATE pages_fts SET title = ? WHERE page_id = ?").bind(cleanTitle(c.title), page.id));
    }
    if (c.icon !== undefined) {
      sets.push("icon = ?");
      values.push(cleanIcon(c.icon));
    }
    if (c.cover !== undefined) {
      sets.push("cover = ?");
      values.push(cleanCover(c.cover));
    }
    if (sets.length) {
      sets.push("updated_at = ?", "updated_by = ?");
      values.push(now(), this.userKey(a.viewer!));
      statements.unshift(this.db.prepare(`UPDATE pages SET ${sets.join(", ")} WHERE id = ?`).bind(...values, page.id));
    }
    if (c.projects !== undefined) {
      statements.push(this.db.prepare("DELETE FROM page_projects WHERE page_id = ?").bind(page.id));
      for (const repo of cleanProjects(c.projects)) statements.push(this.db.prepare("INSERT INTO page_projects (page_id, repo) VALUES (?, ?)").bind(page.id, repo));
    }
    if (c.owners !== undefined) {
      const owners = [...new Set((Array.isArray(c.owners) ? c.owners : []).map(String).filter((k) => memberKey(k)?.kind === "user" || memberKey(k)?.kind === "agent"))].slice(0, 20);
      statements.push(this.db.prepare("DELETE FROM page_owners WHERE page_id = ?").bind(page.id));
      for (const o of owners) statements.push(this.db.prepare("INSERT INTO page_owners (page_id, principal) VALUES (?, ?)").bind(page.id, o));
    }
    if (statements.length) await this.db.batch(statements);
    const after = await this.db.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>();
    const [detail] = await this.toPages(workspace, new Map([[space.row.id, space.row]]), [after!]);
    this.tell(page.id, { type: "page.updated", page: detail! });
    return ok(detail!);
  }

  async movePage(a: { workspace: string; page_id: string; viewer: Viewer; move: DocMove }): Promise<Result<DocPage>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page, spaces } = found.value;
    const move = a.move ?? ({ parent_id: null } as DocMove);
    const target = move.space_id ? spaces.find((s) => s.row.id === move.space_id) : spaces.find((s) => s.row.id === page.space_id);
    if (!target?.role || target.row.archived_at) return fail("not_found", "No such space.");
    if (!atLeast(target.role, "edit")) return fail("forbidden", "You can't add pages to that space.");
    const [sourceRows, targetRows] = await Promise.all([
      this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(page.space_id).all<PageRow>(),
      this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(target.row.id).all<PageRow>(),
    ]);
    const parent = move.parent_id ?? null;
    if (parent && !targetRows.results.some((r) => r.id === parent)) return fail("not_found", "No such parent page in that space.");
    if (wouldCycle(sourceRows.results, page.id, parent)) return fail("invalid", "A page can't go inside itself.");
    const placed = placeBefore(targetRows.results, page.id, parent, move.before_id ?? null);
    const statements: D1PreparedStatement[] = [this.db.prepare("UPDATE pages SET parent_id = ?, position = ? WHERE id = ?").bind(parent, placed.position, page.id)];
    for (const [id, position] of placed.renumber) statements.push(this.db.prepare("UPDATE pages SET position = ? WHERE id = ?").bind(position, id));
    if (target.row.id !== page.space_id) {
      // The page and everything under it move to the other space.
      const all = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>()).results;
      for (const id of descendants(all, page.id)) statements.push(this.db.prepare("UPDATE pages SET space_id = ? WHERE id = ?").bind(target.row.id, id));
    }
    await this.db.batch(statements);
    const after = await this.db.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>();
    const [detail] = await this.toPages(workspace, new Map(spaces.map((s) => [s.row.id, s.row])), [after!]);
    this.tell(page.id, { type: "page.updated", page: detail! });
    return ok(detail!);
  }

  async duplicatePage(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocPage>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const [state, read] = await Promise.all([room.state(), room.read()]);
    const rows = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(page.space_id).all<PageRow>()).results;
    const next = rows.filter((r) => r.parent_id === page.parent_id).sort((x, y) => x.position - y.position).find((r) => r.position > page.position);
    const row = await this.insertPage(workspace, space.row, this.userKey(a.viewer!), {
      parent_id: page.parent_id,
      title: `${page.title || "Untitled"} (copy)`.slice(0, MAX_TITLE),
      icon: page.icon,
      markdown: read.markdown,
      state,
      position: next ? (page.position + next.position) / 2 : page.position + 1024,
    });
    const [detail] = await this.toPages(workspace, new Map([[space.row.id, space.row]]), [row]);
    return ok(detail!);
  }

  async archivePage(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocPage>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    const all = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(page.space_id).all<PageRow>()).results;
    const ids = descendants(all, page.id);
    const at = now();
    await this.db.batch(ids.map((id) => this.db.prepare("UPDATE pages SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL").bind(at, this.userKey(a.viewer!), id)));
    for (const id of ids) this.defer(this.room(id).closeAll("Moved to the trash").catch(() => undefined));
    const after = await this.db.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>();
    const [detail] = await this.toPages(workspace, new Map([[space.row.id, space.row]]), [after!]);
    return ok(detail!);
  }

  async restorePage(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocPage>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    if (!page.archived_at) return fail("invalid", "That page isn't in the trash.");
    // It comes back with what was trashed with it; under its parent if that is still there.
    const all = (await this.db.prepare("SELECT id, parent_id, position, archived_at FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>()).results;
    const parent = page.parent_id ? all.find((r) => r.id === page.parent_id) : null;
    const parentGone = !!page.parent_id && (!parent || !!parent.archived_at);
    const ids = descendants(all, page.id).filter((id) => all.find((r) => r.id === id)?.archived_at === page.archived_at);
    const statements = ids.map((id) => this.db.prepare("UPDATE pages SET archived_at = NULL, archived_by = NULL WHERE id = ?").bind(id));
    if (parentGone) statements.push(this.db.prepare("UPDATE pages SET parent_id = NULL WHERE id = ?").bind(page.id));
    await this.db.batch(statements);
    const after = await this.db.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>();
    const [detail] = await this.toPages(workspace, new Map([[space.row.id, space.row]]), [after!]);
    return ok(detail!);
  }

  async deletePage(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<boolean>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "manage");
    if (!found.ok) return found;
    const { page } = found.value;
    if (!page.archived_at) return fail("invalid", "Move the page to the trash first.");
    const all = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>()).results;
    const ids = descendants(all, page.id);
    await this.db.batch(ids.flatMap((id) => [this.db.prepare("DELETE FROM pages_fts WHERE page_id = ?").bind(id), this.db.prepare("DELETE FROM pages WHERE id = ?").bind(id)]));
    return ok(true);
  }

  async trash(a: { workspace: string; viewer: Viewer }): Promise<Result<DocPage[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = (await this.spacesFor(workspace, a.viewer!)).filter((s) => atLeast(s.role, "edit"));
    if (!spaces.length) return ok([]);
    const marks = spaces.map(() => "?").join(",");
    const rows = (
      await this.db
        .prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE space_id IN (${marks}) AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 200`)
        .bind(...spaces.map((s) => s.row.id))
        .all<PageRow>()
    ).results;
    return ok(await this.toPages(workspace, new Map(spaces.map((s) => [s.row.id, s.row])), rows));
  }

  async favorite(a: { workspace: string; page_id: string; viewer: Viewer; on: boolean }): Promise<Result<boolean>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    if (a.on) {
      await this.db.prepare("INSERT OR IGNORE INTO favorites (user_id, page_id, created_at) VALUES (?, ?, ?)").bind(a.viewer!.id, a.page_id, now()).run();
    } else {
      await this.db.prepare("DELETE FROM favorites WHERE user_id = ? AND page_id = ?").bind(a.viewer!.id, a.page_id).run();
    }
    return ok(!!a.on);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /** Full text over `spaceIds`, best first. */
  private async searchIn(workspace: Workspace, spaces: Space[], query: DocSearchQuery): Promise<DocSearchHit[]> {
    const q = ftsQuery(query.query);
    const ids = searchSpaces(
      spaces.map((s) => s.row.id),
      query.space_id ?? null,
    );
    if (!ids.length) return [];
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const marks = ids.map(() => "?").join(",");
    const project = query.project ? projectRef(query.project) : null;
    type Hit = { id: string; space_id: string; title: string; icon: string | null; updated_at: string; snippet: string };
    let rows: Hit[];
    if (q) {
      rows = (
        await this.db
          .prepare(
            `SELECT p.id, p.space_id, p.title, p.icon, p.updated_at, snippet(pages_fts, 2, '[[', ']]', '…', 16) AS snippet
             FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id
             WHERE pages_fts MATCH ? AND p.space_id IN (${marks}) AND p.archived_at IS NULL
             ORDER BY bm25(pages_fts, 0, 8.0, 1.0) LIMIT ?`,
          )
          .bind(q, ...ids, limit * 3)
          .all<Hit>()
      ).results;
    } else {
      rows = (
        await this.db
          .prepare(`SELECT id, space_id, title, icon, updated_at, substr(markdown, 1, 160) AS snippet FROM pages WHERE space_id IN (${marks}) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`)
          .bind(...ids, limit * 3)
          .all<Hit>()
      ).results;
    }
    const pageIds = rows.map((r) => r.id);
    const projects = pageIds.length
      ? (
          await this.db
            .prepare(`SELECT page_id, repo FROM page_projects WHERE page_id IN (${pageIds.map(() => "?").join(",")})`)
            .bind(...pageIds)
            .all<{ page_id: string; repo: string }>()
        ).results
      : [];
    const bySpace = new Map(spaces.map((s) => [s.row.id, s]));
    return rows
      .map((r) => {
        const space = bySpace.get(r.space_id)!;
        const own = projects.filter((p) => p.page_id === r.id).map((p) => p.repo);
        return { r, space, own };
      })
      .filter(({ space, own }) => inProject(project, own, space.projects))
      .slice(0, limit)
      .map(({ r, space, own }) => ({
        ...this.ref(workspace.slug, space.row, r),
        space_name: space.row.name,
        snippet: q ? r.snippet : excerpt(r.snippet, 140),
        updated_at: r.updated_at,
        projects: [...new Set([...own, ...space.projects])],
      }));
  }

  async search(a: { workspace: string; viewer: Viewer; query: DocSearchQuery }): Promise<Result<DocSearchHit[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = (await this.spacesFor(workspace, a.viewer!)).filter((s) => s.role);
    return ok(await this.searchIn(workspace, spaces, a.query ?? { query: "" }));
  }

  // ── History ─────────────────────────────────────────────────────────────

  private async toVersions(workspace: Workspace, rows: Omit<VersionRow, "markdown" | "state">[]): Promise<DocVersion[]> {
    const authors = rows.map((r) => {
      try {
        return JSON.parse(r.authors) as string[];
      } catch {
        return [];
      }
    });
    const people = await this.profiles(workspace, authors.flat());
    return rows.map((r, i) => ({ id: r.id, page_id: r.page_id, created_at: r.created_at, kind: r.kind, note: r.note, authors: authors[i]!.map((k) => people.get(k)!).filter(Boolean) }));
  }

  async versions(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocVersion[]>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    // Whatever is unsaved goes in first, so the newest version is now.
    await this.room(a.page_id)
      .flush()
      .catch(() => undefined);
    const rows = (
      await this.db
        .prepare("SELECT id, page_id, created_at, kind, authors, note FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 200")
        .bind(a.page_id)
        .all<Omit<VersionRow, "markdown" | "state">>()
    ).results;
    return ok(await this.toVersions(found.value.workspace, rows));
  }

  async version(a: { workspace: string; page_id: string; version_id: string; viewer: Viewer }): Promise<Result<DocVersionDetail>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    const row = await this.db
      .prepare("SELECT id, page_id, created_at, kind, authors, note, markdown FROM page_versions WHERE id = ? AND page_id = ?")
      .bind(a.version_id, a.page_id)
      .first<Omit<VersionRow, "state">>();
    if (!row) return fail("not_found", "No such version.");
    const before = await this.db
      .prepare("SELECT markdown FROM page_versions WHERE page_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1")
      .bind(a.page_id, row.created_at)
      .first<{ markdown: string }>();
    const [version] = await this.toVersions(found.value.workspace, [row]);
    return ok({ ...version!, markdown: row.markdown, diff: diffLines(before?.markdown ?? "", row.markdown) });
  }

  async restoreVersion(a: { workspace: string; page_id: string; version_id: string; viewer: Viewer }): Promise<Result<DocVersion>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const { workspace, page } = found.value;
    const row = await this.db.prepare("SELECT * FROM page_versions WHERE id = ? AND page_id = ?").bind(a.version_id, page.id).first<VersionRow>();
    if (!row) return fail("not_found", "No such version.");
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const when = new Date(row.created_at).toISOString().slice(0, 16).replace("T", " ");
    const origin: Origin = { key: this.userKey(a.viewer!), kind: "restore", note: `Restored the version of ${when} UTC` };
    const versionId = await room.restore({ state: row.state ? new Uint8Array(row.state) : null, markdown: row.markdown }, origin);
    const created = versionId
      ? await this.db.prepare("SELECT id, page_id, created_at, kind, authors, note FROM page_versions WHERE id = ?").bind(versionId).first<Omit<VersionRow, "markdown" | "state">>()
      : null;
    if (!created) return fail("conflict", "The page could not be restored. Try again.");
    const [version] = await this.toVersions(workspace, [created]);
    this.tell(page.id, { type: "version.created", version: version! });
    return ok(version!);
  }

  // ── Templates and export ────────────────────────────────────────────────

  async templates(a: { workspace: string; viewer: Viewer }): Promise<Result<DocTemplate[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const rows = (
      await this.db
        .prepare("SELECT * FROM templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE")
        .bind(found.value.id)
        .all<{ id: string; name: string; description: string; icon: string; markdown: string; created_by: string }>()
    ).results;
    return ok([
      ...BUILTIN_TEMPLATES,
      ...rows.map((r) => ({ id: r.id, name: r.name, description: r.description, icon: r.icon, markdown: r.markdown, builtin: false, created_by: parsePrincipalKey(r.created_by) })),
    ]);
  }

  async saveTemplate(a: { workspace: string; viewer: Viewer; input: { page_id: string; name: string; description?: string | null } }): Promise<Result<DocTemplate>> {
    const found = await this.pageFor(a.workspace, a.input?.page_id, a.viewer, "view");
    if (!found.ok) return found;
    const { workspace, page } = found.value;
    const name = cleanTitle(a.input.name || page.title).slice(0, 80);
    if (!name) return fail("invalid", "Name the template.");
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const { markdown } = await room.read();
    const id = newId("tpl");
    const description = String(a.input.description ?? "").trim().slice(0, 200);
    await this.db
      .prepare("INSERT INTO templates (id, workspace_id, name, description, icon, markdown, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, workspace.id, name, description, page.icon ?? "📄", markdown, this.userKey(a.viewer!), now())
      .run();
    return ok({ id, name, description, icon: page.icon ?? "📄", markdown, builtin: false, created_by: { kind: "user", id: a.viewer!.id } });
  }

  async deleteTemplate(a: { workspace: string; template_id: string; viewer: Viewer }): Promise<Result<boolean>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const row = await this.db.prepare("SELECT created_by FROM templates WHERE id = ? AND workspace_id = ?").bind(a.template_id, found.value.id).first<{ created_by: string }>();
    if (!row) return fail("not_found", "No such template.");
    if (row.created_by !== this.userKey(a.viewer!) && !this.viewerOwner(a.viewer!, a.workspace)) return fail("forbidden", "Only whoever saved a template, or an owner, can delete it.");
    await this.db.prepare("DELETE FROM templates WHERE id = ?").bind(a.template_id).run();
    return ok(true);
  }

  async exportPage(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<{ filename: string; markdown: string }>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    const { workspace, page } = found.value;
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const { markdown } = await room.read();
    const title = page.title || "Untitled";
    return ok({ filename: `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "page"}.md`, markdown: `# ${title}\n\n${markdown}` });
  }

  async exportSpace(a: { workspace: string; space_id: string; viewer: Viewer }): Promise<Result<{ name: string; files: { path: string; markdown: string }[] }>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const spaces = await this.spacesFor(found.value, a.viewer!);
    const space = spaces.find((s) => s.row.id === a.space_id);
    if (!space?.role) return fail("not_found", "No such space.");
    const rows = (
      await this.db.prepare("SELECT id, parent_id, position, title, markdown FROM pages WHERE space_id = ? AND archived_at IS NULL").bind(space.row.id).all<PageRow>()
    ).results;
    const paths = exportPaths(rows.map((r) => ({ ...r, title: r.title || "Untitled" })));
    return ok({
      name: space.row.slug,
      files: rows.map((r) => ({ path: paths.get(r.id)!, markdown: `# ${r.title || "Untitled"}\n\n${r.markdown}` })).sort((x, y) => x.path.localeCompare(y.path)),
    });
  }

  // ── Suggestions ─────────────────────────────────────────────────────────

  private async toSuggestions(workspace: Workspace, rows: SuggestionRow[], blocks: (string[] | null)[] = []): Promise<DocSuggestion[]> {
    const people = await this.profiles(
      workspace,
      rows.flatMap((r) => [r.author, r.asked_by, r.decided_by].filter((k): k is string => !!k)),
    );
    return rows.map((r, i) => ({
      id: r.id,
      page_id: r.page_id,
      author: people.get(r.author)!,
      asked_by: r.asked_by ? (people.get(r.asked_by) ?? null) : null,
      target: JSON.parse(r.target) as DocEditTarget,
      before_markdown: r.before_markdown,
      after_markdown: r.after_markdown,
      note: r.note,
      status: r.status,
      created_at: r.created_at,
      decided_by: r.decided_by ? (people.get(r.decided_by) ?? null) : null,
      decided_at: r.decided_at,
      block_ids: blocks[i] ?? [],
    }));
  }

  /** A page's open suggestions, with the blocks each covers now; ones whose target is gone become stale. */
  private async openSuggestions(workspace: Workspace, pageId: string): Promise<DocSuggestion[]> {
    const rows = (await this.db.prepare("SELECT * FROM suggestions WHERE page_id = ? AND status = 'open' ORDER BY created_at").bind(pageId).all<SuggestionRow>()).results;
    if (!rows.length) return [];
    let blocks: (string[] | null)[] = rows.map(() => []);
    try {
      blocks = await this.room(pageId).targets(rows.map((r) => JSON.parse(r.target) as DocEditTarget));
    } catch (error) {
      console.error("docs could not place suggestions", error);
    }
    const gone = rows.filter((_, i) => blocks[i] === null);
    if (gone.length) {
      await this.db.batch(gone.map((r) => this.db.prepare("UPDATE suggestions SET status = 'stale' WHERE id = ?").bind(r.id)));
    }
    const live = rows.map((r, i) => ({ r, b: blocks[i] })).filter((x) => x.b !== null);
    return this.toSuggestions(
      workspace,
      live.map((x) => x.r),
      live.map((x) => x.b!),
    );
  }

  async suggestions(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocSuggestion[]>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    return ok(await this.openSuggestions(found.value.workspace, a.page_id));
  }

  async decideSuggestion(a: { workspace: string; suggestion_id: string; viewer: Viewer; decision: "accept" | "reject" }): Promise<Result<DocSuggestion>> {
    const row = await this.db.prepare("SELECT * FROM suggestions WHERE id = ?").bind(String(a.suggestion_id ?? "")).first<SuggestionRow>();
    if (!row) return fail("not_found", "No such suggestion.");
    const found = await this.pageFor(a.workspace, row.page_id, a.viewer, "edit");
    if (!found.ok) return found.error.code === "forbidden" ? fail("forbidden", "Only people who can edit the page can accept or reject a suggestion.") : found;
    const { workspace, page } = found.value;
    if (row.status !== "open") return fail("conflict", "That suggestion was already decided.");
    const me = this.userKey(a.viewer!);
    let status: DocSuggestion["status"] = a.decision === "accept" ? "accepted" : "rejected";
    if (a.decision === "accept") {
      const people = await this.profiles(workspace, [row.author, me]);
      const room = this.room(page.id);
      await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
      const result = await room.edit(JSON.parse(row.target) as DocEditTarget, row.after_markdown, {
        key: me,
        kind: "suggestion",
        note: `Suggested by @${people.get(row.author)!.name}, accepted by @${people.get(me)!.name}`,
        authors: [row.author, me],
      });
      if (!result.applied) status = "stale";
    }
    await this.db.prepare("UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(status, me, now(), row.id).run();
    const [after] = await this.toSuggestions(workspace, [{ ...row, status, decided_by: me, decided_at: now() }]);
    this.tell(page.id, { type: "suggestion.updated", suggestion: after! });
    if (status === "stale") return fail("conflict", "The part of the page this suggestion changes is gone, so it can't be applied.");
    return ok(after!);
  }

  async acceptAll(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocSuggestion[]>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    const rows = (await this.db.prepare("SELECT id FROM suggestions WHERE page_id = ? AND status = 'open' ORDER BY created_at").bind(a.page_id).all<{ id: string }>()).results;
    const out: DocSuggestion[] = [];
    for (const r of rows) {
      const decided = await this.decideSuggestion({ workspace: a.workspace, suggestion_id: r.id, viewer: a.viewer, decision: "accept" });
      if (decided.ok) out.push(decided.value);
    }
    return ok(out);
  }

  // ── Comments ────────────────────────────────────────────────────────────

  async thread(a: { workspace: string; page_id: string; viewer: Viewer; action: DocThreadAction }): Promise<Result<unknown>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "comment");
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    const me = this.userKey(a.viewer!);
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const result = (await room.thread(me, space.role!, a.action)) as ThreadResult;
    if (!result.ok) return fail(result.code, result.message);
    if (result.mentions?.length) this.defer(this.notifyMentioned(workspace, page, space.row, me, result.mentions, result.text ?? "", result.thread_id ?? null));
    return ok(result.value);
  }

  /** People mentioned in a comment hear of it, if they can read the page. */
  private async notifyMentioned(workspace: Workspace, page: PageRow, space: SpaceRow, author: string, mentions: string[], text: string, threadId: string | null): Promise<void> {
    if (!this.env.NOTIFY) return;
    // Comment mentions name people by username (`user:<username>`).
    const me = author.startsWith("user:") ? (this.usernames.get(author.slice(5)) ?? "").toLowerCase() : "";
    const names = [...new Set(mentions.filter((k) => k.startsWith("user:")).map((k) => k.slice(5).toLowerCase()))].filter((n) => n && n !== me);
    if (!names.length) return;
    const [spaces, people] = await Promise.all([this.allSpaces(workspace), this.profiles(workspace, [author])]);
    const s = spaces.find((x) => x.row.id === space.id);
    if (!s) return;
    await this.nameUsers(s.members.filter((m) => m.principal.startsWith("user:")).map((m) => m.principal.slice(5)));
    const teams = this.needsTeams([s]) ? await this.teamsOf(workspace) : new Map<string, Set<string>>();
    const members = await this.members(workspace);
    const who = people.get(author)!;
    const href = `${this.ref(workspace.slug, space, page).path}${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`;
    const notify = notifyClient(this.env.NOTIFY);
    await Promise.all(
      names.map(async (username) => {
        const member = members.get(username);
        if (!member) return;
        // Their id is not needed: access by username's teams and role is enough to decide.
        const person: Person = { user_id: `name:${username}`, owner: member.role === "owner", teams: teams.get(username) ?? new Set() };
        const listed = s.members.some((m) => m.principal.startsWith("user:") && this.usernames.get(m.principal.slice(5))?.toLowerCase() === username);
        if (!listed && !atLeast(roleOf(rulesOf({ ...s, role: null }), person), "view")) return;
        await notify
          .notify(
            { username },
            {
              id: `doc-comment:${page.id}:${threadId ?? ""}:${username}:${Date.now()}`,
              kind: "mention",
              workspace: workspace.slug,
              title: `${who.display_name} mentioned you on ${page.title || "Untitled"}`,
              body: text.slice(0, 140),
              href,
              actor: { kind: who.kind, id: who.id, name: who.display_name, avatar: who.avatar, avatar_seed: who.avatar_seed ?? null },
              created_at: now(),
            },
          )
          .catch(() => undefined);
      }),
    );
  }

  private async resolveThreads(workspace: Workspace, threads: Awaited<ReturnType<PageRoom["threads"]>>): Promise<DocThread[]> {
    const people = await this.profiles(
      workspace,
      threads.flatMap((t) => t.comments.map((c) => c.author)),
    );
    return threads.map((t) => ({ ...t, comments: t.comments.map((c) => ({ ...c, author: people.get(c.author)! })) }));
  }

  async threads(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<DocThread[]>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "view");
    if (!found.ok) return found;
    return ok(await this.resolveThreads(found.value.workspace, await this.room(a.page_id).threads()));
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /**
   * What an agent may read and do for `viewer`, space by space: the
   * viewer's own access, narrowed to what every person in the audience can
   * read. Never wider than the viewer.
   */
  private async agentSpaces(slug: string, agentId: string, viewer: Viewer, audience: DocAudience | null): Promise<Result<{ workspace: Workspace; agent: WorkspaceAgent; spaces: (Space & { can: DocAgentAbilities })[] }>> {
    const found = await this.viewerWorkspace(slug, viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const agent = (await this.agentsById([String(agentId ?? "")])).get(String(agentId ?? ""));
    if (!agent || agent.workspace_id !== workspace.id || agent.archived_at) return fail("not_found", "No such agent.");
    const spaces = await this.spacesFor(workspace, viewer!);
    let readable = (s: Space) => !!s.role;
    if (audience?.kind === "workspace") {
      readable = (s) => !!s.role && readableByWorkspace(rulesOf(s));
    } else if (audience?.kind === "people" && Array.isArray(audience.user_ids) && audience.user_ids.length) {
      const ids = [...new Set(audience.user_ids.map(String))].slice(0, 200);
      await this.nameUsers(ids);
      const [members, teams] = await Promise.all([this.members(workspace), this.needsTeams(spaces) ? this.teamsOf(workspace) : Promise.resolve(new Map<string, Set<string>>())]);
      const people: Person[] = ids.map((id) => {
        const username = this.usernames.get(id)?.toLowerCase() ?? "";
        const member = members.get(username);
        // Someone who is not a member reads nothing: a person with no teams who owns nothing.
        return { user_id: member ? id : `outside:${id}`, owner: member?.role === "owner", teams: teams.get(username) ?? new Set() };
      });
      readable = (s) => !!s.role && readableByAll(rulesOf(s), people);
    }
    return ok({
      workspace,
      agent,
      spaces: spaces.filter(readable).map((s) => ({ ...s, can: agentAbilities(s.role, s.row.agent_mode) })),
    });
  }

  async spacesForAgent(a: { workspace: string; agent_id: string; viewer: Viewer; audience: DocAudience | null }) {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, a.audience);
    if (!found.ok) return found;
    return ok(
      found.value.spaces.map((s) => ({
        id: s.row.id,
        slug: s.row.slug,
        name: s.row.name,
        description: s.row.description,
        kind: s.row.kind,
        agent_mode: s.row.agent_mode,
        projects: s.projects,
        can: s.can,
      })),
    );
  }

  /** A page an agent may read for the viewer and audience, or not found. */
  private async agentPage(a: { workspace: string; agent_id: string; viewer: Viewer; page_id: string; audience?: DocAudience | null }) {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, a.audience ?? null);
    if (!found.ok) return found;
    const page = await this.db
      .prepare("SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL")
      .bind(String(a.page_id ?? ""), found.value.workspace.id)
      .first<PageRow>();
    const space = page ? found.value.spaces.find((s) => s.row.id === page.space_id) : null;
    if (!page || !space) return fail("not_found", "No such page.");
    return ok({ ...found.value, page, space });
  }

  async pageMarkdown(a: { workspace: string; agent_id: string; viewer: Viewer; page_id: string; audience: DocAudience | null }): Promise<Result<DocAgentPage>> {
    const found = await this.agentPage(a);
    if (!found.ok) return found;
    const { workspace, page, space } = found.value;
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const read = await room.read();
    return ok({
      page: { ...this.ref(workspace.slug, space.row, page), updated_at: page.updated_at },
      space: { id: space.row.id, slug: space.row.slug, name: space.row.name, agent_mode: space.row.agent_mode },
      markdown: read.markdown,
      blocks: read.blocks,
      can: space.can,
    });
  }

  async searchForAgent(a: { workspace: string; agent_id: string; viewer: Viewer; query: DocSearchQuery; audience: DocAudience | null }): Promise<Result<DocSearchHit[]>> {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, a.audience);
    if (!found.ok) return found;
    return ok(await this.searchIn(found.value.workspace, found.value.spaces, { ...(a.query ?? { query: "" }), limit: Math.min(Number(a.query?.limit) || 10, 20) }));
  }

  private async fileSuggestion(
    workspace: Workspace,
    page: PageRow,
    space: SpaceRow,
    agent: WorkspaceAgent,
    viewer: User,
    edit: { target: DocEditTarget; markdown: string; note: string | null },
  ): Promise<Result<DocSuggestion>> {
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const current = await room.target(edit.target);
    if (!current) return fail("not_found", "That part of the page isn't there. Read the page again and target what is there now.");
    const id = newId("sug");
    const row: SuggestionRow = {
      id,
      page_id: page.id,
      author: principalKey({ kind: "agent", id: agent.id }),
      asked_by: this.userKey(viewer),
      target: JSON.stringify(edit.target),
      before_markdown: current.markdown,
      after_markdown: edit.markdown,
      note: edit.note,
      status: "open",
      created_at: now(),
      decided_by: null,
      decided_at: null,
    };
    await this.db
      .prepare("INSERT INTO suggestions (id, page_id, author, asked_by, target, before_markdown, after_markdown, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .bind(row.id, row.page_id, row.author, row.asked_by, row.target, row.before_markdown, row.after_markdown, row.note, row.created_at)
      .run();
    const [suggestion] = await this.toSuggestions(workspace, [row], [current.block_ids]);
    this.tell(page.id, { type: "suggestion.created", suggestion: suggestion! });
    this.defer(room.announce(row.author, agent.display_name).catch(() => undefined));
    this.defer(this.notifyOwners(workspace, page, space, suggestion!));
    return ok(suggestion!);
  }

  /** A page's owners (people) hear of a suggestion waiting for them. */
  private async notifyOwners(workspace: Workspace, page: PageRow, space: SpaceRow, suggestion: DocSuggestion): Promise<void> {
    if (!this.env.NOTIFY) return;
    const owners = (await this.db.prepare("SELECT principal FROM page_owners WHERE page_id = ?").bind(page.id).all<{ principal: string }>()).results
      .map((o) => o.principal)
      .filter((k) => k.startsWith("user:"))
      .map((k) => k.slice(5));
    if (!owners.length) return;
    const notify = notifyClient(this.env.NOTIFY);
    const href = this.ref(workspace.slug, space, page).path;
    await Promise.all(
      owners.map((id) =>
        notify
          .notify(
            { user_id: id },
            {
              id: `doc-suggestion:${suggestion.id}:${id}`,
              kind: "inbox",
              workspace: workspace.slug,
              title: `${suggestion.author.display_name} suggested a change to ${page.title || "Untitled"}`,
              body: suggestion.note ?? excerpt(suggestion.after_markdown, 140),
              href,
              actor: { kind: "agent", id: suggestion.author.id, name: suggestion.author.display_name, avatar: suggestion.author.avatar, avatar_seed: suggestion.author.avatar_seed ?? null },
              created_at: suggestion.created_at,
            },
          )
          .catch(() => undefined),
      ),
    );
  }

  private cleanEdit(edit: unknown): Result<{ target: DocEditTarget; markdown: string; note: string | null }> {
    const e = (edit ?? {}) as { target?: unknown; markdown?: unknown; note?: unknown };
    const target = cleanTarget(e.target);
    if (!target) return fail("invalid", "Say what to change: append, document, a section by its heading, or blocks by id.");
    const markdown = String(e.markdown ?? "");
    if (markdown.length > MAX_MARKDOWN) return fail("invalid", "That edit is too long.");
    if (target.kind === "append" && !markdown.trim()) return fail("invalid", "Nothing to add.");
    return ok({ target, markdown, note: e.note ? String(e.note).trim().slice(0, MAX_NOTE) || null : null });
  }

  async suggestEdit(a: { workspace: string; agent_id: string; viewer: Viewer; page_id: string; edit: unknown }): Promise<Result<DocSuggestion>> {
    const edit = this.cleanEdit(a.edit);
    if (!edit.ok) return edit;
    const found = await this.agentPage(a);
    if (!found.ok) return found;
    const { workspace, agent, page, space } = found.value;
    if (!space.can.suggest) return fail("forbidden", `${a.viewer!.username} can only read this page, so no change can be suggested for them.`);
    return this.fileSuggestion(workspace, page, space.row, agent, a.viewer!, edit.value);
  }

  async applyEdit(a: { workspace: string; agent_id: string; viewer: Viewer; page_id: string; edit: unknown }): Promise<Result<DocAgentEditResult>> {
    const edit = this.cleanEdit(a.edit);
    if (!edit.ok) return edit;
    const found = await this.agentPage(a);
    if (!found.ok) return found;
    const { workspace, agent, page, space } = found.value;
    const ref = this.ref(workspace.slug, space.row, page);
    if (!space.can.edit) {
      if (!space.can.suggest) return fail("forbidden", `${a.viewer!.username} can only read this page, so it can't be changed for them.`);
      const suggestion = await this.fileSuggestion(workspace, page, space.row, agent, a.viewer!, edit.value);
      return suggestion.ok ? ok({ mode: "suggested", suggestion: suggestion.value, page: ref }) : suggestion;
    }
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const result = await room.edit(edit.value.target, edit.value.markdown, {
      key: principalKey({ kind: "agent", id: agent.id }),
      kind: "agent",
      note: edit.value.note ? `@${agent.handle} for @${a.viewer!.username}: ${edit.value.note}` : `@${agent.handle} for @${a.viewer!.username}`,
      authors: [principalKey({ kind: "agent", id: agent.id })],
    });
    if (!result.applied) return fail("not_found", "That part of the page isn't there. Read the page again and target what is there now.");
    this.defer(room.announce(principalKey({ kind: "agent", id: agent.id }), agent.display_name).catch(() => undefined));
    return ok({ mode: "applied", version_id: result.version_id, page: ref });
  }

  async createPageAsAgent(a: {
    workspace: string;
    agent_id: string;
    viewer: Viewer;
    input: { space_id?: string | null; parent_id?: string | null; title: string; icon?: string | null; markdown: string; source?: { title: string; href: string } | null };
  }): Promise<Result<DocPageRef>> {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, null);
    if (!found.ok) return found;
    const { workspace, agent, spaces } = found.value;
    const input = a.input ?? ({} as typeof a.input);
    const space = input.space_id ? spaces.find((s) => s.row.id === input.space_id) : spaces.find((s) => s.row.is_default);
    if (!space) return fail("not_found", "No such space.");
    if (!atLeast(space.role, "edit")) return fail("forbidden", `${a.viewer!.username} can't add pages to ${space.row.name}.`);
    const title = cleanTitle(input.title);
    if (!title) return fail("invalid", "Give the page a title.");
    let markdown = String(input.markdown ?? "").slice(0, MAX_MARKDOWN);
    const source = input.source && typeof input.source.href === "string" && input.source.href.startsWith("/") ? input.source : null;
    if (source) markdown = `> [!NOTE]\n> Written up from [${String(source.title || "a conversation").replace(/[[\]]/g, "")}](${source.href}).\n\n${markdown}`;
    const parent = input.parent_id
      ? await this.db.prepare("SELECT id FROM pages WHERE id = ? AND space_id = ? AND archived_at IS NULL").bind(input.parent_id, space.row.id).first<{ id: string }>()
      : null;
    const agentKey = principalKey({ kind: "agent", id: agent.id });
    const row = await this.insertPage(workspace, space.row, agentKey, {
      parent_id: parent?.id ?? null,
      title,
      icon: cleanIcon(input.icon),
      markdown,
      owners: [this.userKey(a.viewer!)],
    });
    return ok(this.ref(workspace.slug, space.row, row));
  }

  async threadsForAgent(a: { workspace: string; agent_id: string; viewer: Viewer; page_id: string; audience: DocAudience | null }): Promise<Result<DocThread[]>> {
    const found = await this.agentPage(a);
    if (!found.ok) return found;
    return ok(await this.resolveThreads(found.value.workspace, await this.room(found.value.page.id).threads()));
  }

  // ── Sockets and files ───────────────────────────────────────────────────

  private viewerFrom(request: Request): Viewer {
    try {
      return JSON.parse(request.headers.get(DOCS_VIEWER_HEADER) ?? "null") as Viewer;
    } catch {
      return null;
    }
  }

  /**
   * `GET /live?workspace=<slug>&page=<id>`, upgraded to a WebSocket. The
   * viewer comes in DOCS_VIEWER_HEADER, set by the site after checking the
   * session; trusted only because this Worker is reachable through service
   * bindings alone. Checked like any read, then handed to the page's room
   * with the viewer's role, which the room enforces.
   */
  async live(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    const viewer = this.viewerFrom(request);
    if (!viewer?.id) return new Response("Sign in to use Docs\n", { status: 401 });
    const url = new URL(request.url);
    const slug = (url.searchParams.get("workspace") ?? "").toLowerCase();
    const found = await this.pageFor(slug, url.searchParams.get("page") ?? "", viewer, "view");
    if (!found.ok) return new Response(`${found.error.message}\n`, { status: found.error.code === "forbidden" ? 403 : 404 });
    const { workspace, page, space } = found.value;
    if (page.archived_at) return new Response("That page is in the trash\n", { status: 410 });
    const room = this.room(page.id);
    await room.ensure({ page_id: page.id, workspace_slug: workspace.slug, markdown: page.markdown });
    const key = this.userKey(viewer);
    const who: RoomMember = { page_id: page.id, workspace_slug: workspace.slug, key, member: (await this.profiles(workspace, [key])).get(key)!, role: space.role! };
    const headers = new Headers(request.headers);
    headers.delete(DOCS_VIEWER_HEADER);
    headers.set(ROOM_MEMBER_HEADER, JSON.stringify(who));
    return room.fetch(new Request(request.url, { method: "GET", headers }));
  }

  /** `PUT /files?workspace=&page=&name=`: a file for a page, from someone who can edit it. */
  async upload(request: Request): Promise<Response> {
    const viewer = this.viewerFrom(request);
    const url = new URL(request.url);
    const found = await this.pageFor((url.searchParams.get("workspace") ?? "").toLowerCase(), url.searchParams.get("page") ?? "", viewer, "edit");
    if (!found.ok) return Response.json(found);
    const bytes = Number(request.headers.get("content-length") ?? "0");
    if (!bytes || bytes > DOC_MAX_FILE_BYTES) return Response.json(fail("invalid", `Files can be up to ${DOC_MAX_FILE_BYTES / 1024 / 1024} MB.`));
    const name = safeName(url.searchParams.get("name") ?? "file");
    const contentType = servedType(request.headers.get("content-type") ?? "");
    const random = crypto.getRandomValues(new Uint8Array(32));
    const key = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
    const id = newId("fil");
    await r2FileStore(this.env.FILES).put(`docs/${key}`, request.body ?? new Uint8Array(), contentType);
    await this.db
      .prepare("INSERT INTO files (id, workspace_id, page_id, key, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, found.value.workspace.id, found.value.page.id, key, name, contentType, bytes, this.userKey(viewer!), now())
      .run();
    const file: DocFile = { id, url: `/docs-files/${key}`, name, content_type: contentType, bytes };
    return Response.json(ok(file));
  }

  /**
   * `GET /files/<key>`: a page's file, for the usercontent origin. The key
   * is 256 random bits, so knowing it is the permission, as with any
   * shared link; it is never on the site's own origin.
   */
  async file(key: string): Promise<Response> {
    const row = await this.db.prepare("SELECT name, content_type FROM files WHERE key = ?").bind(key).first<{ name: string; content_type: string }>();
    if (!row) return new Response("Not found\n", { status: 404 });
    const stored = await r2FileStore(this.env.FILES).get(`docs/${key}`);
    if (!stored) return new Response("Not found\n", { status: 404 });
    const inline = row.content_type !== "application/octet-stream";
    return new Response(stored.body, {
      headers: {
        "content-type": row.content_type,
        "content-length": String(stored.bytes),
        etag: stored.etag,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }
}

/** One RPC method's answer. */
async function answer(service: Docs, method: string, args: any): Promise<Response> {
  switch (method) {
    case "sidebar":
      return Response.json(await service.sidebar(args));
    case "home":
      return Response.json(await service.home(args));
    case "space":
      return Response.json(await service.space(args));
    case "create_space":
      return Response.json(await service.createSpace(args));
    case "update_space":
      return Response.json(await service.updateSpace(args));
    case "set_space_member":
      return Response.json(await service.setSpaceMember(args));
    case "page":
      return Response.json(await service.page(args));
    case "create_page":
      return Response.json(await service.createPage(args));
    case "update_page":
      return Response.json(await service.updatePage(args));
    case "move_page":
      return Response.json(await service.movePage(args));
    case "duplicate_page":
      return Response.json(await service.duplicatePage(args));
    case "archive_page":
      return Response.json(await service.archivePage(args));
    case "restore_page":
      return Response.json(await service.restorePage(args));
    case "delete_page":
      return Response.json(await service.deletePage(args));
    case "trash":
      return Response.json(await service.trash(args));
    case "favorite":
      return Response.json(await service.favorite(args));
    case "search":
      return Response.json(await service.search(args));
    case "versions":
      return Response.json(await service.versions(args));
    case "version":
      return Response.json(await service.version(args));
    case "restore_version":
      return Response.json(await service.restoreVersion(args));
    case "templates":
      return Response.json(await service.templates(args));
    case "save_template":
      return Response.json(await service.saveTemplate(args));
    case "delete_template":
      return Response.json(await service.deleteTemplate(args));
    case "export_page":
      return Response.json(await service.exportPage(args));
    case "export_space":
      return Response.json(await service.exportSpace(args));
    case "suggestions":
      return Response.json(await service.suggestions(args));
    case "decide_suggestion":
      return Response.json(await service.decideSuggestion(args));
    case "accept_all":
      return Response.json(await service.acceptAll(args));
    case "thread":
      return Response.json(await service.thread(args));
    case "threads":
      return Response.json(await service.threads(args));
    case "spaces_for_agent":
      return Response.json(await service.spacesForAgent(args));
    case "page_markdown":
      return Response.json(await service.pageMarkdown(args));
    case "search_for_agent":
      return Response.json(await service.searchForAgent(args));
    case "suggest_edit":
      return Response.json(await service.suggestEdit(args));
    case "apply_edit":
      return Response.json(await service.applyEdit(args));
    case "create_page_as_agent":
      return Response.json(await service.createPageAsAgent(args));
    case "threads_for_agent":
      return Response.json(await service.threadsForAgent(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const defer = (work: Promise<unknown>) => ctx.waitUntil(work);
    if (request.method === "GET" && url.pathname === "/live") return new Docs(env, defer).live(request);
    if (request.method === "PUT" && url.pathname === "/files") return new Docs(env, defer).upload(request);
    const file = /^\/files\/([0-9a-f]{64})$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && file) return new Docs(env, defer).file(file[1]!);
    const match = url.pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const service = new Docs(Object.create(env, { DB: { value: opened.db } }) as Env, defer);
    const args = (await request.json().catch(() => ({}))) as any;
    try {
      return opened.finish(await answer(service, match[1]!, args));
    } catch (error) {
      console.error("docs:", match[1], error);
      return opened.finish(Response.json(fail("conflict", "Docs couldn't do that just now. Try again.")));
    }
  },
} satisfies ExportedHandler<Env>;
