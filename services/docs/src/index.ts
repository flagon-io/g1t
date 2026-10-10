/**
 * The docs service: a workspace's spaces and pages, their live documents,
 * history, comments, agents' suggestions, templates and search
 * (docs.g1t.sh/guides/artifacts/, "Docs").
 *
 * Reached through service bindings: `POST /rpc/<method>` with snake_case
 * bodies (`docsClient` in @g1t/contracts); `GET /live` for a page's socket
 * and `PUT /files` for uploads, which the site forwards after checking the
 * session; `GET /files/<key>` for the usercontent origin to serve a file.
 *
 * Each page has a room (src/room.ts), a Durable Object that owns its Yjs
 * document. Everything that changes a page's content goes through the
 * room; this Worker decides who may ask.
 *
 * The docs service also hosts folios (Artifacts mode):
 * docs, slides, designs and dashboards, in src/folios/ with their own
 * room (FolioRoom). `/rpc/<method>` asks the folio table (src/folios/rpc.ts)
 * first, then Docs' own switch below; `/live?folio=` and
 * `PUT /files?folio=` are a folio's. Docs' pages keep working on their
 * tables until Phase 7 retires them.
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
  reposClient,
  workspaceAgentsClient,
  type DocAgentAbilities,
  type DocCitation,
  type DocDescribes,
  type DocRepoPage,
  type DocRepoSpace,
  type DocStaleChange,
  type DocStalePage,
  type DocStaleness,
  type G1tEvent,
  type Repo,
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
  type DocPassage,
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
import { cleanDescribes } from "./citations.ts";
import { publishDocEvent } from "./events.ts";
import { fileStore, safeName, servedType, type FileStoreEnv } from "./files.ts";
import { repoFileId } from "./chunks.ts";
import { adapters, ensureIndexed, forgetDocs, indexPage, indexRepoFiles, runBackfill, startBackfill, type DocsJob } from "./indexer.ts";
import { excerpt, searchText } from "./markdown.ts";
import { QueryCache, fuseRanks, pickPassages, queryKey, recallLimit, requiredSpaces, vectorQueryPlan, MEANING_FLOOR, WORDS_SCORE, type Candidate } from "./recall.ts";
import { ROOM_MEMBER_HEADER, type Origin, type PageRoom, type RoomMember } from "./room.ts";
import { indexRepoSpace, reindexRepo, type RepoSpaceRow } from "./repo-spaces.ts";
import { ftsAnyQuery, ftsQuery, inProject, projectRef, searchSpaces } from "./search.ts";
import { freeSlug, pageSlug, validSpaceSlug } from "./slugs.ts";
import { BUILTIN_TEMPLATES, builtinTemplate } from "./templates.ts";
import type { ThreadResult } from "./threads.ts";
import { onEvent } from "./staleness.ts";
import { descendants, exportPaths, lastPosition, placeBefore, wouldCycle, ancestors } from "./tree.ts";
import type { FolioRoom } from "./folios/room.ts";
import { folioHandler } from "./folios/rpc.ts";
import { Folios, purgeTrash, runReacl } from "./folios/service.ts";

export { PageRoom } from "./room.ts";
export { FolioRoom } from "./folios/room.ts";

type Env = FileStoreEnv & {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  AGENTS: ServiceBinding;
  NOTIFY?: ServiceBinding;
  /** Repositories: who may read one, what a change touched, a project's docs (src/staleness.ts, src/repo-spaces.ts). */
  REPOS?: ServiceBinding;
  /** Pull requests: what a merged one changed. */
  WORK?: ServiceBinding;
  /** The bus: `doc.page.*` events (src/events.ts). */
  EVENTS?: ServiceBinding;
  PAGES: DurableObjectNamespace<PageRoom>;
  /** Workers AI: embeds passages and queries for the semantic index (src/vectors.ts). Without it, words only. */
  AI?: Ai;
  /** The semantic index, Vectorize `g1t-docs` (src/vectors.ts, src/indexer.ts). */
  VECTORS?: Vectorize;
  /** The docs service's own events queue, also carrying its backfill jobs (`docs.index`, src/indexer.ts) and folio access jobs (`folios.reacl`). */
  JOBS?: Queue<DocsJob>;
  /** One room per folio (Artifacts mode, src/folios/room.ts). */
  FOLIOS: DurableObjectNamespace<FolioRoom>;
  /** Folios' semantic index, Vectorize `g1t-folios`; optional (words only without it). */
  FOLIO_VECTORS?: Vectorize;
};

/** Queries' embeddings, a minute per isolate (src/recall.ts). */
const queryVectors = new QueryCache();

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
  editors_can_share: number;
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
  marks_current?: number;
};

type ChangeRow = {
  page_id: string;
  repo: string;
  repo_id: string;
  commit_sha: string;
  pull_number: number | null;
  pull_title: string | null;
  paths: string;
  detected_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
};

type VersionRow = { id: string; page_id: string; created_at: string; kind: DocVersion["kind"]; authors: string; note: string | null; markdown: string; state: ArrayBuffer | null };

/** A passage as recall and search read it back (`passages`): its page's or file's title, and the page's space now. */
type PassageRow = {
  id: string;
  page_id: string | null;
  repo_file_id: string | null;
  path: string | null;
  heading: string | null;
  text: string;
  updated_at: string;
  space_id: string;
  title: string | null;
  icon: string | null;
  page_updated_at: string | null;
};

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

  private ref(slug: string, space: Pick<SpaceRow, "id" | "slug">, row: Pick<PageRow, "id" | "title" | "icon">): DocPageRef {
    const s = pageSlug(row.title, row.id);
    return { id: row.id, space_id: space.id, space_slug: space.slug, title: row.title, icon: row.icon, slug: s, path: `/${slug}/-/docs/${space.slug}/${s}` };
  }

  /** Pages as the site shows them, with owners, projects and people resolved. */
  private async toPages(workspace: Workspace, spaces: Map<string, SpaceRow>, rows: PageRow[]): Promise<DocPage[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const [owners, projects, kids, stale] = await Promise.all([
      this.db.prepare(`SELECT page_id, principal FROM page_owners WHERE page_id IN (${marks})`).bind(...ids).all<{ page_id: string; principal: string }>(),
      this.db.prepare(`SELECT page_id, repo FROM page_projects WHERE page_id IN (${marks})`).bind(...ids).all<{ page_id: string; repo: string }>(),
      this.db
        .prepare(`SELECT DISTINCT parent_id FROM pages WHERE parent_id IN (${marks}) AND archived_at IS NULL`)
        .bind(...ids)
        .all<{ parent_id: string }>(),
      this.staleIds(ids),
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
        stale: stale.has(row.id),
      };
    });
  }

  /** Of these pages, those possibly out of date. */
  private async staleIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const rows = await this.db
        .prepare(`SELECT DISTINCT page_id FROM page_changes WHERE cleared_at IS NULL AND page_id IN (${part.map(() => "?").join(",")})`)
        .bind(...part)
        .all<{ page_id: string }>();
      for (const r of rows.results) found.add(r.page_id);
    }
    return found;
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
    const repos = await this.repoSpacesFor(workspace, viewer).catch((error: unknown) => {
      console.error("docs could not list projects' docs", String(error));
      return [] as DocRepoSpace[];
    });
    if (!ids.length) return ok({ spaces: [], favorites: [], recent: [], can_create_space: true, trash_count: 0, stale_count: 0, repos });
    const marks = ids.map(() => "?").join(",");
    const [pages, favorites, recent, trash, stale] = await Promise.all([
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
      this.db
        .prepare(`SELECT DISTINCT c.page_id FROM page_changes c JOIN pages p ON p.id = c.page_id WHERE c.cleared_at IS NULL AND p.space_id IN (${marks}) AND p.archived_at IS NULL`)
        .bind(...ids)
        .all<{ page_id: string }>(),
    ]);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const ref = (r: Pick<PageRow, "id" | "space_id" | "title" | "icon">) => this.ref(workspace.slug, bySpace.get(r.space_id)!, r);
    const staleSet = new Set(stale.results.map((r) => r.page_id));
    return ok({
      spaces: spaces.map((s) => {
        const mine = pages.results.filter((p) => p.space_id === s.row.id);
        return {
          ...this.toSpace(s, mine.length),
          pages: mine.map((p): DocTreeNode => ({ id: p.id, parent_id: p.parent_id, position: p.position, title: p.title, icon: p.icon, slug: pageSlug(p.title, p.id), stale: staleSet.has(p.id) })),
        };
      }),
      favorites: favorites.results.map(ref),
      recent: recent.results.map(ref),
      can_create_space: true,
      trash_count: trash?.n ?? 0,
      stale_count: staleSet.size,
      repos,
    });
  }

  // ── A project's docs ────────────────────────────────────────────────────

  /** The repository docs shown in the workspace that the viewer can read, with the repositories as they are now. */
  private async readableRepoSpaces(workspace: Workspace, viewer: User): Promise<{ row: RepoSpaceRow; repo: Repo }[]> {
    const rows = (await this.db.prepare("SELECT * FROM repo_spaces WHERE workspace_id = ? ORDER BY repo").bind(workspace.id).all<RepoSpaceRow>()).results;
    if (!rows.length || !this.env.REPOS) return [];
    const readable = await reposClient(this.env.REPOS).readable(
      rows.map((r) => r.repo_id),
      viewer,
    );
    const byId = new Map(readable.map((r) => [r.id, r]));
    return rows.filter((r) => byId.has(r.repo_id)).map((row) => ({ row, repo: byId.get(row.repo_id)! }));
  }

  private async toRepoSpaces(workspace: Workspace, viewer: User, found: { row: RepoSpaceRow; repo: Repo }[]): Promise<DocRepoSpace[]> {
    if (!found.length) return [];
    const ids = found.map((f) => f.row.id);
    const [files, people] = await Promise.all([
      this.db
        .prepare(`SELECT space_id, path, title FROM repo_files WHERE space_id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ space_id: string; path: string; title: string }>(),
      this.profiles(
        workspace,
        found.map((f) => f.row.added_by),
      ),
    ]);
    const me = this.userKey(viewer);
    const owner = this.viewerOwner(viewer, workspace.slug);
    const readme = (path: string) => (/^readme\./i.test(path) ? 0 : 1);
    return found.map(({ row, repo }) => ({
      id: row.id,
      repo: `${repo.namespace}/${repo.name}`,
      default_branch: repo.defaultBranch,
      commit: row.commit_sha,
      indexed_at: row.indexed_at,
      added_by: people.get(row.added_by)!,
      files: files.results
        .filter((f) => f.space_id === row.id)
        .sort((a, b) => readme(a.path) - readme(b.path) || a.path.localeCompare(b.path))
        .map((f) => ({ path: f.path, title: f.title })),
      can_remove: row.added_by === me || owner,
    }));
  }

  private async repoSpacesFor(workspace: Workspace, viewer: User): Promise<DocRepoSpace[]> {
    return this.toRepoSpaces(workspace, viewer, await this.readableRepoSpaces(workspace, viewer));
  }

  async addRepoSpace(a: { workspace: string; viewer: Viewer; repo: string }): Promise<Result<DocRepoSpace>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const viewer = a.viewer!;
    if (!this.env.REPOS) return fail("conflict", "Projects' docs aren't available here.");
    const ref = projectRef(String(a.repo ?? ""));
    if (!ref) return fail("invalid", "Choose a repository: owner/name.");
    const [namespace, name] = ref.split("/") as [string, string];
    const repo = await reposClient(this.env.REPOS).get({ namespace, name }, viewer);
    if (!repo.ok) return fail("not_found", "No such repository, or you can't read it.");
    const id = newId("rds");
    const row: RepoSpaceRow = {
      id,
      workspace_id: workspace.id,
      repo_id: repo.value.id,
      repo: `${repo.value.namespace}/${repo.value.name}`.toLowerCase(),
      default_branch: repo.value.defaultBranch,
      commit_sha: null,
      indexed_at: null,
      added_by: this.userKey(viewer),
      added_at: now(),
    };
    const inserted = await this.db
      .prepare("INSERT INTO repo_spaces (id, workspace_id, repo_id, repo, default_branch, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, repo_id) DO NOTHING RETURNING id")
      .bind(row.id, row.workspace_id, row.repo_id, row.repo, row.default_branch, row.added_by, row.added_at)
      .first<{ id: string }>();
    if (!inserted) return fail("conflict", `${ref}'s docs are already in Docs.`);
    try {
      const read = await indexRepoSpace({ DB: this.db, REPOS: this.env.REPOS }, row);
      this.defer(indexRepoFiles(this.env, row.id, read.changed, read.gone));
    } catch (error) {
      console.error("docs could not read a project's docs", row.repo, String(error));
    }
    const fresh = (await this.db.prepare("SELECT * FROM repo_spaces WHERE id = ?").bind(id).first<RepoSpaceRow>()) ?? row;
    const [space] = await this.toRepoSpaces(workspace, viewer, [{ row: fresh, repo: repo.value }]);
    return ok(space!);
  }

  async removeRepoSpace(a: { workspace: string; viewer: Viewer; id: string }): Promise<Result<boolean>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const row = await this.db.prepare("SELECT * FROM repo_spaces WHERE id = ? AND workspace_id = ?").bind(String(a.id ?? ""), found.value.id).first<RepoSpaceRow>();
    if (!row) return fail("not_found", "No such project's docs.");
    if (row.added_by !== this.userKey(a.viewer!) && !this.viewerOwner(a.viewer!, a.workspace)) return fail("forbidden", "Only whoever added a project's docs, or an owner, can remove them.");
    await this.db.batch([this.db.prepare("DELETE FROM repo_files_fts WHERE space_id = ?").bind(row.id), this.db.prepare("DELETE FROM repo_spaces WHERE id = ?").bind(row.id)]);
    this.defer(forgetDocs(this.env, { space_id: row.id }));
    return ok(true);
  }

  async repoPage(a: { workspace: string; viewer: Viewer; repo: string; path: string }): Promise<Result<DocRepoPage>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const ref = projectRef(String(a.repo ?? ""));
    if (!ref) return fail("not_found", "No such file.");
    const spaces = await this.readableRepoSpaces(workspace, a.viewer!);
    const match = spaces.find((s) => `${s.repo.namespace}/${s.repo.name}`.toLowerCase() === ref || s.row.repo === ref);
    if (!match) return fail("not_found", "No such file.");
    const path = String(a.path ?? "").replace(/^\/+/, "");
    const file = await this.db.prepare("SELECT path, title, markdown FROM repo_files WHERE space_id = ? AND path = ?").bind(match.row.id, path).first<{ path: string; title: string; markdown: string }>();
    if (!file) return fail("not_found", "No such file.");
    const [space] = await this.toRepoSpaces(workspace, a.viewer!, [match]);
    const repoPath = `${match.repo.namespace}/${match.repo.name}`;
    const encoded = file.path.split("/").map(encodeURIComponent).join("/");
    return ok({
      space: space!,
      file: {
        path: file.path,
        title: file.title,
        markdown: file.markdown,
        href: `/${workspace.slug}/-/artifacts/repo/${repoPath}/${encoded}`,
        code_href: `/${repoPath}/blob/${encodeURIComponent(match.repo.defaultBranch)}/${encoded}`,
      },
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
    if (!ids.length) return ok({ recent: [], mine: [], stale: [], spaces: [], projects: [...allProjects].sort(), project });
    const marks = ids.map(() => "?").join(",");
    const [recentRows, mineRows, pageProjects, counts, staleRows] = await Promise.all([
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
      this.staleRows(ids, null, 24),
    ]);
    for (const p of pageProjects.results) allProjects.add(p.repo);
    const projectsOf = (pageId: string) => pageProjects.results.filter((p) => p.page_id === pageId).map((p) => p.repo);
    const spaceProjects = new Map(spaces.map((s) => [s.row.id, s.projects]));
    const keep = (r: PageRow) => inProject(project, projectsOf(r.id), spaceProjects.get(r.space_id) ?? []);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const [recent, mine, stale] = await Promise.all([
      this.toPages(workspace, bySpace, recentRows.results.filter(keep).slice(0, 12)),
      this.toPages(workspace, bySpace, mineRows.results.filter(keep).slice(0, 8)),
      this.toPages(workspace, bySpace, staleRows.filter(keep).slice(0, 8)),
    ]);
    const count = new Map(counts.results.map((c) => [c.space_id, c.n]));
    return ok({
      recent,
      mine,
      stale,
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
    if (c.editors_can_share !== undefined) set("editors_can_share", c.editors_can_share ? 1 : 0);
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
    const [tree, backlinks, children, favorite, viewed, suggestions, cited, staleness] = await Promise.all([
      this.db.prepare("SELECT id, space_id, parent_id, position, title, icon FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>(),
      this.db
        .prepare("SELECT p.id, p.space_id, p.title, p.icon FROM page_links l JOIN pages p ON p.id = l.from_page WHERE l.to_page = ? AND p.archived_at IS NULL LIMIT 50")
        .bind(page.id)
        .all<PageRow>(),
      this.db.prepare("SELECT id, space_id, title, icon FROM pages WHERE parent_id = ? AND archived_at IS NULL ORDER BY position").bind(page.id).all<PageRow>(),
      this.db.prepare("SELECT 1 AS yes FROM favorites WHERE user_id = ? AND page_id = ?").bind(viewer.id, page.id).first<{ yes: number }>(),
      this.db.prepare("SELECT viewed_at FROM page_views WHERE user_id = ? AND page_id = ?").bind(viewer.id, page.id).first<{ viewed_at: string }>(),
      this.openSuggestions(workspace, page.id),
      this.citationsOf([page.id]),
      this.stalenessFor(page.id, viewer),
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
      citations: cited.get(page.id) ?? [],
      describes: (cited.get(page.id) ?? []).filter((c) => c.source === "header").map((c) => ({ repo: c.repo, path: c.path })),
      staleness,
    });
  }

  // ── Citations and staleness ─────────────────────────────────────────────

  /** Each page's citations, by page. */
  private async citationsOf(pageIds: string[]): Promise<Map<string, DocCitation[]>> {
    const out = new Map<string, DocCitation[]>();
    if (!pageIds.length) return out;
    const rows = await this.db
      .prepare(`SELECT page_id, repo, path, kind, label, ref, source FROM citations WHERE page_id IN (${pageIds.map(() => "?").join(",")}) ORDER BY source DESC, repo, path`)
      .bind(...pageIds)
      .all<Omit<DocCitation, "label"> & { page_id: string; label: string }>();
    for (const r of rows.results) {
      const list = out.get(r.page_id) ?? [];
      list.push({ repo: r.repo, path: r.path, kind: r.kind, label: r.label || null, ref: r.ref, source: r.source });
      out.set(r.page_id, list);
    }
    return out;
  }

  /** Of these repositories (`owner/name`), those the viewer can read. */
  private async readableRepos(viewer: User, repos: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.env.REPOS) return out;
    const client = reposClient(this.env.REPOS);
    await Promise.all(
      [...new Set(repos)].slice(0, 25).map(async (repo) => {
        const [namespace, name] = repo.split("/") as [string, string];
        const found = await client.get({ namespace, name }, viewer).catch(() => null);
        if (found?.ok) out.add(repo);
      }),
    );
    return out;
  }

  /** Open changes on these pages, newest first. */
  private async openChanges(pageIds: string[]): Promise<ChangeRow[]> {
    if (!pageIds.length) return [];
    const out: ChangeRow[] = [];
    for (let i = 0; i < pageIds.length; i += 90) {
      const part = pageIds.slice(i, i + 90);
      const rows = await this.db
        .prepare(`SELECT * FROM page_changes WHERE cleared_at IS NULL AND page_id IN (${part.map(() => "?").join(",")}) ORDER BY detected_at DESC`)
        .bind(...part)
        .all<ChangeRow>();
      out.push(...rows.results);
    }
    return out.sort((a, b) => b.detected_at.localeCompare(a.detected_at));
  }

  /** A change as a reader sees it: named only when they can read its repository. */
  private toChange(row: ChangeRow, readable: Set<string>): DocStaleChange {
    if (!readable.has(row.repo)) return { visible: false, repo: null, commit: null, pull: null, paths: [], at: row.detected_at };
    let paths: string[] = [];
    try {
      paths = JSON.parse(row.paths) as string[];
    } catch {
      paths = [];
    }
    return {
      visible: true,
      repo: row.repo,
      commit: row.commit_sha,
      pull: row.pull_number ? { number: row.pull_number, title: row.pull_title } : null,
      paths,
      at: row.detected_at,
    };
  }

  /** Why a page is possibly out of date, as this viewer may see it; null when it isn't. */
  private async stalenessFor(pageId: string, viewer: User): Promise<DocStaleness | null> {
    const rows = await this.openChanges([pageId]);
    if (!rows.length) return null;
    const readable = await this.readableRepos(
      viewer,
      rows.map((r) => r.repo),
    );
    const changes = rows.slice(0, 20).map((r) => this.toChange(r, readable));
    return { since: rows[rows.length - 1]!.detected_at, changes };
  }

  /** Live pages in these spaces that are possibly out of date, most recently flagged first; `repo` narrows to changes there. */
  private async staleRows(spaceIds: string[], repo: string | null, limit: number): Promise<PageRow[]> {
    if (!spaceIds.length) return [];
    const marks = spaceIds.map(() => "?").join(",");
    return (
      await this.db
        .prepare(
          `SELECT p.id, p.workspace_id, p.space_id, p.parent_id, p.position, p.title, p.icon, p.cover, substr(p.markdown, 1, 600) AS markdown, p.created_by, p.created_at, p.updated_by, p.updated_at, p.archived_at, p.archived_by
           FROM pages p JOIN (SELECT page_id, MAX(detected_at) AS flagged FROM page_changes WHERE cleared_at IS NULL ${repo ? "AND repo = ?" : ""} GROUP BY page_id) c ON c.page_id = p.id
           WHERE p.space_id IN (${marks}) AND p.archived_at IS NULL ORDER BY c.flagged DESC LIMIT ?`,
        )
        .bind(...(repo ? [repo] : []), ...spaceIds, limit)
        .all<PageRow>()
    ).results;
  }

  async stalePages(a: { workspace: string; viewer: Viewer; repo?: string | null }): Promise<Result<DocPage[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const spaces = (await this.spacesFor(workspace, a.viewer!)).filter((s) => s.role);
    const rows = await this.staleRows(
      spaces.map((s) => s.row.id),
      a.repo ? projectRef(a.repo) : null,
      200,
    );
    return ok(await this.toPages(workspace, new Map(spaces.map((s) => [s.row.id, s.row])), rows));
  }

  /** Clears every open change on a page. */
  private async clearStale(pageId: string, by: string): Promise<boolean> {
    const done = await this.db.prepare("UPDATE page_changes SET cleared_at = ?, cleared_by = ? WHERE page_id = ? AND cleared_at IS NULL").bind(now(), by, pageId).run();
    const cleared = (done.meta?.changes ?? 0) > 0;
    if (cleared) this.tell(pageId, { type: "page.staleness" });
    return cleared;
  }

  async markCurrent(a: { workspace: string; page_id: string; viewer: Viewer }): Promise<Result<boolean>> {
    const found = await this.pageFor(a.workspace, a.page_id, a.viewer, "edit");
    if (!found.ok) return found;
    await this.clearStale(found.value.page.id, this.userKey(a.viewer!));
    return ok(true);
  }

  async stalePagesForAgent(a: { workspace: string; agent_id: string; viewer: Viewer; repo?: string | null; since?: string | null; audience: DocAudience | null }): Promise<Result<DocStalePage[]>> {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, a.audience);
    if (!found.ok) return found;
    const { workspace, spaces } = found.value;
    const repo = a.repo ? projectRef(a.repo) : null;
    if (a.repo && !repo) return fail("invalid", "Name the repository as owner/name.");
    const since = a.since && !Number.isNaN(Date.parse(a.since)) ? new Date(a.since).toISOString() : null;
    const rows = await this.staleRows(
      spaces.map((s) => s.row.id),
      repo,
      200,
    );
    const [changes, cited, pages] = await Promise.all([
      this.openChanges(rows.map((r) => r.id)),
      this.citationsOf(rows.map((r) => r.id)),
      this.toPages(workspace, new Map(spaces.map((s) => [s.row.id, s.row])), rows),
    ]);
    // The agent learns only of code its person can read.
    const readable = await this.readableRepos(a.viewer!, [...changes.map((c) => c.repo), ...[...cited.values()].flat().map((c) => c.repo)]);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s]));
    const out: DocStalePage[] = [];
    for (const row of rows) {
      const mine = changes.filter((c) => c.page_id === row.id && readable.has(c.repo) && (!repo || c.repo === repo));
      if (!mine.length) continue;
      const newest = mine[0]!.detected_at;
      if (since && newest < since) continue;
      const space = bySpace.get(row.space_id)!;
      const page = pages.find((p) => p.id === row.id)!;
      out.push({
        page: { ...this.ref(workspace.slug, space.row, row), updated_at: row.updated_at },
        space: { id: space.row.id, slug: space.row.slug, name: space.row.name, agent_mode: space.row.agent_mode },
        can: space.can,
        owners: page.owners,
        citations: (cited.get(row.id) ?? []).filter((c) => readable.has(c.repo)),
        changes: mine.slice(0, 20).map((c) => this.toChange(c, readable)),
        since: mine[mine.length - 1]!.detected_at,
      });
      if (out.length >= 50) break;
    }
    return ok(out);
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
    this.defer(publishDocEvent(this.env.EVENTS, "doc.page.created", this.eventData(workspace, space, row), author));
    // Its passages, for agents' recall (src/indexer.ts); later edits are indexed by its room.
    if (input.markdown.trim()) this.defer(indexPage(this.env, id));
    return row;
  }

  /** What every `doc.page.*` event says of a page. */
  private eventData(workspace: Workspace, space: Pick<SpaceRow, "id" | "slug">, row: Pick<PageRow, "id" | "title" | "icon">) {
    return { workspace: workspace.slug, workspaceId: workspace.id, pageId: row.id, spaceId: space.id, title: row.title, path: this.ref(workspace.slug, space, row).path };
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
    if (c.describes !== undefined) {
      statements.push(this.db.prepare("DELETE FROM citations WHERE page_id = ? AND source = 'header'").bind(page.id));
      for (const d of cleanDescribes(c.describes)) {
        statements.push(this.db.prepare("INSERT OR IGNORE INTO citations (page_id, repo, path, kind, label, ref, source) VALUES (?, ?, ?, 'path', '', NULL, 'header')").bind(page.id, d.repo, d.path));
      }
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
    // The title is part of what each passage is embedded with.
    if (c.title !== undefined && cleanTitle(c.title) !== page.title) this.defer(indexPage(this.env, page.id));
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
    let moved: string[] = [];
    if (target.row.id !== page.space_id) {
      // The page and everything under it move to the other space.
      const all = (await this.db.prepare("SELECT id, parent_id, position FROM pages WHERE space_id = ?").bind(page.space_id).all<PageRow>()).results;
      moved = descendants(all, page.id);
      for (const id of moved) statements.push(this.db.prepare("UPDATE pages SET space_id = ? WHERE id = ?").bind(target.row.id, id));
    }
    await this.db.batch(statements);
    // Their passages are filed under the new space (no new embeddings: they only moved).
    if (moved.length) this.defer(this.reindexPages(moved));
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
    // Out of agents' recall while in the trash; restoring indexes them again.
    this.defer(forgetDocs(this.env, { page_ids: ids }));
    this.defer(publishDocEvent(this.env.EVENTS, "doc.page.archived", this.eventData(workspace, space.row, page), this.userKey(a.viewer!)));
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
    this.defer(this.reindexPages(ids));
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
    this.defer(forgetDocs(this.env, { page_ids: ids }));
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
    const query = a.query ?? { query: "" };
    const spaces = (await this.spacesFor(workspace, a.viewer!)).filter((s) => s.role);
    const hybrid = query.mode === "hybrid" && !!ftsQuery(query.query);
    // A project's docs, when the search isn't narrowed to one of the workspace's spaces.
    const repoSpaces = query.space_id || !ftsQuery(query.query)
      ? []
      : await this.repoSpacesMatching(workspace, a.viewer!, query).catch((error: unknown) => {
          console.error("docs could not list projects' docs for search", String(error));
          return [] as { row: RepoSpaceRow; repo: Repo }[];
        });
    const [pages, files, meaning] = await Promise.all([
      this.searchIn(workspace, spaces, query),
      this.searchRepoFiles(workspace, repoSpaces, query).catch((error: unknown) => {
        console.error("docs could not search projects' docs", String(error));
        return [] as DocSearchHit[];
      }),
      hybrid
        ? this.meaningHits(workspace, spaces, repoSpaces, query).catch((error: unknown) => {
            console.error("docs could not search by meaning", String(error));
            return null;
          })
        : Promise.resolve(null),
    ]);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    // Words only: pages first, then files, as many as asked for.
    if (!hybrid) return ok([...pages, ...files].slice(0, limit));
    return ok(await this.fuseHits(workspace, spaces, repoSpaces, [...pages, ...files], meaning ?? [], query, limit));
  }

  /** The projects' docs the viewer can read, narrowed to the search's project. */
  private async repoSpacesMatching(workspace: Workspace, viewer: User, query: DocSearchQuery): Promise<{ row: RepoSpaceRow; repo: Repo }[]> {
    const spaces = await this.readableRepoSpaces(workspace, viewer);
    const project = query.project ? projectRef(query.project) : null;
    return project ? spaces.filter((s) => `${s.repo.namespace}/${s.repo.name}`.toLowerCase() === project) : spaces;
  }

  /** A search hit's key: a page's id, or `repo:<space>:<path>` for a project's docs file. */
  private hitKey(row: Pick<PassageRow, "page_id" | "space_id" | "path">): string {
    return row.page_id ?? `repo:${row.space_id}:${row.path}`;
  }

  /** By meaning: each page's or file's closest passage above the floor, closest first. */
  private async meaningHits(workspace: Workspace, spaces: Space[], repoSpaces: { row: RepoSpaceRow }[], query: DocSearchQuery): Promise<{ key: string; row: PassageRow; score: number }[]> {
    const allowed = [...searchSpaces(spaces.map((s) => s.row.id), query.space_id ?? null), ...repoSpaces.map((r) => r.row.id)];
    if (!allowed.length) return [];
    const vector = await this.queryVector(query.query);
    if (!vector) return [];
    const matches = (await this.meaningMatches(workspace.id, allowed, vector)).filter((m) => m.score >= MEANING_FLOOR);
    const rows = await this.passages(workspace.id, matches.map((m) => m.id));
    const may = new Set(allowed);
    const best = new Map<string, { key: string; row: PassageRow; score: number }>();
    for (const m of matches) {
      const row = rows.get(m.id);
      if (!row || !may.has(row.space_id)) continue;
      const key = this.hitKey(row);
      if ((best.get(key)?.score ?? -1) < m.score) best.set(key, { key, row, score: m.score });
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Hybrid search's answer: word hits and meaning hits fused by rank, each
   * with the passage that matched and its heading. Word hits get theirs
   * from the passages' full text; meaning-only hits show their passage.
   */
  private async fuseHits(
    workspace: Workspace,
    spaces: Space[],
    repoSpaces: { row: RepoSpaceRow; repo: Repo }[],
    words: DocSearchHit[],
    meaning: { key: string; row: PassageRow; score: number }[],
    query: DocSearchQuery,
    limit: number,
  ): Promise<DocSearchHit[]> {
    const order = fuseRanks(
      words.map((h) => h.id),
      meaning.map((m) => m.key),
    );
    const byWords = new Map(words.map((h) => [h.id, h]));
    const byMeaning = new Map(meaning.map((m) => [m.key, m]));
    // The passage each word hit matched in, for its heading and a closer snippet.
    const docIds = new Map(words.map((h) => [h.repo_file ? repoFileId(h.space_id, h.repo_file.path) : h.id, h.id]));
    const passageOf = new Map<string, { heading: string; snippet: string }>();
    const q = ftsQuery(query.query);
    if (q && docIds.size) {
      // The best-ranked 90, within D1's bound parameters.
      const ids = [...docIds.keys()].slice(0, 90);
      const found = await this.db
        .prepare(
          `SELECT doc_id, heading, snippet(doc_chunks_fts, 4, '[[', ']]', '…', 16) AS snippet FROM doc_chunks_fts
           WHERE doc_chunks_fts MATCH ? AND doc_id IN (${ids.map(() => "?").join(",")}) ORDER BY bm25(doc_chunks_fts, 0, 0, 0, 4.0, 1.0) LIMIT 200`,
        )
        .bind(q, ...ids)
        .all<{ doc_id: string; heading: string; snippet: string }>()
        .catch(() => ({ results: [] as { doc_id: string; heading: string; snippet: string }[] }));
      for (const r of found.results) {
        const key = docIds.get(r.doc_id);
        if (key && !passageOf.has(key)) passageOf.set(key, { heading: r.heading, snippet: r.snippet });
      }
    }
    // Meaning-only pages: their projects, for the project filter and the hit.
    const onlyMeaning = meaning.filter((m) => !byWords.has(m.key) && m.row.page_id);
    const pageIds = onlyMeaning.map((m) => m.row.page_id!);
    const projects = pageIds.length
      ? (
          await this.db
            .prepare(`SELECT page_id, repo FROM page_projects WHERE page_id IN (${pageIds.map(() => "?").join(",")})`)
            .bind(...pageIds)
            .all<{ page_id: string; repo: string }>()
        ).results
      : [];
    const project = query.project ? projectRef(query.project) : null;
    const bySpace = new Map(spaces.map((s) => [s.row.id, s]));
    const byRepo = new Map(repoSpaces.map((r) => [r.row.id, r]));
    const out: DocSearchHit[] = [];
    for (const key of order) {
      if (out.length >= limit) break;
      const w = byWords.get(key);
      const m = byMeaning.get(key);
      if (w) {
        const passage = passageOf.get(key);
        out.push({
          ...w,
          snippet: passage?.snippet || w.snippet,
          heading: (passage ? passage.heading || null : null) ?? m?.row.heading ?? null,
          matched: m ? "both" : "words",
        });
        continue;
      }
      if (!m) continue;
      const row = m.row;
      const snippet = excerpt(row.text, 200);
      if (row.page_id) {
        const space = bySpace.get(row.space_id);
        if (!space) continue;
        const own = projects.filter((p) => p.page_id === row.page_id).map((p) => p.repo);
        if (!inProject(project, own, space.projects)) continue;
        out.push({
          ...this.ref(workspace.slug, space.row, { id: row.page_id, title: row.title ?? "", icon: row.icon }),
          space_name: space.row.name,
          snippet,
          updated_at: row.page_updated_at ?? row.updated_at,
          projects: [...new Set([...own, ...space.projects])],
          heading: row.heading,
          matched: "meaning",
        });
      } else {
        const r = byRepo.get(row.space_id);
        if (!r || !row.path) continue;
        const repo = `${r.repo.namespace}/${r.repo.name}`;
        out.push({
          id: key,
          space_id: row.space_id,
          space_slug: "repo",
          title: row.title ?? row.path,
          icon: null,
          slug: row.path,
          path: `/${workspace.slug}/-/docs/repo/${repo}/${row.path.split("/").map(encodeURIComponent).join("/")}`,
          space_name: repo,
          snippet,
          updated_at: r.row.indexed_at ?? r.row.added_at,
          projects: [repo.toLowerCase()],
          repo_file: { repo, path: row.path },
          heading: row.heading,
          matched: "meaning",
        });
      }
    }
    return out;
  }

  /** Full text over these projects' docs (the viewer's to read). */
  private async searchRepoFiles(workspace: Workspace, spaces: { row: RepoSpaceRow; repo: Repo }[], query: DocSearchQuery): Promise<DocSearchHit[]> {
    const q = ftsQuery(query.query);
    if (!q) return [];
    if (!spaces.length) return [];
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const rows = (
      await this.db
        .prepare(
          `SELECT space_id, path, title, snippet(repo_files_fts, 3, '[[', ']]', '…', 16) AS snippet FROM repo_files_fts
           WHERE repo_files_fts MATCH ? AND space_id IN (${spaces.map(() => "?").join(",")}) ORDER BY bm25(repo_files_fts, 0, 0, 8.0, 1.0) LIMIT ?`,
        )
        .bind(q, ...spaces.map((s) => s.row.id), limit)
        .all<{ space_id: string; path: string; title: string; snippet: string }>()
    ).results;
    const byId = new Map(spaces.map((s) => [s.row.id, s]));
    return rows.map((r) => {
      const s = byId.get(r.space_id)!;
      const repo = `${s.repo.namespace}/${s.repo.name}`;
      return {
        id: `repo:${r.space_id}:${r.path}`,
        space_id: r.space_id,
        space_slug: "repo",
        title: r.title,
        icon: null,
        slug: r.path,
        path: `/${workspace.slug}/-/docs/repo/${repo}/${r.path.split("/").map(encodeURIComponent).join("/")}`,
        space_name: repo,
        snippet: r.snippet,
        updated_at: s.row.indexed_at ?? s.row.added_at,
        projects: [repo.toLowerCase()],
        repo_file: { repo, path: r.path },
      };
    });
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
      else if (row.marks_current) await this.clearStale(page.id, row.author);
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

  // ── Recall: the semantic index ──────────────────────────────────────────

  /** Pages indexed again one after another (moved, restored). */
  private async reindexPages(ids: string[]): Promise<void> {
    for (const id of ids.slice(0, 500)) await indexPage(this.env, id);
  }

  /** A query's embedding, kept a minute; null without an embedder or when it fails (then words only). */
  private async queryVector(query: string): Promise<number[] | null> {
    const { embedder } = adapters(this.env);
    const key = queryKey(query);
    if (!embedder || !key) return null;
    const cached = queryVectors.get(key);
    if (cached) return cached;
    try {
      const [vector] = await embedder.embed([key]);
      if (vector) queryVectors.set(key, vector);
      return vector ?? null;
    } catch (error) {
      console.error("docs could not embed a query; matching words instead", String(error));
      return null;
    }
  }

  /** The passages nearest a vector, only from `allowed` spaces (by the index's filter, or after). */
  private async meaningMatches(workspaceId: string, allowed: string[], vector: number[]): Promise<{ id: string; score: number }[]> {
    const { store } = adapters(this.env);
    const plan = vectorQueryPlan(workspaceId, allowed);
    if (!store || !plan) return [];
    try {
      return await store.query(vector, { topK: plan.topK, filter: plan.filter });
    } catch (error) {
      console.error("docs semantic query failed; matching words instead", String(error));
      return [];
    }
  }

  /** Passages by their words (any of them), best first, from `allowed` spaces. */
  private async wordMatches(workspaceId: string, allowed: string[], fts: string, limit: number): Promise<string[]> {
    if (!allowed.length) return [];
    const named = allowed.length <= 80;
    const rows = await this.db
      .prepare(
        `SELECT doc_chunks_fts.chunk_id AS id FROM doc_chunks_fts JOIN doc_chunks c ON c.id = doc_chunks_fts.chunk_id
         WHERE doc_chunks_fts MATCH ? AND c.workspace_id = ? ${named ? `AND doc_chunks_fts.space_id IN (${allowed.map(() => "?").join(",")})` : ""}
         ORDER BY bm25(doc_chunks_fts, 0, 0, 0, 4.0, 1.0) LIMIT ?`,
      )
      .bind(fts, workspaceId, ...(named ? allowed : []), limit)
      .all<{ id: string }>()
      .catch((error: unknown) => {
        console.error("docs word recall failed", String(error));
        return { results: [] as { id: string }[] };
      });
    return rows.results.map((r) => r.id);
  }

  /**
   * Passages by id as they read now, with their page or file: only those
   * whose page is still out of the trash and whose file is still there.
   * A page's passages count as in the page's space now, whatever the index says.
   */
  private async passages(workspaceId: string, ids: string[]): Promise<Map<string, PassageRow>> {
    const out = new Map<string, PassageRow>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 90) {
      const part = unique.slice(i, i + 90);
      const rows = await this.db
        .prepare(
          `SELECT c.id, c.page_id, c.repo_file_id, c.path, c.heading, c.text, c.updated_at,
                  CASE WHEN c.page_id IS NOT NULL THEN p.space_id ELSE c.space_id END AS space_id,
                  COALESCE(p.title, f.title) AS title, p.icon AS icon, p.updated_at AS page_updated_at
           FROM doc_chunks c
           LEFT JOIN pages p ON p.id = c.page_id
           LEFT JOIN repo_files f ON f.space_id = c.space_id AND f.path = c.path
           WHERE c.workspace_id = ? AND c.id IN (${part.map(() => "?").join(",")})
             AND ((c.page_id IS NOT NULL AND p.id IS NOT NULL AND p.archived_at IS NULL) OR (c.repo_file_id IS NOT NULL AND f.path IS NOT NULL))`,
        )
        .bind(workspaceId, ...part)
        .all<PassageRow>();
      for (const r of rows.results) out.set(r.id, r);
    }
    return out;
  }

  /**
   * Projects' docs an agent may recall from: those the viewer can read
   * and, with an audience, everyone in it. A workspace-wide audience, or
   * one too large to ask about person by person, gets public repositories
   * only. Never wider than the viewer.
   */
  private async repoSpacesForAudience(workspace: Workspace, viewer: User, audience: DocAudience | null): Promise<{ row: RepoSpaceRow; repo: Repo }[]> {
    const mine = await this.readableRepoSpaces(workspace, viewer);
    if (!mine.length || !audience) return mine;
    const publicOnly = () => mine.filter((s) => !s.repo.isPrivate);
    if (audience.kind === "workspace") return publicOnly();
    if (audience.kind !== "people" || !Array.isArray(audience.user_ids)) return mine;
    const others = [...new Set(audience.user_ids.map(String))].filter((id) => id !== viewer.id);
    if (!others.length) return mine;
    if (others.length > 20 || !this.env.REPOS) return publicOnly();
    await this.nameUsers(others);
    const members = await this.members(workspace);
    let keep = new Set(mine.map((s) => s.row.repo_id));
    for (const id of others) {
      const username = this.usernames.get(id)?.toLowerCase();
      if (!username) {
        const open = new Set(publicOnly().map((s) => s.row.repo_id));
        keep = new Set([...keep].filter((r) => open.has(r)));
        continue;
      }
      const member = members.get(username);
      // As repos sees them: their membership here and no direct grants, so never wider than they are.
      const person: User = { id, username, verified: true, workspaces: member ? [{ slug: workspace.slug, role: member.role }] : [] };
      const readable = await reposClient(this.env.REPOS)
        .readable([...keep], person)
        .catch(() => [] as Repo[]);
      keep = new Set(readable.map((r) => r.id));
      if (!keep.size) break;
    }
    return mine.filter((s) => keep.has(s.row.repo_id));
  }

  /**
   * What the workspace's Docs say about a query, for an agent about to
   * answer (DocsApi.recallForAgent): the closest passages by meaning above
   * MEANING_FLOOR, required spaces first, at most two per page, filled with
   * passages matching its words when meaning finds too few. Only from what
   * the viewer and audience can all read, by the same rules as every other
   * agent read (`agentSpaces`).
   */
  async recallForAgent(a: {
    workspace: string;
    agent_id: string;
    viewer: Viewer;
    query: string;
    limit?: number | null;
    spaces?: string[] | null;
    audience: DocAudience | null;
  }): Promise<Result<DocPassage[]>> {
    const found = await this.agentSpaces(a.workspace, a.agent_id, a.viewer, a.audience ?? null);
    if (!found.ok) return found;
    const { workspace, spaces } = found.value;
    this.defer(ensureIndexed(this.env, workspace.id).catch((error: unknown) => console.error("docs could not start indexing", workspace.id, String(error))));
    const query = String(a.query ?? "").trim().slice(0, 2000);
    if (!query) return ok([]);
    const limit = recallLimit(a.limit);
    const repoSpaces = await this.repoSpacesForAudience(workspace, a.viewer!, a.audience ?? null).catch((error: unknown) => {
      console.error("docs could not check projects' docs for recall", String(error));
      return [] as { row: RepoSpaceRow; repo: Repo }[];
    });
    const allowed = [...spaces.map((s) => s.row.id), ...repoSpaces.map((r) => r.row.id)];
    if (!allowed.length) return ok([]);
    const required = requiredSpaces(allowed, a.spaces);
    const fts = ftsAnyQuery(query);
    const vector = await this.queryVector(query);
    const [meaning, requiredMeaning, words] = await Promise.all([
      vector ? this.meaningMatches(workspace.id, allowed, vector) : Promise.resolve([]),
      // Required reading asked on its own too, so the rest of the workspace can't crowd it out.
      vector && required.length && required.length < allowed.length ? this.meaningMatches(workspace.id, required, vector) : Promise.resolve([]),
      fts ? this.wordMatches(workspace.id, allowed, fts, 30) : Promise.resolve([] as string[]),
    ]);
    const scores = new Map<string, number>();
    for (const m of [...meaning, ...requiredMeaning]) scores.set(m.id, Math.max(scores.get(m.id) ?? 0, m.score));
    const rows = await this.passages(workspace.id, [...scores.keys(), ...words]);
    const candidates: (Candidate & { row: PassageRow })[] = [];
    for (const [id, score] of scores) {
      const row = rows.get(id);
      if (row) candidates.push({ id, doc_id: row.page_id ?? row.repo_file_id!, space_id: row.space_id, score, by: "meaning", row });
    }
    for (const id of words) {
      const row = rows.get(id);
      if (row) candidates.push({ id, doc_id: row.page_id ?? row.repo_file_id!, space_id: row.space_id, score: WORDS_SCORE, by: "words", row });
    }
    const picked = pickPassages(candidates, { allowed: new Set(allowed), required, limit });
    const stale = await this.staleIds([...new Set(picked.map((c) => c.row.page_id).filter((id): id is string => !!id))]);
    const bySpace = new Map(spaces.map((s) => [s.row.id, s.row]));
    const byRepo = new Map(repoSpaces.map((r) => [r.row.id, r]));
    const out: DocPassage[] = [];
    for (const c of picked) {
      const row = c.row;
      const score = Math.round(c.score * 1000) / 1000;
      if (row.page_id) {
        const space = bySpace.get(row.space_id);
        if (!space) continue;
        out.push({
          page: this.ref(workspace.slug, space, { id: row.page_id, title: row.title ?? "", icon: row.icon }),
          repo_file: null,
          space_name: space.name,
          heading: row.heading,
          text: row.text,
          score,
          updated_at: row.page_updated_at ?? row.updated_at,
          stale: stale.has(row.page_id),
        });
      } else {
        const repo = byRepo.get(row.space_id);
        if (!repo || !row.path) continue;
        const name = `${repo.repo.namespace}/${repo.repo.name}`;
        out.push({
          page: null,
          repo_file: { repo: name, path: row.path, href: `/${workspace.slug}/-/docs/repo/${name}/${row.path.split("/").map(encodeURIComponent).join("/")}` },
          space_name: name,
          heading: row.heading,
          text: row.text,
          score,
          updated_at: repo.row.indexed_at ?? row.updated_at,
          stale: false,
        });
      }
    }
    return ok(out);
  }

  /** Indexes the workspace's pages and projects' docs again, on the queue. Owners only. */
  async reindexDocs(a: { workspace: string; viewer: Viewer }): Promise<Result<boolean>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    if (!this.viewerOwner(a.viewer!, a.workspace)) return fail("forbidden", "Only an owner can index the workspace's docs again.");
    return ok(await startBackfill(this.env, found.value.id, { force: true }));
  }

  private async fileSuggestion(
    workspace: Workspace,
    page: PageRow,
    space: SpaceRow,
    agent: WorkspaceAgent,
    viewer: User,
    edit: { target: DocEditTarget; markdown: string; note: string | null; marks_current: boolean },
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
      marks_current: edit.marks_current ? 1 : 0,
    };
    await this.db
      .prepare("INSERT INTO suggestions (id, page_id, author, asked_by, target, before_markdown, after_markdown, note, status, created_at, marks_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .bind(row.id, row.page_id, row.author, row.asked_by, row.target, row.before_markdown, row.after_markdown, row.note, row.created_at, row.marks_current)
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

  private cleanEdit(edit: unknown): Result<{ target: DocEditTarget; markdown: string; note: string | null; marks_current: boolean }> {
    const e = (edit ?? {}) as { target?: unknown; markdown?: unknown; note?: unknown; marks_current?: unknown };
    const target = cleanTarget(e.target);
    if (!target) return fail("invalid", "Say what to change: append, document, a section by its heading, or blocks by id.");
    const markdown = String(e.markdown ?? "");
    if (markdown.length > MAX_MARKDOWN) return fail("invalid", "That edit is too long.");
    if (target.kind === "append" && !markdown.trim()) return fail("invalid", "Nothing to add.");
    return ok({ target, markdown, note: e.note ? String(e.note).trim().slice(0, MAX_NOTE) || null : null, marks_current: e.marks_current === true });
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
    if (edit.value.marks_current) await this.clearStale(page.id, principalKey({ kind: "agent", id: agent.id }));
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
    await fileStore(this.env).put(`docs/${key}`, request.body ?? new Uint8Array(), contentType);
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
    const stored = await fileStore(this.env).get(`docs/${key}`);
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
    case "stale_pages_for_agent":
      return Response.json(await service.stalePagesForAgent(args));
    case "mark_current":
      return Response.json(await service.markCurrent(args));
    case "stale_pages":
      return Response.json(await service.stalePages(args));
    case "add_repo_space":
      return Response.json(await service.addRepoSpace(args));
    case "remove_repo_space":
      return Response.json(await service.removeRepoSpace(args));
    case "repo_page":
      return Response.json(await service.repoPage(args));
    case "recall_for_agent":
      return Response.json(await service.recallForAgent(args));
    case "reindex_docs":
      return Response.json(await service.reindexDocs(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const defer = (work: Promise<unknown>) => ctx.waitUntil(work);
    if (request.method === "GET" && url.pathname === "/live") return url.searchParams.has("folio") ? new Folios(env, defer).live(request) : new Docs(env, defer).live(request);
    if (request.method === "PUT" && url.pathname === "/files") return url.searchParams.has("folio") ? new Folios(env, defer).upload(request) : new Docs(env, defer).upload(request);
    const file = /^\/files\/([0-9a-f]{64})$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && file) return (await new Folios(env, defer).file(file[1]!)) ?? new Docs(env, defer).file(file[1]!);
    const match = url.pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const scoped = Object.create(env, { DB: { value: opened.db } }) as Env;
    const args = (await request.json().catch(() => ({}))) as any;
    try {
      // Folios first (src/folios/rpc.ts), then Docs' pages.
      const folio = folioHandler(match[1]!);
      if (folio) return opened.finish(Response.json(await folio(new Folios(scoped, defer), args)));
      const service = new Docs(scoped, defer);
      return opened.finish(await answer(service, match[1]!, args));
    } catch (error) {
      console.error("docs:", match[1], error);
      return opened.finish(Response.json(fail("conflict", "Docs couldn't do that just now. Try again.")));
    }
  },

  /**
   * Events from the events service (SUBSCRIBER_DOCS): pages whose cited
   * code changed become possibly out of date, and projects' docs are read
   * again after a push (src/staleness.ts) and their passages indexed
   * (src/indexer.ts). The same queue carries this service's own backfill
   * jobs (`docs.index`). One failing message is retried on its own.
   */
  async queue(batch: MessageBatch<G1tEvent | DocsJob>, env: Env): Promise<void> {
    const reindex = async (repoId: string) => {
      if (env.REPOS) await reindexRepo({ DB: env.DB, REPOS: env.REPOS }, repoId, (spaceId, changed, gone) => indexRepoFiles(env, spaceId, changed, gone));
    };
    for (const message of batch.messages) {
      try {
        const body = message.body;
        if (body.type === "docs.index") {
          await runBackfill(env, (body as Extract<DocsJob, { type: "docs.index" }>).workspace_id);
          message.ack();
          continue;
        }
        if (body.type === "folios.reacl") {
          await runReacl(env, (body as Extract<DocsJob, { type: "folios.reacl" }>).folio_id);
          message.ack();
          continue;
        }
        if (body.type === "repo.purged") {
          // Its docs leave Docs (src/staleness.ts); their passages leave the index first.
          const gone = await env.DB.prepare("SELECT id FROM repo_spaces WHERE repo_id = ?").bind((body as G1tEvent<"repo.purged">).data.repoId).all<{ id: string }>();
          for (const space of gone.results) await forgetDocs(env, { space_id: space.id });
        }
        await onEvent(env, body as G1tEvent, reindex);
        message.ack();
      } catch (error) {
        console.error("docs could not handle", message.body?.type, String(error));
        message.retry();
      }
    }
  },

  /** Daily (wrangler.jsonc `triggers`): folios in the trash for over 30 days are deleted for good. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      purgeTrash(env)
        .then((n) => {
          if (n) console.log("folios purged from the trash", n);
        })
        .catch((error: unknown) => console.error("folios could not purge the trash", String(error))),
    );
  },
} satisfies ExportedHandler<Env, G1tEvent | DocsJob>;
