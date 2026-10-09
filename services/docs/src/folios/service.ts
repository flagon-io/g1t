/**
 * Folios (Artifacts mode): the docs service's answers to every method in
 * FOLIO_RPC_METHODS (packages/contracts folios.ts, `foliosClient`), its
 * live socket (`GET /live?folio=`) and uploads (`PUT /files?folio=`).
 * Plan and decisions: docs/ARTIFACTS_MODE.md.
 *
 * Every read goes through one rule (src/access.ts `effectiveRole`) over
 * the folio's chain, after the list SQL's coarse filter (`folio_access`,
 * readable spaces, general access, link visits). Everything that changes
 * a folio's content goes through its room (src/folios/room.ts); this
 * class decides who may ask. Agents act for a person and never reach
 * more than that person can, narrowed to their audience
 * (src/folios/agents.ts).
 */
import {
  DOCS_VIEWER_HEADER,
  DOC_MAX_FILE_BYTES,
  FOLIO_INLINE_REACL,
  FOLIO_KIND_LABELS,
  FOLIO_MAX_SHARE,
  fail,
  folioAccessChangeError,
  folioAgentEditError,
  folioListQueryError,
  identityClient,
  isFolioKind,
  isFolioPrincipal,
  newFolioError,
  newId,
  notifyClient,
  ok,
  parsePrincipalKey,
  principalKey,
  reposClient,
  type DocAgentMode,
  type DocAudience,
  type DocCitation,
  type DocEditTarget,
  type DocRepoSpace,
  type DocRole,
  type DocSuggestion,
  type DocThread,
  type DocThreadAction,
  type Folio,
  type FolioAccessChange,
  type FolioAccessList,
  type FolioAccessRow,
  type FolioAgentEdit,
  type FolioAgentEditResult,
  type FolioAgentRead,
  type FolioChange,
  type FolioContentInput,
  type FolioKind,
  type FolioList,
  type FolioListQuery,
  type FolioMove,
  type FolioPage,
  type FolioPassage,
  type FolioProposal,
  type FolioRef,
  type FolioSearchHit,
  type FolioSuggestion,
  type FolioTemplate,
  type FolioTreeNode,
  type FolioVersion,
  type FolioVersionDetail,
  type FoliosLiveEvent,
  type FoliosSidebar,
  type FoliosSidebarSpace,
  type MemberProfile,
  type Repo,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  type Workspace,
  type WorkspaceAgent,
} from "@g1t/contracts";

import { RANK, aclChain, atLeast, canShare, explicitAccess, inheritsSpace, isPrivateFolio, isRole, personKeys, type Person, type SpaceRules } from "../access.ts";
import { diffLines } from "../diff.ts";
import { fileStore, safeName, servedType } from "../files.ts";
import { adapters, folioAdapters, forgetFolios, indexFolio, startBackfill, ensureIndexed, type DocsJob } from "../indexer.ts";
import { kindModel } from "../kinds/index.ts";
import type { FolioOrigin } from "../kinds/types.ts";
import { excerpt, searchText } from "../markdown.ts";
import { QueryCache, fuseRanks, pickPassages, queryKey, recallLimit, vectorQueryPlan, MEANING_FLOOR, WORDS_SCORE, type Candidate } from "../recall.ts";
import type { RepoSpaceRow } from "../repo-spaces.ts";
import { ROOM_MEMBER_HEADER } from "../room.ts";
import { ftsAnyQuery, ftsQuery, projectRef } from "../search.ts";
import type { ThreadResult } from "../threads.ts";
import { placeBefore } from "../tree.ts";
import { Who, now, rulesOf, userKey, type Space, type WhoEnv } from "../who.ts";
import {
  FOLIO_COLUMNS,
  aclNode,
  ancestry,
  folioColumns,
  foliosById,
  json,
  readableWhere,
  rebuildSubtree,
  rolesFrom,
  runBatches,
  subtree,
  visitsOf,
  workspaceReadable,
  type Ancestry,
  type FolioRow,
  type ReaderContext,
} from "./access-store.ts";
import { agentMayFind, agentReach, audienceRule, type AgentReach, type AudienceRule } from "./agents.ts";
import { publishFolioEvent } from "./events.ts";
import { MAX_DEPTH, cleanCover, cleanIcon, cleanNote, cleanSource, cleanTarget, cleanTitle, decodeCursor, depthOf, encodeCursor, listLimit, sharedTops, slugOf, subtreeHeight, treeNodes } from "./list.ts";
import { REQUEST_RECIPIENTS, claimAccessRequest } from "./requests.ts";
import type { FolioRoom } from "./room.ts";
import { builtinFolioTemplate, builtinFolioTemplates } from "./templates.ts";

export type FoliosEnv = WhoEnv & {
  FOLIOS: DurableObjectNamespace<FolioRoom>;
  NOTIFY?: ServiceBinding;
  EVENTS?: ServiceBinding;
  REPOS?: ServiceBinding;
  AI?: Ai;
  VECTORS?: Vectorize;
  FOLIO_VECTORS?: Vectorize;
  JOBS?: Queue<DocsJob>;
  FILES?: R2Bucket;
  DOCS_FILES?: string;
  DOCS_S3_ENDPOINT?: string;
  DOCS_S3_BUCKET?: string;
  DOCS_S3_REGION?: string;
  DOCS_S3_ACCESS_KEY_ID?: string;
  DOCS_S3_SECRET_ACCESS_KEY?: string;
  DOCS_S3_VIRTUAL_HOSTED?: string;
};

type Args = { workspace: string; viewer: Viewer };
type AgentArgs = Args & { agent_id: string; audience?: DocAudience | null };

/** The viewer in their workspace, with their spaces. */
type Ctx = { workspace: Workspace; viewer: User; key: string; person: Person; spaces: Space[]; spaceById: Map<string, Space>; owner: boolean };

/** An agent's turn: its asker's context, the agent, and who will see the answer. */
type AgentCtx = Ctx & { agent: WorkspaceAgent; agentKey: string; rule: AudienceRule; people: Person[]; audienceIds: string[] };

type SuggestionRow = {
  id: string;
  folio_id: string;
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
  marks_current: number;
};

type VersionRow = { id: string; folio_id: string; created_at: string; kind: FolioVersion["kind"]; authors: string; note: string | null; text: string; state: ArrayBuffer | null; state_key: string | null };

/** Queries' embeddings, a minute per isolate. */
const queryVectors = new QueryCache();

/** Open rooms told of an access change inline; a larger subtree's go with the queue job. */
const INLINE_ROOMS = 200;
const MAX_TEXT = 512 * 1024;

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const kindLabel = (kind: FolioKind) => FOLIO_KIND_LABELS[kind] ?? kind;

export class Folios {
  readonly who: Who;

  constructor(
    private readonly env: FoliosEnv,
    private readonly defer: (work: Promise<unknown>) => void = () => {},
  ) {
    this.who = new Who(env);
  }

  private get db() {
    return this.env.DB;
  }

  room(folioId: string) {
    return this.env.FOLIOS.get(this.env.FOLIOS.idFromName(folioId));
  }

  private tell(folioId: string, event: FoliosLiveEvent): void {
    this.defer(
      this.room(folioId)
        .notice(event)
        .catch((error: unknown) => console.error("folios could not tell a room", folioId, String(error))),
    );
  }

  /** The room, named and given its kind and (when empty) its saved text. */
  private async ready(workspace: Workspace, row: FolioRow) {
    const room = this.room(row.id);
    let text = row.text;
    if (!text) text = (await this.db.prepare("SELECT text FROM folios WHERE id = ?").bind(row.id).first<{ text: string }>())?.text ?? "";
    await room.ensure({ folio_id: row.id, kind: row.kind, workspace_slug: workspace.slug, text });
    return room;
  }

  // ── Who, where, and what they may do ────────────────────────────────────

  private async ctx(slug: string, viewer: Viewer): Promise<Result<Ctx>> {
    const found = await this.who.viewerWorkspace(slug, viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const user = viewer!;
    await this.who.ensureDefault(workspace, user);
    const person = await this.who.viewerPerson(workspace, user);
    const spaces = await this.who.spacesFor(workspace, person);
    return ok({ workspace, viewer: user, key: userKey(user), person, spaces, spaceById: new Map(spaces.map((s) => [s.row.id, s])), owner: this.who.viewerOwner(user, workspace.slug) });
  }

  private reader(ctx: Ctx, visits: ReadonlySet<string>): ReaderContext {
    return { person: ctx.person, spaceRole: (id) => ctx.spaceById.get(id)?.role ?? null, visits };
  }

  /** The viewer's role on each row, from each one's whole chain. */
  private async roles(ctx: Ctx, rows: FolioRow[], extraVisits: string[] = []): Promise<{ roles: Map<string, DocRole | null>; found: Ancestry }> {
    const [found, visits] = await Promise.all([ancestry(this.db, rows), visitsOf(this.db, ctx.viewer.id, rows)]);
    for (const id of extraVisits) visits.add(id);
    return { roles: rolesFrom(found, rows, this.reader(ctx, visits)), found };
  }

  /**
   * A folio the viewer may `need`-access, or not found when they can't
   * read it at all. `opening` counts as opening its link (the `folio`
   * read and the live socket), which is what makes a link folio readable.
   */
  private async open(ctx: Ctx, folioId: unknown, need: DocRole, options: { trashed?: boolean; opening?: boolean; text?: boolean } = {}): Promise<Result<{ row: FolioRow; role: DocRole; found: Ancestry }>> {
    const columns = options.text ? FOLIO_COLUMNS.replace("'' AS text", "text") : FOLIO_COLUMNS;
    const row = await this.db.prepare(`SELECT ${columns} FROM folios WHERE id = ? AND workspace_id = ?`).bind(String(folioId ?? ""), ctx.workspace.id).first<FolioRow>();
    if (!row) return fail("not_found", "No such artifact.");
    if (row.trashed_at && !options.trashed) return fail("not_found", "That artifact is in the trash.");
    const { roles, found } = await this.roles(ctx, [row], options.opening ? [row.id] : []);
    const role = roles.get(row.id) ?? null;
    if (!role) return fail("not_found", "No such artifact.");
    if (!atLeast(role, need)) {
      const message = need === "comment" ? "You can read this but not comment on it." : need === "manage" ? "Only people with full access can do that." : "You can read this but not change it.";
      return fail("forbidden", message);
    }
    return ok({ row, role, found });
  }

  private agentMode(row: Pick<FolioRow, "agent_mode" | "space_id">, ctx: Ctx): DocAgentMode {
    return row.agent_mode ?? (row.space_id ? ctx.spaceById.get(row.space_id)?.row.agent_mode : null) ?? "suggest";
  }

  ref(slug: string, row: Pick<FolioRow, "id" | "kind" | "title" | "icon">): FolioRef {
    const s = slugOf(row.title, row.id);
    return { id: row.id, kind: row.kind, title: row.title, icon: row.icon, slug: s, path: `/${slug}/-/artifacts/${s}` };
  }

  /** Folios as lists and pages show them, for the viewer. Rows without a role are left out. */
  private async toFolios(ctx: Ctx, rows: FolioRow[], known?: { roles: Map<string, DocRole | null>; found: Ancestry }): Promise<Folio[]> {
    if (!rows.length) return [];
    const { roles, found } = known ?? (await this.roles(ctx, rows));
    const readable = rows.filter((r) => roles.get(r.id));
    if (!readable.length) return [];
    const ids = readable.map((r) => r.id);
    const [favorites, counts, kids, stale] = await Promise.all([
      this.db.prepare("SELECT folio_id FROM folio_favorites WHERE user_id = ? AND folio_id IN (SELECT value FROM json_each(?))").bind(ctx.viewer.id, json(ids)).all<{ folio_id: string }>(),
      this.db.prepare("SELECT folio_id, COUNT(*) AS n FROM folio_grants WHERE folio_id IN (SELECT value FROM json_each(?)) GROUP BY folio_id").bind(json(ids)).all<{ folio_id: string; n: number }>(),
      this.db.prepare("SELECT DISTINCT parent_id FROM folios WHERE parent_id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL").bind(json(ids)).all<{ parent_id: string }>(),
      this.staleIds(ids),
    ]);
    const people = await this.who.profiles(
      ctx.workspace,
      readable.flatMap((r) => [r.owner, r.created_by, ...(r.edited_by ? [r.edited_by] : [])]),
    );
    const fav = new Set(favorites.results.map((f) => f.folio_id));
    const shared = new Map(counts.results.map((c) => [c.folio_id, c.n]));
    const parents = new Set(kids.results.map((k) => k.parent_id));
    return readable.map((row) => {
      const chain = aclChain(row.id, found.nodes);
      const root = chain[chain.length - 1] ?? aclNode(row);
      const space = row.space_id ? ctx.spaceById.get(row.space_id) : undefined;
      const parent = row.parent_id ? found.rows.get(row.parent_id) : undefined;
      let inherited: Folio["inherited_from"] = null;
      if (row.inherit && parent) inherited = { kind: "folio", id: parent.id, name: parent.title || "Untitled" };
      else if (row.inherit && !row.parent_id && space) inherited = { kind: "space", id: space.row.id, name: space.row.name };
      const preview = parseJson<Folio["preview"]>(row.preview, null);
      return {
        ...this.ref(ctx.workspace.slug, row),
        workspace_id: row.workspace_id,
        space: space ? { id: space.row.id, slug: space.row.slug, name: space.row.name, kind: space.row.kind } : null,
        parent_id: row.parent_id,
        position: row.position,
        owner: people.get(row.owner)!,
        created_by: people.get(row.created_by)!,
        created_at: row.created_at,
        updated_at: row.updated_at,
        edited_by: row.edited_by ? (people.get(row.edited_by) ?? null) : null,
        edited_at: row.edited_at,
        trashed_at: row.trashed_at,
        viewer_role: roles.get(row.id)!,
        favorite: fav.has(row.id),
        private: isPrivateFolio(chain, found.grants),
        shared_count: shared.get(row.id) ?? 0,
        general_access: root.general_access,
        general_role: root.general_access === "none" ? null : ((root.general_role as Folio["general_role"]) ?? "view"),
        inherit: !!row.inherit,
        inherited_from: inherited,
        agent_mode: this.agentMode(row, ctx),
        excerpt: row.excerpt,
        preview,
        source: parseJson<Folio["source"]>(row.source, null),
        stale: stale.has(row.id),
        has_children: parents.has(row.id),
      };
    });
  }

  private async staleIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db
      .prepare("SELECT DISTINCT folio_id FROM folio_changes WHERE cleared_at IS NULL AND folio_id IN (SELECT value FROM json_each(?))")
      .bind(json(ids))
      .all<{ folio_id: string }>();
    return new Set(rows.results.map((r) => r.folio_id));
  }

  private async folioOf(ctx: Ctx, row: FolioRow): Promise<Folio> {
    const fresh = (await foliosById(this.db, [row.id])).get(row.id) ?? row;
    const [folio] = await this.toFolios(ctx, [fresh]);
    return folio!;
  }

  /** The keys and spaces the list filter reads. */
  private filterOf(ctx: Ctx) {
    return readableWhere(
      personKeys(ctx.person),
      ctx.spaces.filter((s) => s.role).map((s) => s.row.id),
      ctx.viewer.id,
    );
  }

  // ── Lists ───────────────────────────────────────────────────────────────

  async list(a: Args & { query: FolioListQuery }): Promise<Result<FolioList>> {
    const query = a.query ?? ({ tab: "all" } as FolioListQuery);
    const invalid = folioListQueryError({ ...query, tab: query.tab ?? "all" });
    if (invalid) return fail("invalid", invalid);
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    return ok(await this.listFor(found.value, { ...query, tab: query.tab ?? "all" }));
  }

  private async listFor(ctx: Ctx, query: FolioListQuery): Promise<FolioList> {
    const limit = listLimit(query.limit);
    if (query.q && ftsQuery(query.q)) {
      // Words or meaning: the search's order, the list's filters.
      const hits = await this.searchFor(ctx, { q: query.q, kinds: query.kinds, space_id: query.space_id, project: query.project, owner: query.owner, mode: "hybrid", limit });
      const rows = await foliosById(
        this.db,
        hits.map((h) => h.id),
      );
      const ordered = hits.map((h) => rows.get(h.id)).filter((r): r is FolioRow => !!r && (query.tab !== "yours" || r.owner === ctx.key) && (query.tab !== "shared" || r.owner !== ctx.key));
      return { items: await this.toFolios(ctx, ordered), next_cursor: null };
    }
    const keys = personKeys(ctx.person);
    const where: string[] = ["f.workspace_id = ?", "f.trashed_at IS NULL"];
    const binds: unknown[] = [ctx.workspace.id];
    let sortKey = "f.edited_at";
    const sortBinds: unknown[] = [];
    if (query.tab === "yours") {
      where.push("f.owner = ?");
      binds.push(ctx.key);
    } else if (query.tab === "shared") {
      where.push(
        "f.owner <> ?",
        `(f.id IN (SELECT folio_id FROM folio_access WHERE principal IN (SELECT value FROM json_each(?)) AND via <> 'owner') OR (r.general_access = 'link' AND EXISTS (SELECT 1 FROM folio_visits v WHERE v.user_id = ? AND (v.folio_id = f.id OR v.folio_id = f.acl_root))))`,
      );
      binds.push(ctx.key, json(keys), ctx.viewer.id);
      sortKey = "MAX(f.edited_at, COALESCE((SELECT MAX(a.since) FROM folio_access a WHERE a.folio_id = f.id AND a.principal IN (SELECT value FROM json_each(?))), ''))";
      sortBinds.push(json(keys));
    } else {
      const filter = this.filterOf(ctx);
      where.push(filter.sql);
      binds.push(...filter.binds);
    }
    if (query.kinds?.length) {
      where.push("f.kind IN (SELECT value FROM json_each(?))");
      binds.push(json(query.kinds));
    }
    if (query.space_id === "private") where.push("f.space_id IS NULL");
    else if (query.space_id) {
      where.push("f.space_id = ?");
      binds.push(query.space_id);
    }
    if (query.owner) {
      where.push("f.owner = ?");
      binds.push(query.owner);
    }
    const project = query.project ? projectRef(query.project) : null;
    if (query.project && !project) return { items: [], next_cursor: null };
    if (project) {
      where.push("(f.id IN (SELECT folio_id FROM folio_projects WHERE repo = ?) OR f.space_id IN (SELECT space_id FROM space_projects WHERE repo = ?))");
      binds.push(project, project);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      where.push(`(${sortKey} < ? OR (${sortKey} = ? AND f.id < ?))`);
      binds.push(...sortBinds, cursor.k, ...sortBinds, cursor.k, cursor.id);
    }
    const rows = (
      await this.db
        .prepare(`SELECT ${folioColumns("f")}, ${sortKey} AS sort_key FROM folios f JOIN folios r ON r.id = f.acl_root WHERE ${where.join(" AND ")} ORDER BY sort_key DESC, f.id DESC LIMIT ?`)
        .bind(...sortBinds, ...binds, limit + 1)
        .all<FolioRow & { sort_key: string }>()
    ).results;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: await this.toFolios(ctx, page), next_cursor: rows.length > limit && last ? encodeCursor({ k: last.sort_key, id: last.id }) : null };
  }

  async sidebar(a: Args): Promise<Result<FoliosSidebar>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const joins = new Set(
      (await this.db.prepare("SELECT space_id FROM space_joins WHERE user_id = ?").bind(ctx.viewer.id).all<{ space_id: string }>()).results.map((r) => r.space_id),
    );
    // Joined open spaces (General always), team spaces of theirs, Members-only spaces they're in.
    const shown = ctx.spaces.filter((s) => s.role && !s.row.archived_at && (s.row.kind !== "workspace" || s.row.is_default || joins.has(s.row.id)));
    const keys = personKeys(ctx.person);
    const [spaceRows, privateRows, sharedRows, favoriteRows, repos, trashed] = await Promise.all([
      shown.length
        ? this.db
            .prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE workspace_id = ? AND trashed_at IS NULL AND space_id IN (SELECT value FROM json_each(?)) ORDER BY position LIMIT 5000`)
            .bind(
              ctx.workspace.id,
              json(shown.map((s) => s.row.id)),
            )
            .all<FolioRow>()
        : Promise.resolve({ results: [] as FolioRow[] }),
      // Their Private: everything under a top-level Private folio of theirs.
      this.db
        .prepare(
          `SELECT ${folioColumns("f")} FROM folios f JOIN folios t ON t.id = substr(f.path, 2, instr(substr(f.path, 2), '/') - 1)
           WHERE f.workspace_id = ? AND f.space_id IS NULL AND f.trashed_at IS NULL AND t.owner = ? ORDER BY f.position LIMIT 2000`,
        )
        .bind(ctx.workspace.id, ctx.key)
        .all<FolioRow>(),
      this.db
        .prepare(
          `SELECT ${folioColumns("f")} FROM folios f JOIN folios r ON r.id = f.acl_root
           WHERE f.workspace_id = ? AND f.trashed_at IS NULL AND f.owner <> ?
             AND (f.id IN (SELECT folio_id FROM folio_access WHERE principal IN (SELECT value FROM json_each(?)))
               OR (r.general_access = 'link' AND EXISTS (SELECT 1 FROM folio_visits v WHERE v.user_id = ? AND (v.folio_id = f.id OR v.folio_id = f.acl_root))))
           ORDER BY f.edited_at DESC LIMIT 300`,
        )
        .bind(ctx.workspace.id, ctx.key, json(keys), ctx.viewer.id)
        .all<FolioRow>(),
      this.db
        .prepare(`SELECT ${folioColumns("f")} FROM folio_favorites v JOIN folios f ON f.id = v.folio_id WHERE v.user_id = ? AND f.workspace_id = ? AND f.trashed_at IS NULL ORDER BY v.position`)
        .bind(ctx.viewer.id, ctx.workspace.id)
        .all<FolioRow>(),
      this.repoSpacesFor(ctx).catch((error: unknown) => {
        console.error("folios could not list projects' docs", String(error));
        return [] as DocRepoSpace[];
      }),
      this.trashedFor(ctx, 200),
    ]);
    const all = [...spaceRows.results, ...privateRows.results, ...sharedRows.results, ...favoriteRows.results];
    const unique = [...new Map(all.map((r) => [r.id, r])).values()];
    const { roles } = await this.roles(ctx, unique);
    const can = (r: FolioRow) => !!roles.get(r.id);
    const inSpaces = spaceRows.results.filter(can);
    const mine = privateRows.results.filter(can);
    const stale = await this.staleIds([...inSpaces, ...mine].map((r) => r.id));
    const elsewhere = new Set([...inSpaces, ...mine].map((r) => r.id));
    const spaceCounts = new Map<string, number>();
    for (const r of inSpaces) spaceCounts.set(r.space_id!, (spaceCounts.get(r.space_id!) ?? 0) + 1);
    const spaces: FoliosSidebarSpace[] = shown.map((s) => ({
      ...this.who.toSpace(s, spaceCounts.get(s.row.id) ?? 0),
      joined: s.row.kind !== "workspace" || !!s.row.is_default || joins.has(s.row.id),
      tree: treeNodes(
        inSpaces.filter((r) => r.space_id === s.row.id),
        stale,
      ),
    }));
    const ref = (r: FolioRow) => this.ref(ctx.workspace.slug, r);
    return ok({
      favorites: favoriteRows.results.filter(can).map(ref),
      spaces,
      private_tree: treeNodes(mine, stale),
      shared: sharedTops(sharedRows.results.filter(can), elsewhere).slice(0, 100).map(ref),
      repos,
      can_create_space: true,
      trash_count: trashed.length,
      stale_count: stale.size,
    });
  }

  /**
   * A folio for the viewer. Reading it opens it, which records the visit
   * that makes a link folio readable; a `peek` (chat's link card) does
   * neither, so a link folio they never opened is not found.
   */
  async folio(a: Args & { folio_id: string; peek?: boolean | null }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const peek = a.peek === true;
    const opened = await this.open(ctx, a.folio_id, "view", { trashed: !peek, opening: !peek });
    if (!opened.ok) return opened;
    if (peek) {
      const [folio] = await this.toFolios(ctx, [opened.value.row], { roles: new Map([[opened.value.row.id, opened.value.role]]), found: opened.value.found });
      return ok(folio!);
    }
    const at = now();
    this.defer(
      this.db
        .prepare("INSERT INTO folio_visits (folio_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (folio_id, user_id) DO UPDATE SET last_at = excluded.last_at")
        .bind(opened.value.row.id, ctx.viewer.id, at, at)
        .run(),
    );
    const [folio] = await this.toFolios(ctx, [opened.value.row], { roles: new Map([[opened.value.row.id, opened.value.role]]), found: opened.value.found });
    return ok(folio!);
  }

  /** The folio, and what its page shows around it: the docs above it, what is under it, what links to it, open suggestions. */
  async page(a: Args & { folio_id: string }): Promise<Result<FolioPage>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view", { trashed: true, opening: true, text: true });
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    const at = now();
    this.defer(
      this.db
        .prepare("INSERT INTO folio_visits (folio_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (folio_id, user_id) DO UPDATE SET last_at = excluded.last_at")
        .bind(row.id, ctx.viewer.id, at, at)
        .run(),
    );
    const above = row.path.split("/").filter((id) => id && id !== row.id);
    const [aboveRows, childRows, linkRows] = await Promise.all([
      foliosById(this.db, above),
      this.db.prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position LIMIT 200`).bind(row.id).all<FolioRow>(),
      this.db
        .prepare(`SELECT ${folioColumns("f")} FROM folio_links l JOIN folios f ON f.id = l.from_folio WHERE l.to_folio = ? AND f.workspace_id = ? AND f.trashed_at IS NULL LIMIT 200`)
        .bind(row.id, ctx.workspace.id)
        .all<FolioRow>(),
    ]);
    const parents = above.map((id) => aboveRows.get(id)).filter((r): r is FolioRow => !!r);
    const others = [...parents, ...childRows.results, ...linkRows.results.filter((r) => r.id !== row.id)];
    const { roles } = await this.roles(ctx, others);
    const readable = (list: FolioRow[]) => list.filter((r) => roles.get(r.id)).map((r) => this.ref(ctx.workspace.slug, r));
    const [folio] = await this.toFolios(ctx, [row], { roles: new Map([[row.id, role]]), found: opened.value.found });
    return ok({
      folio: folio!,
      text: row.text,
      breadcrumbs: readable(parents),
      children: readable(childRows.results),
      backlinks: readable(linkRows.results.filter((r) => r.id !== row.id)),
      suggestions: row.kind === "doc" ? await this.openSuggestions(ctx, row) : [],
    });
  }

  // ── Making and changing ─────────────────────────────────────────────────

  /** Where a new folio may go for this person: a parent doc they can edit, a space they can edit, or their Private. */
  private async placeFor(ctx: Ctx, input: { space_id?: string | null; parent_id?: string | null }): Promise<Result<{ space_id: string | null; parent: FolioRow | null }>> {
    if (input.parent_id) {
      const parent = await this.open(ctx, input.parent_id, "edit");
      if (!parent.ok) return parent.error.code === "forbidden" ? fail("forbidden", "You can read that doc but not add to it.") : fail("not_found", "No such doc to put it under.");
      if (parent.value.row.kind !== "doc") return fail("invalid", "Only a doc can hold other artifacts.");
      if (depthOf(parent.value.row.path) >= MAX_DEPTH) return fail("invalid", `Artifacts go at most ${MAX_DEPTH} deep.`);
      return ok({ space_id: parent.value.row.space_id, parent: parent.value.row });
    }
    if (input.space_id) {
      const space = ctx.spaceById.get(input.space_id);
      if (!space?.role || space.row.archived_at) return fail("not_found", "No such space.");
      if (!atLeast(space.role, "edit")) return fail("forbidden", `You can read ${space.row.name} but not add to it.`);
      return ok({ space_id: space.row.id, parent: null });
    }
    return ok({ space_id: null, parent: null });
  }

  /** Where a new folio starts: a template's or the given content, and its title and icon. */
  private async startingPoint(ctx: Ctx, kind: FolioKind, input: { title?: string | null; icon?: string | null; template_id?: string | null; content?: FolioContentInput | null }): Promise<Result<{ text: string; spec: unknown; title: string; icon: string | null }>> {
    let text = "";
    let spec: unknown = undefined;
    let title = cleanTitle(input.title);
    let icon = cleanIcon(input.icon);
    if (input.template_id) {
      const template = builtinFolioTemplate(input.template_id) ?? (await this.savedTemplate(ctx.workspace, input.template_id));
      if (!template) return fail("not_found", "No such template.");
      if (template.kind !== kind) return fail("invalid", `That template is for ${kindLabel(template.kind)}, not ${kindLabel(kind)}.`);
      if (kind === "doc" || kind === "slides") text = template.body;
      else spec = parseJson(template.body, null);
      if (!title) title = template.name;
      if (!icon) icon = template.icon;
    } else if (input.content) {
      if ("markdown" in input.content) text = String(input.content.markdown ?? "").slice(0, MAX_TEXT);
      else spec = input.content.spec;
    }
    return ok({ text, spec, title, icon });
  }

  /** Whether a member key may be shared with: a member, an agent or a team of this workspace. */
  private async principalExists(ctx: Ctx, principal: string): Promise<boolean> {
    const p = parsePrincipalKey(principal);
    if (principal.startsWith("team:")) {
      const slug = principal.slice(5).toLowerCase();
      return [...(await this.who.teamsOf(ctx.workspace)).values()].some((set) => set.has(slug));
    }
    if (!p) return false;
    if (p.kind === "agent") {
      const agent = (await this.who.agentsById([p.id])).get(p.id);
      return !!agent && agent.workspace_id === ctx.workspace.id && !agent.archived_at;
    }
    await this.who.nameUsers([p.id]);
    const username = this.who.usernames.get(p.id);
    return !!username && (await this.who.members(ctx.workspace)).has(username.toLowerCase());
  }

  /** Inserts a folio and fills its room. */
  private async insertFolio(
    ctx: Ctx,
    input: {
      kind: FolioKind;
      owner: string;
      created_by: string;
      space_id: string | null;
      parent: FolioRow | null;
      title: string;
      icon: string | null;
      text: string;
      spec?: unknown;
      state?: Uint8Array | null;
      inherit?: boolean;
      source?: { title: string; href: string } | null;
      grants?: { principal: string; role: DocRole }[];
      position?: number;
    },
  ): Promise<FolioRow> {
    const id = newId("fol");
    const at = now();
    const siblings = input.parent
      ? await this.db.prepare("SELECT MAX(position) AS p FROM folios WHERE parent_id = ?").bind(input.parent.id).first<{ p: number | null }>()
      : input.space_id
        ? await this.db.prepare("SELECT MAX(position) AS p FROM folios WHERE space_id = ? AND parent_id IS NULL").bind(input.space_id).first<{ p: number | null }>()
        : await this.db.prepare("SELECT MAX(position) AS p FROM folios WHERE workspace_id = ? AND space_id IS NULL AND parent_id IS NULL AND owner = ?").bind(ctx.workspace.id, input.owner).first<{ p: number | null }>();
    const position = input.position ?? (siblings?.p ?? 0) + 1024;
    const inherit = input.inherit ?? true;
    const aclRoot = !inherit || !input.parent ? id : input.parent.acl_root;
    const path = input.parent ? `${input.parent.path}${id}/` : `/${id}/`;
    const row: FolioRow = {
      id,
      workspace_id: ctx.workspace.id,
      kind: input.kind,
      title: input.title,
      icon: input.icon,
      cover: null,
      owner: input.owner,
      space_id: input.space_id,
      parent_id: input.parent?.id ?? null,
      position,
      inherit: inherit ? 1 : 0,
      acl_root: aclRoot,
      path,
      general_access: "none",
      general_role: null,
      agent_mode: null,
      text: input.text,
      excerpt: excerpt(input.text),
      preview: null,
      source: input.source ? JSON.stringify(input.source) : null,
      mentioned: "[]",
      created_by: input.created_by,
      created_at: at,
      updated_by: input.created_by,
      updated_at: at,
      edited_by: input.created_by,
      edited_at: at,
      trashed_at: null,
      trashed_by: null,
    };
    const grants = (input.grants ?? []).filter((g) => g.principal !== input.owner);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO folios (id, workspace_id, kind, title, icon, owner, space_id, parent_id, position, inherit, acl_root, path, text, excerpt, source, created_by, created_at, updated_by, updated_at, edited_by, edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, row.workspace_id, row.kind, row.title, row.icon, row.owner, row.space_id, row.parent_id, position, row.inherit, aclRoot, path, row.text, row.excerpt, row.source, row.created_by, at, row.created_by, at, row.created_by, at),
      this.db.prepare("INSERT INTO folios_fts (folio_id, kind, title, body) VALUES (?, ?, ?, ?)").bind(id, row.kind, row.title, searchText(row.text)),
      this.db.prepare("INSERT INTO folio_versions (id, folio_id, created_at, kind, authors, note, text, state) VALUES (?, ?, ?, 'created', ?, NULL, ?, NULL)").bind(newId("ver"), id, at, JSON.stringify([input.created_by]), row.text),
      ...grants.map((g) => this.db.prepare("INSERT OR REPLACE INTO folio_grants (folio_id, principal, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)").bind(id, g.principal, g.role, input.created_by, at)),
    ]);
    await rebuildSubtree(this.db, id);
    const room = this.room(id);
    await room.ensure({ folio_id: id, kind: row.kind, workspace_slug: ctx.workspace.slug, text: input.text, spec: input.spec, state: input.state ?? null });
    // The rendition the room makes of it, its card, links and citations, now.
    await room.flush();
    const open = await workspaceReadable(this.db, id).catch(() => false);
    this.defer(
      publishFolioEvent(this.env.EVENTS, "folio.created", { workspace: ctx.workspace.slug, workspaceId: ctx.workspace.id, folioId: id, kind: row.kind, spaceId: row.space_id, title: open ? row.title : null }, input.created_by),
    );
    this.defer(indexFolio(this.env, id));
    return (await foliosById(this.db, [id])).get(id) ?? row;
  }

  /** Grants asked for at creation: people, agents and teams of this workspace, never above `edit` for teams' sake of sense. */
  private async cleanShares(ctx: Ctx, share: { principal: string; role: DocRole }[] | null | undefined): Promise<Result<{ principal: string; role: DocRole }[]>> {
    const out: { principal: string; role: DocRole }[] = [];
    for (const s of (share ?? []).slice(0, FOLIO_MAX_SHARE)) {
      const principal = s.principal.startsWith("team:") ? `team:${s.principal.slice(5).toLowerCase()}` : s.principal;
      if (!(await this.principalExists(ctx, principal))) return fail("invalid", `${s.principal} isn't a member, agent or team of this workspace.`);
      out.push({ principal, role: s.role });
    }
    return ok(out);
  }

  async create(a: Args & { input: Parameters<typeof newFolioError>[0] }): Promise<Result<Folio>> {
    const input = a.input ?? ({ kind: "doc" } as Parameters<typeof newFolioError>[0]);
    const invalid = newFolioError(input);
    if (invalid) return fail("invalid", invalid);
    if (!kindModel(input.kind)) return fail("invalid", `${kindLabel(input.kind)} aren't here yet.`);
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const place = await this.placeFor(ctx, input);
    if (!place.ok) return place;
    const start = await this.startingPoint(ctx, input.kind, input);
    if (!start.ok) return start;
    const shares = await this.cleanShares(ctx, input.share_with);
    if (!shares.ok) return shares;
    const row = await this.insertFolio(ctx, {
      kind: input.kind,
      owner: ctx.key,
      created_by: ctx.key,
      space_id: place.value.space_id,
      parent: place.value.parent,
      title: start.value.title,
      icon: start.value.icon,
      text: start.value.text,
      spec: start.value.spec,
      source: cleanSource(input.source),
      grants: shares.value,
    });
    return ok(await this.folioOf(ctx, row));
  }

  async update(a: Args & { folio_id: string; change: FolioChange }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "edit");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    const c = a.change ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];
    const statements: D1PreparedStatement[] = [];
    if (c.title !== undefined) {
      sets.push("title = ?");
      values.push(cleanTitle(c.title));
      statements.push(this.db.prepare("UPDATE folios_fts SET title = ? WHERE folio_id = ?").bind(cleanTitle(c.title), row.id));
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
      values.push(now(), ctx.key);
      statements.unshift(this.db.prepare(`UPDATE folios SET ${sets.join(", ")} WHERE id = ?`).bind(...values, row.id));
    }
    if (c.projects !== undefined) {
      statements.push(this.db.prepare("DELETE FROM folio_projects WHERE folio_id = ?").bind(row.id));
      const projects = [...new Set((Array.isArray(c.projects) ? c.projects : []).map((p) => projectRef(String(p))).filter((p): p is string => !!p))].slice(0, 20);
      for (const repo of projects) statements.push(this.db.prepare("INSERT INTO folio_projects (folio_id, repo) VALUES (?, ?)").bind(row.id, repo));
    }
    if (statements.length) await this.db.batch(statements);
    const folio = await this.folioOf(ctx, row);
    this.tell(row.id, { type: "folio.updated", folio });
    if (c.title !== undefined && cleanTitle(c.title) !== row.title) this.defer(indexFolio(this.env, row.id));
    return ok(folio);
  }

  async move(a: Args & { folio_id: string; move: FolioMove }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "edit");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    const move = a.move ?? ({ space_id: null, parent_id: null } as FolioMove);
    let spaceId: string | null;
    let parent: FolioRow | null = null;
    if (move.parent_id) {
      const target = await this.open(ctx, move.parent_id, "edit");
      if (!target.ok) return target.error.code === "forbidden" ? fail("forbidden", "You can read that doc but not add to it.") : fail("not_found", "No such doc to put it under.");
      parent = target.value.row;
      if (parent.kind !== "doc") return fail("invalid", "Only a doc can hold other artifacts.");
      if (parent.path.startsWith(row.path)) return fail("invalid", "An artifact can't go inside itself.");
      spaceId = parent.space_id;
    } else if (move.space_id) {
      const space = ctx.spaceById.get(move.space_id);
      if (!space?.role || space.row.archived_at) return fail("not_found", "No such space.");
      if (!atLeast(space.role, "edit")) return fail("forbidden", `You can't add to ${space.row.name}.`);
      spaceId = space.row.id;
    } else {
      // Private is its owner's: only they put something at its top.
      if (row.owner !== ctx.key) return fail("forbidden", "Only its owner can move it to their Private section.");
      spaceId = null;
    }
    const below = await subtree(this.db, row);
    if (depthOf(parent?.path ?? "") + 1 + subtreeHeight(row, below) > MAX_DEPTH) return fail("invalid", `Artifacts go at most ${MAX_DEPTH} deep.`);
    const siblings = (
      parent
        ? await this.db.prepare("SELECT id, parent_id, position FROM folios WHERE parent_id = ? AND trashed_at IS NULL").bind(parent.id).all<{ id: string; parent_id: string | null; position: number }>()
        : spaceId
          ? await this.db.prepare("SELECT id, parent_id, position FROM folios WHERE space_id = ? AND parent_id IS NULL AND trashed_at IS NULL").bind(spaceId).all<{ id: string; parent_id: string | null; position: number }>()
          : await this.db
              .prepare("SELECT id, parent_id, position FROM folios WHERE workspace_id = ? AND space_id IS NULL AND parent_id IS NULL AND owner = ? AND trashed_at IS NULL")
              .bind(ctx.workspace.id, row.owner)
              .all<{ id: string; parent_id: string | null; position: number }>()
    ).results;
    const placed = placeBefore(siblings, row.id, parent?.id ?? null, move.before_id ?? null);
    const statements: D1PreparedStatement[] = [
      this.db.prepare("UPDATE folios SET parent_id = ?, space_id = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(parent?.id ?? null, spaceId, placed.position, now(), ctx.key, row.id),
    ];
    for (const [id, position] of placed.renumber) statements.push(this.db.prepare("UPDATE folios SET position = ? WHERE id = ?").bind(position, id));
    await this.db.batch(statements);
    await this.afterAccessChange(ctx, row.id, below.length);
    const folio = await this.folioOf(ctx, row);
    this.tell(row.id, { type: "folio.updated", folio });
    return ok(folio);
  }

  /**
   * After a move or a sharing change: the subtree's places and
   * `folio_access` rebuilt, open rooms told of their people's new roles,
   * and passages filed under their new scope. A subtree past
   * FOLIO_INLINE_REACL goes to the queue (`folios.reacl`).
   */
  private async afterAccessChange(ctx: Ctx | null, rootId: string, size: number): Promise<void> {
    if (size > FOLIO_INLINE_REACL && this.env.JOBS) {
      await this.env.JOBS.send({ type: "folios.reacl", folio_id: rootId });
      return;
    }
    const ids = await rebuildSubtree(this.db, rootId);
    this.defer(this.followAccess(ctx?.workspace ?? null, ids));
  }

  /** Open rooms in these folios re-check each socket's person; the index files their passages under their scope now. */
  async followAccess(workspace: Workspace | null, ids: string[]): Promise<void> {
    try {
      const rows = [...(await foliosById(this.db, ids)).values()];
      if (!rows.length) return;
      const ws = workspace ?? (await this.workspaceById(rows[0]!.workspace_id));
      if (ws) {
        for (const row of rows.slice(0, INLINE_ROOMS)) {
          const room = this.room(row.id);
          const members = await room.members().catch(() => [] as { key: string; name: string }[]);
          if (members.length) {
            for (const m of members) {
              const role = await this.roleOfPerson(ws, row, m.key, m.name);
              await room.setRole(m.key, role).catch(() => undefined);
            }
            await room.notice({ type: "folio.access" }).catch(() => undefined);
          }
        }
      }
      for (const row of rows.slice(0, 2000)) await indexFolio(this.env, row.id);
    } catch (error) {
      console.error("folios could not follow an access change", String(error));
    }
  }

  private async workspaceById(id: string): Promise<Workspace | null> {
    const names = await identityClient(this.env.IDENTITY)
      .usernames([id])
      .catch(() => ({}) as Record<string, string>);
    return names[id] ? this.who.workspace(names[id]!) : null;
  }

  /** Someone's role on a folio, by their member key and username (for open sockets and mentions). */
  private async roleOfPerson(workspace: Workspace, row: FolioRow, key: string, username: string): Promise<DocRole | null> {
    if (!key.startsWith("user:")) return null;
    const userId = key.slice(5);
    const member = (await this.who.members(workspace)).get(username.toLowerCase());
    if (!member) return null;
    const person = await this.who.personOf(workspace, { id: userId, username }, member.role === "owner");
    const spaces = await this.who.spacesFor(workspace, person);
    const byId = new Map(spaces.map((s) => [s.row.id, s]));
    const [found, visits] = await Promise.all([ancestry(this.db, [row]), visitsOf(this.db, userId, [row])]);
    return rolesFrom(found, [row], { person, spaceRole: (id) => byId.get(id)?.role ?? null, visits }).get(row.id) ?? null;
  }

  async duplicate(a: Args & { folio_id: string }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    if (!kindModel(row.kind)) return fail("invalid", `${kindLabel(row.kind)} aren't here yet.`);
    // Beside the original where they may add, else in their Private. Never shared wider than the original: no grants, no general access.
    let space: string | null = null;
    let parent: FolioRow | null = null;
    if (row.parent_id) {
      const p = await this.open(ctx, row.parent_id, "edit");
      if (p.ok) {
        parent = p.value.row;
        space = parent.space_id;
      }
    } else if (row.space_id && atLeast(ctx.spaceById.get(row.space_id)?.role, "edit")) space = row.space_id;
    const besides = !!parent || !!space;
    const room = await this.ready(ctx.workspace, row);
    const state = await room.state();
    const text = await room.text();
    const copy = await this.insertFolio(ctx, {
      kind: row.kind,
      owner: ctx.key,
      created_by: ctx.key,
      space_id: space,
      parent,
      title: cleanTitle(`${row.title || "Untitled"} (copy)`),
      icon: row.icon,
      text,
      state,
      inherit: besides ? !!row.inherit : true,
      position: besides ? row.position + 0.5 : undefined,
    });
    return ok(await this.folioOf(ctx, copy));
  }

  async trash(a: Args & { folio_id: string }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "edit");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    const ids = (await subtree(this.db, row)).filter((r) => !r.trashed_at).map((r) => r.id);
    const at = now();
    await runBatches(
      this.db,
      ids.map((id) => this.db.prepare("UPDATE folios SET trashed_at = ?, trashed_by = ? WHERE id = ? AND trashed_at IS NULL").bind(at, ctx.key, id)),
    );
    for (const id of ids.slice(0, INLINE_ROOMS)) this.defer(this.room(id).closeAll("Moved to the trash").catch(() => undefined));
    this.defer(forgetFolios(this.env, ids));
    const open = await workspaceReadable(this.db, row.id).catch(() => false);
    this.defer(publishFolioEvent(this.env.EVENTS, "folio.trashed", { workspace: ctx.workspace.slug, workspaceId: ctx.workspace.id, folioId: row.id, kind: row.kind, spaceId: row.space_id, title: open ? row.title : null }, ctx.key));
    const [folio] = await this.toFolios(ctx, [{ ...row, trashed_at: at, trashed_by: ctx.key }]);
    return ok(folio!);
  }

  async restore(a: Args & { folio_id: string }): Promise<Result<Folio>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "edit", { trashed: true });
    if (!opened.ok) return opened;
    const { row } = opened.value;
    if (!row.trashed_at) return fail("invalid", "That artifact isn't in the trash.");
    const below = await subtree(this.db, row);
    const ids = below.filter((r) => r.trashed_at === row.trashed_at).map((r) => r.id);
    const parent = row.parent_id ? (await foliosById(this.db, [row.parent_id])).get(row.parent_id) : null;
    const statements = ids.map((id) => this.db.prepare("UPDATE folios SET trashed_at = NULL, trashed_by = NULL WHERE id = ?").bind(id));
    // Its parent is gone or still in the trash: it comes back at the top of where it was.
    const detach = !!row.parent_id && (!parent || !!parent.trashed_at);
    if (detach) statements.push(this.db.prepare("UPDATE folios SET parent_id = NULL WHERE id = ?").bind(row.id));
    await runBatches(this.db, statements);
    if (detach) await this.afterAccessChange(ctx, row.id, below.length);
    else this.defer((async () => { for (const id of ids.slice(0, 2000)) await indexFolio(this.env, id); })());
    const open = await workspaceReadable(this.db, row.id).catch(() => false);
    this.defer(publishFolioEvent(this.env.EVENTS, "folio.restored", { workspace: ctx.workspace.slug, workspaceId: ctx.workspace.id, folioId: row.id, kind: row.kind, spaceId: row.space_id, title: open ? row.title : null }, ctx.key));
    return ok(await this.folioOf(ctx, row));
  }

  async delete(a: Args & { folio_id: string }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "manage", { trashed: true });
    if (!opened.ok) return opened;
    const { row } = opened.value;
    if (!row.trashed_at) return fail("invalid", "Move it to the trash first.");
    // Deepest first, so no parent goes before its children.
    const ids = (await subtree(this.db, row)).sort((x, y) => y.path.length - x.path.length).map((r) => r.id);
    await forgetFolios(this.env, ids);
    await runBatches(
      this.db,
      ids.flatMap((id) => [this.db.prepare("DELETE FROM folios_fts WHERE folio_id = ?").bind(id), this.db.prepare("DELETE FROM folios WHERE id = ?").bind(id)]),
    );
    for (const id of ids.slice(0, INLINE_ROOMS)) this.defer(this.room(id).destroy().catch(() => undefined));
    return ok(true);
  }

  /** Trashed folios the viewer may restore: the tops of what went to the trash together. */
  private async trashedFor(ctx: Ctx, limit: number): Promise<FolioRow[]> {
    const filter = this.filterOf(ctx);
    const rows = (
      await this.db
        .prepare(`SELECT ${folioColumns("f")} FROM folios f JOIN folios r ON r.id = f.acl_root WHERE f.workspace_id = ? AND f.trashed_at IS NOT NULL AND ${filter.sql} ORDER BY f.trashed_at DESC LIMIT ?`)
        .bind(ctx.workspace.id, ...filter.binds, limit * 2)
        .all<FolioRow>()
    ).results;
    const { roles } = await this.roles(ctx, rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.filter((r) => atLeast(roles.get(r.id), "edit") && !(r.parent_id && byId.get(r.parent_id)?.trashed_at === r.trashed_at)).slice(0, limit);
  }

  async trashed(a: Args): Promise<Result<Folio[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    return ok(await this.toFolios(found.value, await this.trashedFor(found.value, 200)));
  }

  async favorite(a: Args & { folio_id: string; on: boolean }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    if (a.on) {
      await this.db
        .prepare("INSERT OR IGNORE INTO folio_favorites (user_id, folio_id, position, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1024 FROM folio_favorites WHERE user_id = ?), ?)")
        .bind(ctx.viewer.id, opened.value.row.id, ctx.viewer.id, now())
        .run();
    } else {
      await this.db.prepare("DELETE FROM folio_favorites WHERE user_id = ? AND folio_id = ?").bind(ctx.viewer.id, opened.value.row.id).run();
    }
    return ok(!!a.on);
  }

  // ── Content in the agent form, for a person or their token ──────────────

  private spaceOf(ctx: Ctx, row: FolioRow): FolioAgentRead["space"] {
    const space = row.space_id ? ctx.spaceById.get(row.space_id) : undefined;
    return space ? { id: space.row.id, slug: space.row.slug, name: space.row.name, agent_mode: space.row.agent_mode } : null;
  }

  async content(a: Args & { folio_id: string }): Promise<Result<FolioAgentRead>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    if (!kindModel(row.kind)) return fail("invalid", `${kindLabel(row.kind)} aren't here yet.`);
    const read = await (await this.ready(ctx.workspace, row)).read();
    return ok({
      folio: { ...this.ref(ctx.workspace.slug, row), edited_at: row.edited_at },
      space: this.spaceOf(ctx, row),
      content: read.content,
      ...(read.blocks ? { blocks: read.blocks } : {}),
      can: { read: true, suggest: atLeast(role, "comment"), edit: atLeast(role, "edit") },
      audience_can_read: true,
    });
  }

  /** What is wrong with an edit for this folio, or null. */
  private editError(row: FolioRow, edit: unknown): string | null {
    const invalid = folioAgentEditError(edit);
    if (invalid) return invalid;
    const e = edit as FolioAgentEdit;
    if (e.kind !== row.kind) return `This is ${kindLabel(row.kind)}, and the edit is for ${kindLabel(e.kind)}.`;
    if (e.kind === "doc" && !cleanTarget(e.target)) return "Say what to change: append, document, a section by its heading, or blocks by id.";
    if (e.kind === "doc" && e.markdown.length > MAX_TEXT) return "That edit is too long.";
    if (e.kind === "doc" && e.target.kind === "append" && !e.markdown.trim()) return "Nothing to add.";
    return null;
  }

  async edit(a: Args & { folio_id: string; edit: FolioAgentEdit }): Promise<Result<FolioAgentEditResult>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "comment");
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    const invalid = this.editError(row, a.edit);
    if (invalid) return fail("invalid", invalid);
    const edit = a.edit;
    const ref = this.ref(ctx.workspace.slug, row);
    if (atLeast(role, "edit") && !edit.suggest_only) {
      const room = await this.ready(ctx.workspace, row);
      const result = await room.edit(edit, { key: ctx.key, kind: "edit", note: cleanNote(edit.note), authors: [ctx.key] });
      if (!result.applied) return fail("not_found", `${result.summary} Read it again and target what is there now.`);
      if (edit.marks_current) await this.clearStale(row.id, ctx.key);
      return ok({ mode: "applied", version_id: result.version_id, folio: ref, summary: result.summary });
    }
    if (edit.kind !== "doc") return fail("forbidden", `Suggesting changes to ${kindLabel(row.kind)} comes with proposals, which aren't here yet.`);
    const suggestion = await this.fileSuggestion(ctx, row, { author: ctx.key, asked_by: null, agentName: null }, { target: cleanTarget(edit.target)!, markdown: edit.markdown, note: cleanNote(edit.note), marks_current: edit.marks_current === true });
    return suggestion.ok ? ok({ mode: "suggested", suggestion: suggestion.value, folio: ref }) : suggestion;
  }

  // ── Sharing ─────────────────────────────────────────────────────────────

  private async accessList(ctx: Ctx, row: FolioRow, role: DocRole, found: Ancestry): Promise<FolioAccessList> {
    const chain = aclChain(row.id, found.nodes);
    const root = chain[chain.length - 1] ?? aclNode(row);
    const entries = explicitAccess(chain, found.grants);
    const keys = [...entries.keys()];
    const people = await this.who.profiles(
      ctx.workspace,
      keys.filter((k) => !k.startsWith("team:")),
    );
    const rows: FolioAccessRow[] = [];
    for (const [principal, entry] of entries) {
      if (principal === row.owner && entry.via === "owner") continue;
      const via = entry.via === row.id ? null : found.rows.get(entry.via);
      const source: FolioAccessRow["source"] = entry.via === row.id ? { kind: "grant" } : via ? { kind: "folio", id: via.id, title: via.title || "Untitled", path: this.ref(ctx.workspace.slug, via).path } : { kind: "grant" };
      const profile: FolioAccessRow["profile"] = principal.startsWith("team:")
        ? { kind: "team", id: principal.slice(5), name: principal.slice(5), display_name: `@${ctx.workspace.slug}/${principal.slice(5)}` }
        : people.get(principal)!;
      rows.push({ principal, profile, role: entry.role, source });
    }
    rows.sort((x, y) => RANK[y.role] - RANK[x.role] || x.profile.display_name.localeCompare(y.profile.display_name));
    const owner = (await this.who.profiles(ctx.workspace, [row.owner])).get(row.owner)!;
    const space = row.space_id ? ctx.spaceById.get(row.space_id) : undefined;
    const parent = row.parent_id ? found.rows.get(row.parent_id) : undefined;
    let inherited: FolioAccessList["inherited_from"] = null;
    if (row.inherit && parent) inherited = { kind: "folio", id: parent.id, name: parent.title || "Untitled" };
    else if (row.inherit && !row.parent_id && space) inherited = { kind: "space", id: space.row.id, name: space.row.name };
    return {
      folio_id: row.id,
      owner,
      rows,
      general_access: root.general_access,
      general_role: root.general_access === "none" ? null : ((root.general_role as FolioAccessList["general_role"]) ?? "view"),
      inherit: !!row.inherit,
      inherited_from: inherited,
      agent_mode: row.agent_mode,
      can_share: canShare(role, this.editorsShare(ctx, row)),
      public_link: "off",
    };
  }

  /** Whether the folio's space lets people with edit access share what is in it. */
  private editorsShare(ctx: Ctx, row: Pick<FolioRow, "space_id">): boolean {
    return !!(row.space_id && ctx.spaceById.get(row.space_id)?.row.editors_can_share);
  }

  async access(a: Args & { folio_id: string }): Promise<Result<FolioAccessList>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    return ok(await this.accessList(ctx, opened.value.row, opened.value.role, opened.value.found));
  }

  /** After any sharing change: the rows, the rooms, the index, and the share dialog again. */
  private async afterShare(ctx: Ctx, row: FolioRow): Promise<FolioAccessList> {
    const below = await subtree(this.db, row);
    await this.afterAccessChange(ctx, row.id, below.length);
    const again = await this.open(ctx, row.id, "view", { trashed: true });
    if (!again.ok) {
      // They shared themselves out of it.
      return { folio_id: row.id, owner: (await this.who.profiles(ctx.workspace, [row.owner])).get(row.owner)!, rows: [], general_access: "none", general_role: null, inherit: !!row.inherit, inherited_from: null, agent_mode: null, can_share: false, public_link: "off" };
    }
    return this.accessList(ctx, again.value.row, again.value.role, again.value.found);
  }

  async setGrant(a: Args & { folio_id: string; change: FolioAccessChange }): Promise<Result<FolioAccessList>> {
    const change = a.change;
    if (!change || (change.op !== "grant" && change.op !== "revoke")) return fail("invalid", "Grants and revokes only; other changes go to set_folio_general_access.");
    const invalid = folioAccessChangeError(change);
    if (invalid) return fail("invalid", invalid);
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    if (!canShare(role, this.editorsShare(ctx, row))) return fail("forbidden", "Only people with full access can share it.");
    // Editors whose space lets them share give up to edit; full access stays with managers.
    if (role !== "manage" && change.op === "grant" && change.role === "manage") return fail("forbidden", "Only people with full access can give full access.");
    const principal = change.principal.startsWith("team:") ? `team:${change.principal.slice(5).toLowerCase()}` : change.principal;
    if (principal === row.owner) return fail("invalid", "Its owner always has full access.");
    if (role !== "manage") {
      const held = await this.db.prepare("SELECT role FROM folio_grants WHERE folio_id = ? AND principal = ?").bind(row.id, principal).first<{ role: DocRole }>();
      if (held?.role === "manage") return fail("forbidden", "Only people with full access can change someone else's full access.");
    }
    if (change.op === "revoke") {
      await this.db.prepare("DELETE FROM folio_grants WHERE folio_id = ? AND principal = ?").bind(row.id, principal).run();
      return ok(await this.afterShare(ctx, row));
    }
    if (!(await this.principalExists(ctx, principal))) return fail("invalid", "Share with a member, an agent or a team of this workspace.");
    await this.db
      .prepare("INSERT INTO folio_grants (folio_id, principal, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (folio_id, principal) DO UPDATE SET role = excluded.role")
      .bind(row.id, principal, change.role, ctx.key, now())
      .run();
    const list = await this.afterShare(ctx, row);
    const open = await workspaceReadable(this.db, row.id).catch(() => false);
    this.defer(
      publishFolioEvent(
        this.env.EVENTS,
        "folio.shared",
        { workspace: ctx.workspace.slug, workspaceId: ctx.workspace.id, folioId: row.id, kind: row.kind, spaceId: row.space_id, title: open ? row.title : null, principals: [principal], role: change.role },
        ctx.key,
      ),
    );
    if (principal.startsWith("user:")) this.defer(this.notifyShared(ctx, row, principal.slice(5), change.role, cleanNote(change.notify)));
    return ok(list);
  }

  /** The person shared with hears of it (they can read it now, so its title may go). */
  private async notifyShared(ctx: Ctx, row: FolioRow, userId: string, role: DocRole, message: string | null): Promise<void> {
    if (!this.env.NOTIFY || userId === ctx.viewer.id) return;
    const me = (await this.who.profiles(ctx.workspace, [ctx.key])).get(ctx.key)!;
    const verb = role === "view" ? "view" : role === "comment" ? "comment on" : "edit";
    await notifyClient(this.env.NOTIFY)
      .notify(
        { user_id: userId },
        {
          id: `folio-shared:${row.id}:${userId}:${Date.now()}`,
          kind: "inbox",
          workspace: ctx.workspace.slug,
          title: `${me.display_name} shared ${row.title || "Untitled"} with you`,
          body: message ?? `You can ${verb} it.`,
          href: this.ref(ctx.workspace.slug, row).path,
          actor: { kind: "user", id: ctx.viewer.id, name: me.display_name, avatar: me.avatar, avatar_seed: null },
          created_at: now(),
        },
      )
      .catch(() => undefined);
  }

  async setGeneralAccess(a: Args & { folio_id: string; change: FolioAccessChange }): Promise<Result<FolioAccessList>> {
    const change = a.change;
    if (!change || change.op === "grant" || change.op === "revoke") return fail("invalid", "Grants and revokes go to set_folio_grant.");
    const invalid = folioAccessChangeError(change);
    if (invalid) return fail("invalid", invalid);
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    if (!canShare(role)) return fail("forbidden", "Only people with full access can change who can open it.");
    const at = now();
    if (change.op === "general") {
      if (row.inherit && row.parent_id) {
        const parent = opened.value.found.rows.get(row.parent_id);
        return fail("invalid", `It follows ${parent?.title || "the doc it's in"}. Change it there, or choose "Only people invited" first.`);
      }
      await this.db
        .prepare("UPDATE folios SET general_access = ?, general_role = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .bind(change.access, change.access === "none" ? null : change.role, at, ctx.key, row.id)
        .run();
    } else if (change.op === "inherit") {
      if (!row.parent_id && !row.space_id) return fail("invalid", "It's in Private, so there is nothing for it to follow.");
      if (change.inherit && !row.inherit) {
        // Following again: its own general access gives way to what it follows.
        await this.db.prepare("UPDATE folios SET inherit = 1, general_access = CASE WHEN parent_id IS NULL THEN general_access ELSE 'none' END, general_role = CASE WHEN parent_id IS NULL THEN general_role ELSE NULL END, updated_at = ?, updated_by = ? WHERE id = ?").bind(at, ctx.key, row.id).run();
      } else if (!change.inherit && row.inherit) {
        await this.db.prepare("UPDATE folios SET inherit = 0, updated_at = ?, updated_by = ? WHERE id = ?").bind(at, ctx.key, row.id).run();
      }
    } else if (change.op === "agent_mode") {
      await this.db.prepare("UPDATE folios SET agent_mode = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(change.agent_mode, at, ctx.key, row.id).run();
      const again = await this.open(ctx, row.id, "view");
      if (!again.ok) return again;
      this.tell(row.id, { type: "folio.access" });
      return ok(await this.accessList(ctx, again.value.row, again.value.role, again.value.found));
    }
    return ok(await this.afterShare(ctx, row));
  }

  async requestAccess(a: Args & { folio_id: string; message?: string | null }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const row = await this.db.prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE id = ? AND workspace_id = ? AND trashed_at IS NULL`).bind(String(a.folio_id ?? ""), ctx.workspace.id).first<FolioRow>();
    if (!row) return fail("not_found", "No such artifact.");
    const { roles } = await this.roles(ctx, [row]);
    if (roles.get(row.id)) return ok(true);
    if (!this.env.NOTIFY) return ok(true);
    if (!(await claimAccessRequest(this.db, row.id, ctx.viewer.id))) return fail("conflict", "You already asked for access to this in the last day. Its owner has your request; you can ask again tomorrow.");
    // The owner and anyone with full access through a grant hear of it.
    const managers = (
      await this.db.prepare("SELECT principal FROM folio_access WHERE folio_id = ? AND role = 'manage' AND principal LIKE 'user:%'").bind(row.id).all<{ principal: string }>()
    ).results.map((r) => r.principal.slice(5));
    const me = (await this.who.profiles(ctx.workspace, [ctx.key])).get(ctx.key)!;
    const message = cleanNote(a.message);
    const notify = notifyClient(this.env.NOTIFY);
    await Promise.all(
      [...new Set([row.owner.slice(5), ...managers])].slice(0, REQUEST_RECIPIENTS).map((id) =>
        notify
          .notify(
            { user_id: id },
            {
              id: `folio-request:${row.id}:${ctx.viewer.id}:${id}`,
              kind: "inbox",
              workspace: ctx.workspace.slug,
              title: `${me.display_name} asks for access to ${row.title || "Untitled"}`,
              body: message ?? "Open it and choose Share to let them in.",
              href: this.ref(ctx.workspace.slug, row).path,
              actor: { kind: "user", id: ctx.viewer.id, name: me.display_name, avatar: me.avatar, avatar_seed: null },
              created_at: now(),
            },
          )
          .catch(() => undefined),
      ),
    );
    return ok(true);
  }

  async joinSpace(a: Args & { space_id: string }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const space = ctx.spaceById.get(String(a.space_id ?? ""));
    if (!space?.role || space.row.archived_at) return fail("not_found", "No such space.");
    if (space.row.kind !== "workspace") return fail("invalid", "Only open spaces are joined; you're in team and members-only spaces already.");
    await this.db
      .prepare("INSERT OR IGNORE INTO space_joins (space_id, user_id, position, joined_at) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1024 FROM space_joins WHERE user_id = ?), ?)")
      .bind(space.row.id, ctx.viewer.id, ctx.viewer.id, now())
      .run();
    return ok(true);
  }

  async leaveSpace(a: Args & { space_id: string }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    await this.db.prepare("DELETE FROM space_joins WHERE space_id = ? AND user_id = ?").bind(String(a.space_id ?? ""), found.value.viewer.id).run();
    return ok(true);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async search(a: Args & { query: { q: string; kinds?: FolioKind[] | null; space_id?: string | null; project?: string | null; owner?: string | null; mode?: "words" | "hybrid" | null; limit?: number | null } }): Promise<Result<FolioSearchHit[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    return ok(await this.searchFor(found.value, a.query ?? { q: "" }));
  }

  /** Words over titles and text (folios_fts), and by meaning over passages when asked; only folios the viewer can read now. */
  private async searchFor(
    ctx: Ctx,
    query: { q: string; kinds?: FolioKind[] | null; space_id?: string | null; project?: string | null; owner?: string | null; mode?: "words" | "hybrid" | null; limit?: number | null },
    narrow?: (rows: FolioRow[]) => Promise<Set<string>>,
  ): Promise<FolioSearchHit[]> {
    const q = ftsQuery(String(query.q ?? ""));
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
    const filter = this.filterOf(ctx);
    const where: string[] = ["f.workspace_id = ?", "f.trashed_at IS NULL", filter.sql];
    const binds: unknown[] = [ctx.workspace.id, ...filter.binds];
    if (query.kinds?.length) {
      where.push("f.kind IN (SELECT value FROM json_each(?))");
      binds.push(json(query.kinds.filter(isFolioKind)));
    }
    if (query.space_id === "private") where.push("f.space_id IS NULL");
    else if (query.space_id) {
      where.push("f.space_id = ?");
      binds.push(query.space_id);
    }
    if (query.owner) {
      where.push("f.owner = ?");
      binds.push(query.owner);
    }
    const project = query.project ? projectRef(query.project) : null;
    if (project) {
      where.push("(f.id IN (SELECT folio_id FROM folio_projects WHERE repo = ?) OR f.space_id IN (SELECT space_id FROM space_projects WHERE repo = ?))");
      binds.push(project, project);
    }
    type Hit = FolioRow & { snippet: string };
    const words: Hit[] = q
      ? (
          await this.db
            .prepare(
              `SELECT ${folioColumns("f")}, snippet(folios_fts, 3, '[[', ']]', '…', 16) AS snippet FROM folios_fts JOIN folios f ON f.id = folios_fts.folio_id JOIN folios r ON r.id = f.acl_root
               WHERE folios_fts MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(folios_fts, 0, 0, 8.0, 1.0) LIMIT ?`,
            )
            .bind(q, ...binds, limit * 3)
            .all<Hit>()
        ).results
      : (await this.db.prepare(`SELECT ${folioColumns("f")}, f.excerpt AS snippet FROM folios f JOIN folios r ON r.id = f.acl_root WHERE ${where.join(" AND ")} ORDER BY f.edited_at DESC LIMIT ?`).bind(...binds, limit * 3).all<Hit>()).results;
    // Meaning: passages near the query from scopes the viewer may read, each one checked again below.
    let meaning: { folio_id: string; heading: string | null; text: string; score: number }[] = [];
    if (q && query.mode === "hybrid") {
      meaning = await this.meaningPassages(ctx, String(query.q), (await this.allowedScopes(ctx)).scopes).catch((error: unknown) => {
        console.error("folios could not search by meaning", String(error));
        return [];
      });
      meaning = meaning.filter((m) => m.score >= MEANING_FLOOR);
    }
    const extra = meaning.length ? await foliosById(this.db, meaning.map((m) => m.folio_id)) : new Map<string, FolioRow>();
    const candidates = [...new Map([...words.map((w) => [w.id, w as FolioRow] as const), ...[...extra.values()].filter((r) => r.workspace_id === ctx.workspace.id && !r.trashed_at).map((r) => [r.id, r] as const)]).values()];
    const { roles } = await this.roles(ctx, candidates);
    let readable = new Set(candidates.filter((r) => roles.get(r.id)).map((r) => r.id));
    if (narrow) {
      const allowed = await narrow(candidates.filter((r) => readable.has(r.id)));
      readable = new Set([...readable].filter((id) => allowed.has(id)));
    }
    // Meaning-only hits still have to match the filters.
    const fits = (r: FolioRow) => (!query.kinds?.length || query.kinds.includes(r.kind)) && (!query.space_id || (query.space_id === "private" ? !r.space_id : r.space_id === query.space_id)) && (!query.owner || r.owner === query.owner);
    const byWords = new Map(words.filter((w) => readable.has(w.id)).map((w) => [w.id, w]));
    const bestMeaning = new Map<string, (typeof meaning)[number]>();
    for (const m of meaning) {
      const r = extra.get(m.folio_id);
      if (!r || !readable.has(r.id) || !fits(r) || (project && !byWords.has(r.id))) continue;
      if ((bestMeaning.get(m.folio_id)?.score ?? -1) < m.score) bestMeaning.set(m.folio_id, m);
    }
    const order = query.mode === "hybrid" ? fuseRanks([...byWords.keys()], [...bestMeaning.values()].sort((x, y) => y.score - x.score).map((m) => m.folio_id)) : [...byWords.keys()];
    const spaceName = (id: string | null) => (id ? (ctx.spaceById.get(id)?.row.name ?? null) : null);
    const out: FolioSearchHit[] = [];
    for (const id of order) {
      if (out.length >= limit) break;
      const w = byWords.get(id);
      const m = bestMeaning.get(id);
      const row = w ?? extra.get(id);
      if (!row) continue;
      out.push({
        ...this.ref(ctx.workspace.slug, row),
        space_name: spaceName(row.space_id),
        snippet: w ? (q ? w.snippet : excerpt(w.snippet, 140)) : excerpt(m!.text, 200),
        edited_at: row.edited_at,
        heading: m?.heading ?? null,
        matched: query.mode === "hybrid" ? (w && m ? "both" : w ? "words" : "meaning") : null,
      });
    }
    return out;
  }

  /**
   * The scopes the viewer may recall from (src/access.ts `folioScope`):
   * their readable spaces, and the access roots of folios shared with
   * them, open to the workspace, or whose link they opened. Every hit is
   * still checked against the folio itself.
   */
  private async allowedScopes(ctx: Ctx): Promise<{ scopes: string[] }> {
    const keys = personKeys(ctx.person);
    const [shared, general, visited] = await Promise.all([
      this.db
        .prepare("SELECT DISTINCT f.acl_root AS id FROM folio_access a JOIN folios f ON f.id = a.folio_id WHERE a.principal IN (SELECT value FROM json_each(?)) AND f.workspace_id = ? AND f.trashed_at IS NULL LIMIT 2000")
        .bind(json(keys), ctx.workspace.id)
        .all<{ id: string }>(),
      this.db.prepare("SELECT id FROM folios WHERE workspace_id = ? AND id = acl_root AND general_access = 'workspace' AND trashed_at IS NULL LIMIT 2000").bind(ctx.workspace.id).all<{ id: string }>(),
      this.db
        .prepare("SELECT DISTINCT f.acl_root AS id FROM folio_visits v JOIN folios f ON f.id = v.folio_id WHERE v.user_id = ? AND f.workspace_id = ? AND f.trashed_at IS NULL LIMIT 2000")
        .bind(ctx.viewer.id, ctx.workspace.id)
        .all<{ id: string }>(),
    ]);
    const scopes = new Set<string>(ctx.spaces.filter((s) => s.role).map((s) => `space:${s.row.id}`));
    for (const r of [...shared.results, ...general.results, ...visited.results]) scopes.add(`folio:${r.id}`);
    return { scopes: [...scopes] };
  }

  private async queryVector(query: string, embedder: { embed(texts: string[]): Promise<number[][]> } | null): Promise<number[] | null> {
    const key = queryKey(query);
    if (!embedder || !key) return null;
    const cached = queryVectors.get(key);
    if (cached) return cached;
    try {
      const [vector] = await embedder.embed([key]);
      if (vector) queryVectors.set(key, vector);
      return vector ?? null;
    } catch (error) {
      console.error("folios could not embed a query; matching words instead", String(error));
      return null;
    }
  }

  /** Folio passages nearest the query, from these scopes (by the index's filter, or after). Empty without an index. */
  private async meaningPassages(ctx: Ctx, query: string, scopes: string[], kinds?: FolioKind[] | null): Promise<{ id: string; folio_id: string; heading: string | null; text: string; score: number }[]> {
    const { embedder, store } = folioAdapters(this.env);
    const plan = vectorQueryPlan(ctx.workspace.id, scopes);
    if (!store || !plan) return [];
    const vector = await this.queryVector(query, embedder);
    if (!vector) return [];
    let matches: { id: string; score: number }[] = [];
    try {
      matches = await store.query(vector, { topK: plan.topK, filter: { workspace_id: ctx.workspace.id, ...(plan.filter.space_ids ? { scopes: plan.filter.space_ids } : {}) } });
    } catch (error) {
      console.error("folios semantic query failed; matching words instead", String(error));
      return [];
    }
    if (!matches.length) return [];
    const allowed = new Set(scopes);
    const rows = (
      await this.db
        .prepare("SELECT id, folio_id, kind, scope, heading, text FROM folio_chunks WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))")
        .bind(
          ctx.workspace.id,
          json(matches.map((m) => m.id)),
        )
        .all<{ id: string; folio_id: string; kind: FolioKind; scope: string; heading: string | null; text: string }>()
    ).results;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return matches
      .map((m) => ({ m, r: byId.get(m.id) }))
      .filter((x): x is { m: { id: string; score: number }; r: (typeof rows)[number] } => !!x.r && allowed.has(x.r.scope) && (!kinds?.length || kinds.includes(x.r.kind)))
      .map(({ m, r }) => ({ id: r.id, folio_id: r.folio_id, heading: r.heading, text: r.text, score: m.score }));
  }

  // ── History ─────────────────────────────────────────────────────────────

  private async toVersions(workspace: Workspace, rows: Pick<VersionRow, "id" | "folio_id" | "created_at" | "kind" | "authors" | "note">[]): Promise<FolioVersion[]> {
    const authors = rows.map((r) => parseJson<string[]>(r.authors, []));
    const people = await this.who.profiles(workspace, authors.flat());
    return rows.map((r, i) => ({ id: r.id, folio_id: r.folio_id, created_at: r.created_at, kind: r.kind, note: r.note, authors: authors[i]!.map((k) => people.get(k)!).filter(Boolean) }));
  }

  async versions(a: Args & { folio_id: string }): Promise<Result<FolioVersion[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    await this.room(opened.value.row.id)
      .flush()
      .catch(() => undefined);
    const rows = (
      await this.db.prepare("SELECT id, folio_id, created_at, kind, authors, note FROM folio_versions WHERE folio_id = ? ORDER BY created_at DESC LIMIT 200").bind(opened.value.row.id).all<VersionRow>()
    ).results;
    return ok(await this.toVersions(ctx.workspace, rows));
  }

  async version(a: Args & { folio_id: string; version_id: string }): Promise<Result<FolioVersionDetail>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const row = await this.db.prepare("SELECT id, folio_id, created_at, kind, authors, note, text FROM folio_versions WHERE id = ? AND folio_id = ?").bind(String(a.version_id ?? ""), opened.value.row.id).first<VersionRow>();
    if (!row) return fail("not_found", "No such version.");
    const before = await this.db.prepare("SELECT text FROM folio_versions WHERE folio_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1").bind(row.folio_id, row.created_at).first<{ text: string }>();
    const [version] = await this.toVersions(ctx.workspace, [row]);
    return ok({ ...version!, text: row.text, diff: diffLines(before?.text ?? "", row.text) });
  }

  async restoreVersion(a: Args & { folio_id: string; version_id: string }): Promise<Result<FolioVersion>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "edit");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    const version = await this.db.prepare("SELECT * FROM folio_versions WHERE id = ? AND folio_id = ?").bind(String(a.version_id ?? ""), row.id).first<VersionRow>();
    if (!version) return fail("not_found", "No such version.");
    let state: Uint8Array | null = version.state ? new Uint8Array(version.state) : null;
    if (!state && version.state_key) {
      const stored = await fileStore(this.env)
        .get(version.state_key)
        .catch(() => null);
      if (stored) state = new Uint8Array(await new Response(stored.body).arrayBuffer());
    }
    const room = await this.ready(ctx.workspace, row);
    const when = new Date(version.created_at).toISOString().slice(0, 16).replace("T", " ");
    const origin: FolioOrigin = { key: ctx.key, kind: "restore", note: `Restored the version of ${when} UTC` };
    const versionId = await room.restore({ state, text: version.text }, origin);
    const created = versionId ? await this.db.prepare("SELECT id, folio_id, created_at, kind, authors, note FROM folio_versions WHERE id = ?").bind(versionId).first<VersionRow>() : null;
    if (!created) return fail("conflict", "It could not be restored. Try again.");
    const [v] = await this.toVersions(ctx.workspace, [created]);
    this.tell(row.id, { type: "version.created", version: v! });
    return ok(v!);
  }

  // ── Templates and export ────────────────────────────────────────────────

  private async savedTemplate(workspace: Workspace, id: string): Promise<FolioTemplate | null> {
    const row = await this.db
      .prepare("SELECT * FROM folio_templates WHERE id = ? AND workspace_id = ?")
      .bind(id, workspace.id)
      .first<{ id: string; kind: FolioKind; name: string; description: string; icon: string | null; body: string; created_by: string }>();
    if (!row) return null;
    const by = (await this.who.profiles(workspace, [row.created_by])).get(row.created_by) ?? null;
    return { id: row.id, kind: row.kind, name: row.name, description: row.description, icon: row.icon, builtin: false, body: row.body, created_by: by };
  }

  async templates(a: Args & { kind?: FolioKind | null }): Promise<Result<FolioTemplate[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const kind = a.kind && isFolioKind(a.kind) ? a.kind : null;
    const rows = (
      await this.db
        .prepare(`SELECT * FROM folio_templates WHERE workspace_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY name COLLATE NOCASE`)
        .bind(ctx.workspace.id, ...(kind ? [kind] : []))
        .all<{ id: string; kind: FolioKind; name: string; description: string; icon: string | null; body: string; created_by: string }>()
    ).results;
    const people = await this.who.profiles(
      ctx.workspace,
      rows.map((r) => r.created_by),
    );
    return ok([
      ...builtinFolioTemplates(kind),
      ...rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, description: r.description, icon: r.icon, builtin: false, body: r.body, created_by: people.get(r.created_by) ?? null })),
    ]);
  }

  async saveTemplate(a: Args & { input: { folio_id: string; name: string; description?: string | null } }): Promise<Result<FolioTemplate>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.input?.folio_id, "view");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    const name = cleanTitle(a.input.name || row.title, 80);
    if (!name) return fail("invalid", "Name the template.");
    const body = await (await this.ready(ctx.workspace, row)).text();
    const id = newId("tpl");
    const description = cleanTitle(a.input.description ?? "", 200);
    await this.db
      .prepare("INSERT INTO folio_templates (id, workspace_id, kind, name, description, icon, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ctx.workspace.id, row.kind, name, description, row.icon, body, ctx.key, now())
      .run();
    const me = (await this.who.profiles(ctx.workspace, [ctx.key])).get(ctx.key) ?? null;
    return ok({ id, kind: row.kind, name, description, icon: row.icon, builtin: false, body, created_by: me });
  }

  async deleteTemplate(a: Args & { template_id: string }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const row = await this.db.prepare("SELECT created_by FROM folio_templates WHERE id = ? AND workspace_id = ?").bind(String(a.template_id ?? ""), ctx.workspace.id).first<{ created_by: string }>();
    if (!row) return fail("not_found", "No such template.");
    if (row.created_by !== ctx.key && !ctx.owner) return fail("forbidden", "Only whoever saved a template, or an owner, can delete it.");
    await this.db.prepare("DELETE FROM folio_templates WHERE id = ?").bind(a.template_id).run();
    return ok(true);
  }

  async export(a: Args & { folio_id: string; format?: "markdown" | "json" | null }): Promise<Result<{ filename: string; content_type: string; body: string }>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const { row } = opened.value;
    if (!kindModel(row.kind)) return fail("invalid", `${kindLabel(row.kind)} aren't here yet.`);
    const read = await (await this.ready(ctx.workspace, row)).read();
    const title = row.title || "Untitled";
    const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "artifact";
    const markdown = row.kind === "doc" || row.kind === "slides";
    if ((a.format ?? (markdown ? "markdown" : "json")) === "markdown" && markdown) {
      return ok({ filename: `${base}.md`, content_type: "text/markdown; charset=utf-8", body: `# ${title}\n\n${read.content}` });
    }
    return ok({ filename: `${base}.json`, content_type: "application/json", body: JSON.stringify({ kind: row.kind, title, content: read.content }, null, 2) });
  }

  // ── Suggestions, proposals and comments ─────────────────────────────────

  private async toSuggestions(workspace: Workspace, rows: SuggestionRow[], blocks: (string[] | null)[] = []): Promise<FolioSuggestion[]> {
    const people = await this.who.profiles(
      workspace,
      rows.flatMap((r) => [r.author, r.asked_by, r.decided_by].filter((k): k is string => !!k)),
    );
    return rows.map((r, i) => ({
      id: r.id,
      folio_id: r.folio_id,
      author: people.get(r.author)!,
      asked_by: r.asked_by ? (people.get(r.asked_by) ?? null) : null,
      target: parseJson<DocEditTarget>(r.target, { kind: "append" }),
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

  private async openSuggestions(ctx: Ctx, row: FolioRow): Promise<FolioSuggestion[]> {
    const rows = (await this.db.prepare("SELECT * FROM folio_suggestions WHERE folio_id = ? AND status = 'open' ORDER BY created_at").bind(row.id).all<SuggestionRow>()).results;
    if (!rows.length) return [];
    let blocks: (string[] | null)[] = rows.map(() => []);
    try {
      blocks = await (await this.ready(ctx.workspace, row)).targets(rows.map((r) => parseJson<DocEditTarget>(r.target, { kind: "append" })));
    } catch (error) {
      console.error("folios could not place suggestions", String(error));
    }
    const gone = rows.filter((_, i) => blocks[i] === null);
    if (gone.length) await this.db.batch(gone.map((r) => this.db.prepare("UPDATE folio_suggestions SET status = 'stale' WHERE id = ?").bind(r.id)));
    const live = rows.map((r, i) => ({ r, b: blocks[i] })).filter((x) => x.b !== null);
    return this.toSuggestions(
      ctx.workspace,
      live.map((x) => x.r),
      live.map((x) => x.b!),
    );
  }

  /** Files a doc suggestion: someone who can comment (a person, or an agent for one). */
  private async fileSuggestion(
    ctx: Ctx,
    row: FolioRow,
    by: { author: string; asked_by: string | null; agentName: string | null },
    edit: { target: DocEditTarget; markdown: string; note: string | null; marks_current: boolean },
  ): Promise<Result<FolioSuggestion>> {
    const room = await this.ready(ctx.workspace, row);
    const current = await room.target(edit.target);
    if (!current) return fail("not_found", "That part of the doc isn't there. Read it again and target what is there now.");
    const s: SuggestionRow = {
      id: newId("sug"),
      folio_id: row.id,
      author: by.author,
      asked_by: by.asked_by,
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
      .prepare("INSERT INTO folio_suggestions (id, folio_id, author, asked_by, target, before_markdown, after_markdown, note, status, created_at, marks_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .bind(s.id, s.folio_id, s.author, s.asked_by, s.target, s.before_markdown, s.after_markdown, s.note, s.created_at, s.marks_current)
      .run();
    const [suggestion] = await this.toSuggestions(ctx.workspace, [s], [current.block_ids]);
    this.tell(row.id, { type: "suggestion.created", suggestion: suggestion! });
    if (by.agentName) this.defer(room.announce(by.author, by.agentName).catch(() => undefined));
    this.defer(this.notifyOwnerOfSuggestion(ctx, row, suggestion!));
    return ok(suggestion!);
  }

  private async notifyOwnerOfSuggestion(ctx: Ctx, row: FolioRow, suggestion: FolioSuggestion): Promise<void> {
    if (!this.env.NOTIFY || !row.owner.startsWith("user:") || row.owner === suggestion.author.kind + ":" + suggestion.author.id) return;
    const id = row.owner.slice(5);
    await notifyClient(this.env.NOTIFY)
      .notify(
        { user_id: id },
        {
          id: `folio-suggestion:${suggestion.id}:${id}`,
          kind: "inbox",
          workspace: ctx.workspace.slug,
          title: `${suggestion.author.display_name} suggested a change to ${row.title || "Untitled"}`,
          body: suggestion.note ?? excerpt(suggestion.after_markdown, 140),
          href: this.ref(ctx.workspace.slug, row).path,
          actor: { kind: suggestion.author.kind, id: suggestion.author.id, name: suggestion.author.display_name, avatar: suggestion.author.avatar, avatar_seed: suggestion.author.avatar_seed ?? null },
          created_at: suggestion.created_at,
        },
      )
      .catch(() => undefined);
  }

  async suggestions(a: Args & { folio_id: string }): Promise<Result<FolioSuggestion[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    if (opened.value.row.kind !== "doc") return ok([]);
    return ok(await this.openSuggestions(ctx, opened.value.row));
  }

  async decideSuggestion(a: Args & { suggestion_id: string; decision: "accept" | "reject" }): Promise<Result<FolioSuggestion>> {
    const s = await this.db.prepare("SELECT * FROM folio_suggestions WHERE id = ?").bind(String(a.suggestion_id ?? "")).first<SuggestionRow>();
    if (!s) return fail("not_found", "No such suggestion.");
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, s.folio_id, "edit");
    if (!opened.ok) return opened.error.code === "forbidden" ? fail("forbidden", "Only people who can edit it can accept or reject a suggestion.") : opened;
    const { row } = opened.value;
    if (s.status !== "open") return fail("conflict", "That suggestion was already decided.");
    let status: DocSuggestion["status"] = a.decision === "accept" ? "accepted" : "rejected";
    if (a.decision === "accept") {
      const people = await this.who.profiles(ctx.workspace, [s.author, ctx.key]);
      const room = await this.ready(ctx.workspace, row);
      const result = await room.edit(
        { kind: "doc", target: parseJson<DocEditTarget>(s.target, { kind: "append" }), markdown: s.after_markdown },
        { key: ctx.key, kind: "suggestion", note: `Suggested by @${people.get(s.author)!.name}, accepted by @${people.get(ctx.key)!.name}`, authors: [s.author, ctx.key] },
      );
      if (!result.applied) status = "stale";
      else if (s.marks_current) await this.clearStale(row.id, s.author);
    }
    const at = now();
    await this.db.prepare("UPDATE folio_suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(status, ctx.key, at, s.id).run();
    const [after] = await this.toSuggestions(ctx.workspace, [{ ...s, status, decided_by: ctx.key, decided_at: at }]);
    this.tell(row.id, { type: "suggestion.updated", suggestion: after! });
    if (status === "stale") return fail("conflict", "The part this suggestion changes is gone, so it can't be applied.");
    return ok(after!);
  }

  async proposals(a: Args & { folio_id: string }): Promise<Result<FolioProposal[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const rows = (
      await this.db
        .prepare("SELECT id, folio_id, author, asked_by, note, summary, status, created_at, decided_by, decided_at FROM folio_proposals WHERE folio_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(opened.value.row.id)
        .all<{ id: string; folio_id: string; author: string; asked_by: string | null; note: string | null; summary: string; status: FolioProposal["status"]; created_at: string; decided_by: string | null; decided_at: string | null }>()
    ).results;
    const people = await this.who.profiles(
      ctx.workspace,
      rows.flatMap((r) => [r.author, r.asked_by, r.decided_by].filter((k): k is string => !!k)),
    );
    return ok(
      rows.map((r) => ({
        id: r.id,
        folio_id: r.folio_id,
        author: people.get(r.author)!,
        asked_by: r.asked_by ? (people.get(r.asked_by) ?? null) : null,
        note: r.note,
        summary: r.summary,
        status: r.status,
        created_at: r.created_at,
        decided_by: r.decided_by ? (people.get(r.decided_by) ?? null) : null,
        decided_at: r.decided_at,
      })),
    );
  }

  async decideProposal(a: Args & { proposal_id: string; decision: "accept" | "reject" }): Promise<Result<FolioProposal>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const row = await this.db.prepare("SELECT folio_id FROM folio_proposals WHERE id = ?").bind(String(a.proposal_id ?? "")).first<{ folio_id: string }>();
    if (!row) return fail("not_found", "No such proposal.");
    const opened = await this.open(found.value, row.folio_id, "edit");
    if (!opened.ok) return opened;
    // Proposals arrive with slides, designs and dashboards (Phases 4 to 6).
    return fail("invalid", "Proposals can't be applied yet.");
  }

  async thread(a: Args & { folio_id: string; action: DocThreadAction }): Promise<Result<unknown>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "comment");
    if (!opened.ok) return opened;
    const { row, role } = opened.value;
    const room = await this.ready(ctx.workspace, row);
    const result = (await room.thread(ctx.key, role, a.action)) as ThreadResult;
    if (!result.ok) return fail(result.code, result.message);
    if (result.mentions?.length) {
      const names = result.mentions.filter((k) => k.startsWith("user:")).map((k) => k.slice(5).toLowerCase());
      this.defer(this.notifyMentioned(ctx.workspace, row, names, ctx.key, result.text ?? "", result.thread_id ?? null));
    }
    return ok(result.value);
  }

  async threads(a: Args & { folio_id: string }): Promise<Result<DocThread[]>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const opened = await this.open(ctx, a.folio_id, "view");
    if (!opened.ok) return opened;
    const threads = await (await this.ready(ctx.workspace, opened.value.row)).threads();
    const people = await this.who.profiles(
      ctx.workspace,
      threads.flatMap((t) => t.comments.map((c) => c.author)),
    );
    return ok(threads.map((t) => ({ ...t, comments: t.comments.map((c) => ({ ...c, author: people.get(c.author)! })) })));
  }

  /**
   * People mentioned (by username) in a folio or a comment on it hear of
   * it, only when they can read it (leak rule 4); never the person who
   * wrote it. Agents hear of mentions only through their asker.
   */
  async notifyMentioned(workspace: Workspace, row: FolioRow, usernames: string[], author: string | null, text: string, threadId: string | null): Promise<void> {
    if (!this.env.NOTIFY) return;
    const authorName = author?.startsWith("user:") ? ((await this.who.profiles(workspace, [author])).get(author)?.name ?? "").toLowerCase() : "";
    const names = [...new Set(usernames.map((n) => n.toLowerCase()))].filter((n) => n && n !== authorName).slice(0, 50);
    if (!names.length) return;
    const who = author ? (await this.who.profiles(workspace, [author])).get(author) : null;
    const href = `${this.ref(workspace.slug, row).path}${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`;
    const notify = notifyClient(this.env.NOTIFY);
    const identity = identityClient(this.env.IDENTITY);
    for (const username of names) {
      const user = await identity.userByUsername(username).catch(() => null);
      if (!user) continue;
      const role = await this.roleOfPerson(workspace, row, userKey(user), username);
      if (!role) continue;
      await notify
        .notify(
          { username },
          {
            id: threadId ? `folio-comment:${row.id}:${threadId}:${username}:${Date.now()}` : `folio-mention:${row.id}:${username}`,
            kind: "mention",
            workspace: workspace.slug,
            title: who ? `${who.display_name} mentioned you in ${row.title || "Untitled"}` : `You were mentioned in ${row.title || "Untitled"}`,
            body: excerpt(text, 140),
            href,
            actor: who ? { kind: who.kind, id: who.id, name: who.display_name, avatar: who.avatar, avatar_seed: who.avatar_seed ?? null } : { kind: "system", id: "g1t", name: "g1t", avatar: null, avatar_seed: null },
            created_at: now(),
          },
        )
        .catch(() => undefined);
    }
  }

  // ── Dashboards (Phase 5b) ───────────────────────────────────────────────

  async queryTile(a: Args & { folio_id: string; tile_id: string }): Promise<Result<never>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const opened = await this.open(found.value, a.folio_id, "view");
    if (!opened.ok) return opened;
    return fail("invalid", "Dashboards aren't here yet.");
  }

  async queryDataset(a: Args & { query: unknown }): Promise<Result<never>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    return fail("invalid", "Dashboards aren't here yet.");
  }

  async queryDatasetForAgent(a: AgentArgs): Promise<Result<never>> {
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    return fail("invalid", "Dashboards aren't here yet.");
  }

  // ── Staleness ───────────────────────────────────────────────────────────

  private async clearStale(folioId: string, by: string): Promise<boolean> {
    const done = await this.db.prepare("UPDATE folio_changes SET cleared_at = ?, cleared_by = ? WHERE folio_id = ? AND cleared_at IS NULL").bind(now(), by, folioId).run();
    const cleared = (done.meta?.changes ?? 0) > 0;
    if (cleared) this.tell(folioId, { type: "folio.staleness" });
    return cleared;
  }

  async markCurrent(a: Args & { folio_id: string }): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const opened = await this.open(found.value, a.folio_id, "edit");
    if (!opened.ok) return opened;
    await this.clearStale(opened.value.row.id, found.value.key);
    return ok(true);
  }

  async reindex(a: Args): Promise<Result<boolean>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    if (!found.value.owner) return fail("forbidden", "Only an owner can index the workspace's artifacts again.");
    return ok(await startBackfill(this.env, found.value.workspace.id, { force: true }));
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  private async agentCtx(a: AgentArgs): Promise<Result<AgentCtx>> {
    const found = await this.ctx(a.workspace, a.viewer);
    if (!found.ok) return found;
    const ctx = found.value;
    const agentId = String(a.agent_id ?? "");
    const agent = (await this.who.agentsById([agentId])).get(agentId);
    if (!agent || agent.workspace_id !== ctx.workspace.id || agent.archived_at) return fail("not_found", "No such agent.");
    const rule = audienceRule(a.audience ?? null, ctx.viewer.id);
    const people = rule.kind === "people" ? await this.who.peopleByIds(ctx.workspace, rule.user_ids) : [];
    return ok({ ...ctx, agent, agentKey: principalKey({ kind: "agent", id: agent.id }), rule, people, audienceIds: rule.kind === "people" ? rule.user_ids : [] });
  }

  /** What the agent may reach in each folio for its asker and audience. */
  private async reach(actx: AgentCtx, rows: FolioRow[]): Promise<Map<string, AgentReach>> {
    const out = new Map<string, AgentReach>();
    if (!rows.length) return out;
    const [found, asker] = await Promise.all([ancestry(this.db, rows), visitsOf(this.db, actx.viewer.id, rows)]);
    let audienceVisits = new Map<string, Set<string>>();
    if (actx.rule.kind === "people") {
      const ids = [...new Set(rows.flatMap((r) => [r.id, r.acl_root]))];
      const found2 = await this.db
        .prepare("SELECT folio_id, user_id FROM folio_visits WHERE user_id IN (SELECT value FROM json_each(?)) AND folio_id IN (SELECT value FROM json_each(?))")
        .bind(json(actx.audienceIds), json(ids))
        .all<{ folio_id: string; user_id: string }>();
      audienceVisits = new Map();
      for (const v of found2.results) audienceVisits.set(v.user_id, (audienceVisits.get(v.user_id) ?? new Set()).add(v.folio_id));
    }
    const allSpaces = new Map((await this.who.allSpaces(actx.workspace)).map((s) => [s.row.id, s]));
    for (const row of rows) {
      const chain = aclChain(row.id, found.nodes);
      const root = chain[chain.length - 1];
      const s = root?.space_id ? allSpaces.get(root.space_id) : undefined;
      const space: SpaceRules | null = s ? rulesOf(s) : null;
      const seen = (set: Set<string> | undefined) => !!set && (set.has(row.id) || (!!root && set.has(root.id)));
      out.set(
        row.id,
        agentReach({
          chain,
          grants: found.grants,
          space,
          asker: actx.person,
          askerVisited: seen(asker),
          rule: actx.rule,
          people: actx.people,
          visited: (p) => seen(audienceVisits.get(p.user_id)),
          agent_mode: this.agentMode(row, actx),
        }),
      );
    }
    return out;
  }

  /** A folio the agent may reach for its asker: not found when the asker can't read it. */
  private async agentOpen(actx: AgentCtx, folioId: unknown): Promise<Result<{ row: FolioRow; reach: AgentReach }>> {
    const row = await this.db.prepare(`SELECT ${FOLIO_COLUMNS} FROM folios WHERE id = ? AND workspace_id = ? AND trashed_at IS NULL`).bind(String(folioId ?? ""), actx.workspace.id).first<FolioRow>();
    if (!row) return fail("not_found", "No such artifact.");
    const reach = (await this.reach(actx, [row])).get(row.id)!;
    if (!reach.asker_role) return fail("not_found", "No such artifact.");
    return ok({ row, reach });
  }

  async foliosForAgent(a: AgentArgs & { query: FolioListQuery }): Promise<Result<FolioList>> {
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    const actx = found.value;
    const query = { ...(a.query ?? { tab: "all" as const }), tab: a.query?.tab ?? "all", limit: Math.min(listLimit(a.query?.limit), 50) };
    const invalid = folioListQueryError(query);
    if (invalid) return fail("invalid", invalid);
    const page = await this.listFor(actx, query);
    const rows = await foliosById(
      this.db,
      page.items.map((f) => f.id),
    );
    const reach = await this.reach(actx, [...rows.values()]);
    return ok({ items: page.items.filter((f) => agentMayFind(reach.get(f.id) ?? { asker_role: null, audience_can_read: false, can: { read: false, suggest: false, edit: false } })), next_cursor: page.next_cursor });
  }

  async readForAgent(a: AgentArgs & { folio_id: string }): Promise<Result<FolioAgentRead>> {
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    const actx = found.value;
    const opened = await this.agentOpen(actx, a.folio_id);
    if (!opened.ok) return opened;
    const { row, reach } = opened.value;
    if (!kindModel(row.kind)) return fail("invalid", `${kindLabel(row.kind)} aren't here yet.`);
    const read = await (await this.ready(actx.workspace, row)).read();
    return ok({
      folio: { ...this.ref(actx.workspace.slug, row), edited_at: row.edited_at },
      space: this.spaceOf(actx, row),
      content: read.content,
      ...(read.blocks ? { blocks: read.blocks } : {}),
      can: reach.can,
      audience_can_read: reach.audience_can_read,
    });
  }

  async createAsAgent(
    a: AgentArgs & {
      input: { kind: FolioKind; title: string; content?: FolioContentInput | null; template_id?: string | null; where: { space_id: string } | "private" | { conversation: string[] }; parent_id?: string | null; source?: { title: string; href: string } | null };
    },
  ): Promise<Result<FolioRef>> {
    const found = await this.agentCtx({ ...a, audience: null });
    if (!found.ok) return found;
    const actx = found.value;
    const input = a.input ?? ({} as typeof a.input);
    const invalid = newFolioError({ kind: input.kind, title: input.title, content: input.content ?? null, template_id: input.template_id ?? null });
    if (invalid) return fail("invalid", invalid);
    if (!kindModel(input.kind)) return fail("invalid", `${kindLabel(input.kind)} aren't here yet.`);
    const title = cleanTitle(input.title);
    if (!title && !input.template_id) return fail("invalid", "Give it a title.");
    const where = input.where ?? "private";
    let place: Result<{ space_id: string | null; parent: FolioRow | null }>;
    let grants: { principal: string; role: DocRole }[] = [{ principal: actx.agentKey, role: "edit" }];
    if (input.parent_id) place = await this.placeFor(actx, { parent_id: input.parent_id });
    else if (typeof where === "object" && "space_id" in where) place = await this.placeFor(actx, { space_id: where.space_id });
    else place = ok({ space_id: null, parent: null });
    if (!place.ok) return place.error.code === "forbidden" ? fail("forbidden", `${actx.viewer.username} can't add there.`) : place;
    if (typeof where === "object" && "conversation" in where) {
      // Private, and the conversation's people may read it.
      const ids = [...new Set((Array.isArray(where.conversation) ? where.conversation : []).map(String))].filter((id) => id && id !== actx.viewer.id).slice(0, FOLIO_MAX_SHARE);
      const people = await this.who.peopleByIds(actx.workspace, ids);
      grants = [...grants, ...people.filter((p) => !p.user_id.startsWith("outside:")).map((p) => ({ principal: `user:${p.user_id}`, role: "view" as DocRole }))];
    }
    const start = await this.startingPoint(actx, input.kind, { title, template_id: input.template_id, content: input.content });
    if (!start.ok) return start;
    const row = await this.insertFolio(actx, {
      kind: input.kind,
      owner: actx.key,
      created_by: actx.agentKey,
      space_id: place.value.space_id,
      parent: place.value.parent,
      title: start.value.title,
      icon: start.value.icon,
      text: start.value.text,
      spec: start.value.spec,
      source: cleanSource(input.source),
      grants,
    });
    return ok(this.ref(actx.workspace.slug, row));
  }

  async editAsAgent(a: AgentArgs & { folio_id: string; edit: FolioAgentEdit }): Promise<Result<FolioAgentEditResult>> {
    const found = await this.agentCtx({ ...a, audience: null });
    if (!found.ok) return found;
    const actx = found.value;
    const opened = await this.agentOpen(actx, a.folio_id);
    if (!opened.ok) return opened;
    const { row, reach } = opened.value;
    const invalid = this.editError(row, a.edit);
    if (invalid) return fail("invalid", invalid);
    const edit = a.edit;
    const ref = this.ref(actx.workspace.slug, row);
    if (reach.can.edit && !edit.suggest_only) {
      const room = await this.ready(actx.workspace, row);
      const note = cleanNote(edit.note);
      const result = await room.edit(edit, {
        key: actx.agentKey,
        kind: "agent",
        note: note ? `@${actx.agent.handle} for @${actx.viewer.username}: ${note}` : `@${actx.agent.handle} for @${actx.viewer.username}`,
        authors: [actx.agentKey],
      });
      if (!result.applied) return fail("not_found", `${result.summary} Read it again and target what is there now.`);
      if (edit.marks_current) await this.clearStale(row.id, actx.agentKey);
      this.defer(room.announce(actx.agentKey, actx.agent.display_name).catch(() => undefined));
      return ok({ mode: "applied", version_id: result.version_id, folio: ref, summary: result.summary });
    }
    if (!reach.can.suggest) return fail("forbidden", `${actx.viewer.username} can only read this, so it can't be changed for them.`);
    if (edit.kind !== "doc") return fail("forbidden", `Changing ${kindLabel(row.kind)} without edit access comes with proposals, which aren't here yet.`);
    const suggestion = await this.fileSuggestion(actx, row, { author: actx.agentKey, asked_by: actx.key, agentName: actx.agent.display_name }, { target: cleanTarget(edit.target)!, markdown: edit.markdown, note: cleanNote(edit.note), marks_current: edit.marks_current === true });
    return suggestion.ok ? ok({ mode: "suggested", suggestion: suggestion.value, folio: ref }) : suggestion;
  }

  async shareAsAgent(a: AgentArgs & { folio_id: string; user_ids: string[]; role: "view" | "comment" }): Promise<Result<FolioAccessList>> {
    if (a.role !== "view" && a.role !== "comment") return fail("invalid", "An agent shares to view or comment only. For more, post a card with a Share button for the person to press.");
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    const actx = found.value;
    if (actx.rule.kind !== "people") return fail("forbidden", "An agent shares only with people in a private conversation. Ask the person to use Share instead.");
    const opened = await this.agentOpen(actx, a.folio_id);
    if (!opened.ok) return opened;
    const { row, reach } = opened.value;
    if (!canShare(reach.asker_role)) return fail("forbidden", `${actx.viewer.username} doesn't have full access, so it can't be shared for them.`);
    const inConversation = new Set(actx.rule.user_ids);
    const ids = [...new Set((Array.isArray(a.user_ids) ? a.user_ids : []).map(String))];
    if (!ids.length) return fail("invalid", "Name who to share it with.");
    if (ids.some((id) => !inConversation.has(id))) return fail("forbidden", "An agent shares only with people already in the conversation.");
    const people = (await this.who.peopleByIds(actx.workspace, ids)).filter((p) => !p.user_id.startsWith("outside:"));
    const at = now();
    // Never lowers what someone already has.
    await runBatches(
      this.db,
      people.map((p) =>
        this.db
          .prepare(
            "INSERT INTO folio_grants (folio_id, principal, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (folio_id, principal) DO UPDATE SET role = CASE WHEN folio_grants.role IN ('edit', 'manage') OR (folio_grants.role = 'comment' AND excluded.role = 'view') THEN folio_grants.role ELSE excluded.role END",
          )
          .bind(row.id, `user:${p.user_id}`, a.role, actx.agentKey, at),
      ),
    );
    const list = await this.afterShare(actx, row);
    const open = await workspaceReadable(this.db, row.id).catch(() => false);
    this.defer(
      publishFolioEvent(
        this.env.EVENTS,
        "folio.shared",
        { workspace: actx.workspace.slug, workspaceId: actx.workspace.id, folioId: row.id, kind: row.kind, spaceId: row.space_id, title: open ? row.title : null, principals: people.map((p) => `user:${p.user_id}`), role: a.role },
        actx.agentKey,
      ),
    );
    return ok(list);
  }

  /**
   * What the workspace's artifacts (and projects' docs) say about a
   * query, for an agent about to answer: passages by meaning above the
   * floor, then by words, at most two per folio, only from folios its
   * asker and every person in the audience can read, each checked against
   * the folio itself. Projects' docs come from Docs' index (`g1t-docs`)
   * until Phase 7 moves them.
   */
  async recallForAgent(a: AgentArgs & { query: string; limit?: number | null; spaces?: string[] | null; kinds?: FolioKind[] | null }): Promise<Result<FolioPassage[]>> {
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    const actx = found.value;
    this.defer(ensureIndexed(this.env, actx.workspace.id).catch((error: unknown) => console.error("folios could not start indexing", actx.workspace.id, String(error))));
    const query = String(a.query ?? "").trim().slice(0, 2000);
    if (!query) return ok([]);
    const limit = recallLimit(a.limit);
    const kinds = (a.kinds ?? []).filter(isFolioKind);
    const { scopes } = await this.allowedScopes(actx);
    const required = new Set((Array.isArray(a.spaces) ? a.spaces : []).map((id) => `space:${id}`).filter((s) => scopes.includes(s)));
    const fts = ftsAnyQuery(query);
    const [meaning, words, repo] = await Promise.all([
      this.meaningPassages(actx, query, scopes, kinds).catch(() => []),
      fts
        ? this.db
            .prepare(
              `SELECT c.id, c.folio_id, c.scope, c.heading, c.text FROM folio_chunks_fts JOIN folio_chunks c ON c.id = folio_chunks_fts.chunk_id
               WHERE folio_chunks_fts MATCH ? AND c.workspace_id = ? ${scopes.length <= 80 ? "AND folio_chunks_fts.scope IN (SELECT value FROM json_each(?))" : ""} ${kinds.length ? "AND c.kind IN (SELECT value FROM json_each(?))" : ""}
               ORDER BY bm25(folio_chunks_fts, 0, 0, 0, 4.0, 1.0) LIMIT 30`,
            )
            .bind(fts, actx.workspace.id, ...(scopes.length <= 80 ? [json(scopes)] : []), ...(kinds.length ? [json(kinds)] : []))
            .all<{ id: string; folio_id: string; scope: string; heading: string | null; text: string }>()
            .then((r) => r.results)
            .catch((error: unknown) => {
              console.error("folios word recall failed", String(error));
              return [] as { id: string; folio_id: string; scope: string; heading: string | null; text: string }[];
            })
        : Promise.resolve([] as { id: string; folio_id: string; scope: string; heading: string | null; text: string }[]),
      kinds.length && !kinds.includes("doc") ? Promise.resolve([] as FolioPassage[]) : this.recallRepoDocs(actx, query, fts, limit).catch(() => [] as FolioPassage[]),
    ]);
    // Every folio a passage came from, checked as the agent's asker and audience.
    const folioIds = [...new Set([...meaning.map((m) => m.folio_id), ...words.map((w) => w.folio_id)])];
    const rows = [...(await foliosById(this.db, folioIds)).values()].filter((r) => r.workspace_id === actx.workspace.id && !r.trashed_at);
    const reach = await this.reach(actx, rows);
    const may = new Set(rows.filter((r) => agentMayFind(reach.get(r.id)!)).map((r) => r.id));
    const byFolio = new Map(rows.map((r) => [r.id, r]));
    type C = Candidate & { heading: string | null; text: string };
    const scopeOf = (folioId: string) => (required.size && byFolio.get(folioId)?.space_id && required.has(`space:${byFolio.get(folioId)!.space_id}`) ? "required" : "rest");
    const candidates: C[] = [
      ...meaning.filter((m) => may.has(m.folio_id)).map((m) => ({ id: m.id, doc_id: m.folio_id, space_id: scopeOf(m.folio_id), score: m.score, by: "meaning" as const, heading: m.heading, text: m.text })),
      ...words.filter((w) => may.has(w.folio_id)).map((w) => ({ id: w.id, doc_id: w.folio_id, space_id: scopeOf(w.folio_id), score: WORDS_SCORE, by: "words" as const, heading: w.heading, text: w.text })),
    ];
    const picked = pickPassages(candidates, { allowed: new Set(["required", "rest"]), required: required.size ? ["required"] : [], limit });
    const stale = await this.staleIds(picked.map((c) => c.doc_id));
    const passages: FolioPassage[] = picked.map((c) => {
      const row = byFolio.get(c.doc_id)!;
      const space = row.space_id ? actx.spaceById.get(row.space_id) : undefined;
      return {
        folio: this.ref(actx.workspace.slug, row),
        repo_file: null,
        space_name: space?.row.name ?? "Private",
        heading: c.heading,
        text: c.text,
        score: Math.round(c.score * 1000) / 1000,
        updated_at: row.edited_at,
        stale: stale.has(row.id),
      };
    });
    // Projects' docs fill what's left, best first.
    const out = [...passages, ...repo.sort((x, y) => y.score - x.score)].slice(0, limit);
    return ok(out.sort((x, y) => y.score - x.score));
  }

  /** Projects' docs the agent may recall from: repositories its asker and every person in the audience can read. */
  private async recallRepoDocs(actx: AgentCtx, query: string, fts: string | null, limit: number): Promise<FolioPassage[]> {
    const spaces = await this.repoSpacesForAudience(actx);
    if (!spaces.length) return [];
    const ids = spaces.map((s) => s.row.id);
    const { embedder, store } = adapters(this.env);
    const vector = store ? await this.queryVector(query, embedder) : null;
    const plan = vectorQueryPlan(actx.workspace.id, ids);
    const [meaning, words] = await Promise.all([
      vector && store && plan ? store.query(vector, { topK: plan.topK, filter: plan.filter }).catch(() => [] as { id: string; score: number }[]) : Promise.resolve([] as { id: string; score: number }[]),
      fts
        ? this.db
            .prepare(
              `SELECT doc_chunks_fts.chunk_id AS id FROM doc_chunks_fts JOIN doc_chunks c ON c.id = doc_chunks_fts.chunk_id
               WHERE doc_chunks_fts MATCH ? AND c.workspace_id = ? AND c.repo_file_id IS NOT NULL AND doc_chunks_fts.space_id IN (SELECT value FROM json_each(?))
               ORDER BY bm25(doc_chunks_fts, 0, 0, 0, 4.0, 1.0) LIMIT 20`,
            )
            .bind(fts, actx.workspace.id, json(ids))
            .all<{ id: string }>()
            .then((r) => r.results.map((x) => x.id))
            .catch(() => [] as string[])
        : Promise.resolve([] as string[]),
    ]);
    const scores = new Map<string, number>();
    for (const m of meaning) if (m.score >= MEANING_FLOOR) scores.set(m.id, Math.max(scores.get(m.id) ?? 0, m.score));
    for (const id of words) if (!scores.has(id)) scores.set(id, WORDS_SCORE);
    if (!scores.size) return [];
    const rows = (
      await this.db
        .prepare(
          `SELECT c.id, c.space_id, c.repo_file_id, c.path, c.heading, c.text FROM doc_chunks c JOIN repo_files f ON f.space_id = c.space_id AND f.path = c.path
           WHERE c.workspace_id = ? AND c.repo_file_id IS NOT NULL AND c.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(actx.workspace.id, json([...scores.keys()]))
        .all<{ id: string; space_id: string; repo_file_id: string; path: string; heading: string | null; text: string }>()
    ).results;
    const bySpace = new Map(spaces.map((s) => [s.row.id, s]));
    const perFile = new Map<string, number>();
    const out: FolioPassage[] = [];
    for (const r of rows.sort((x, y) => (scores.get(y.id) ?? 0) - (scores.get(x.id) ?? 0))) {
      const s = bySpace.get(r.space_id);
      if (!s) continue;
      const n = perFile.get(r.repo_file_id) ?? 0;
      if (n >= 2) continue;
      perFile.set(r.repo_file_id, n + 1);
      const name = `${s.repo.namespace}/${s.repo.name}`;
      out.push({
        folio: null,
        repo_file: { repo: name, path: r.path, href: `/${actx.workspace.slug}/-/artifacts/repo/${name}/${r.path.split("/").map(encodeURIComponent).join("/")}` },
        space_name: name,
        heading: r.heading,
        text: r.text,
        score: Math.round((scores.get(r.id) ?? 0) * 1000) / 1000,
        updated_at: s.row.indexed_at ?? s.row.added_at,
        stale: false,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async staleForAgent(a: AgentArgs & { repo?: string | null; since?: string | null }): Promise<Result<Folio[]>> {
    const found = await this.agentCtx(a);
    if (!found.ok) return found;
    const actx = found.value;
    const repo = a.repo ? projectRef(a.repo) : null;
    if (a.repo && !repo) return fail("invalid", "Name the repository as owner/name.");
    const since = a.since && !Number.isNaN(Date.parse(a.since)) ? new Date(a.since).toISOString() : null;
    const rows = (
      await this.db
        .prepare(
          `SELECT ${folioColumns("f")} FROM folios f JOIN (SELECT folio_id, MAX(detected_at) AS flagged FROM folio_changes WHERE cleared_at IS NULL ${repo ? "AND repo = ?" : ""} GROUP BY folio_id) c ON c.folio_id = f.id
           WHERE f.workspace_id = ? AND f.trashed_at IS NULL ${since ? "AND c.flagged >= ?" : ""} ORDER BY c.flagged DESC LIMIT 200`,
        )
        .bind(...(repo ? [repo] : []), actx.workspace.id, ...(since ? [since] : []))
        .all<FolioRow>()
    ).results;
    const reach = await this.reach(actx, rows);
    return ok((await this.toFolios(actx, rows.filter((r) => agentMayFind(reach.get(r.id)!)))).slice(0, 50));
  }

  // ── Projects' docs ──────────────────────────────────────────────────────

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

  private async repoSpacesFor(ctx: Ctx): Promise<DocRepoSpace[]> {
    const found = await this.readableRepoSpaces(ctx.workspace, ctx.viewer);
    if (!found.length) return [];
    const [files, people] = await Promise.all([
      this.db
        .prepare("SELECT space_id, path, title FROM repo_files WHERE space_id IN (SELECT value FROM json_each(?))")
        .bind(json(found.map((f) => f.row.id)))
        .all<{ space_id: string; path: string; title: string }>(),
      this.who.profiles(
        ctx.workspace,
        found.map((f) => f.row.added_by),
      ),
    ]);
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
      can_remove: row.added_by === ctx.key || ctx.owner,
    }));
  }

  /** Projects' docs an agent may recall from: the asker's, narrowed to every person in the audience (public repositories only for a workspace audience). */
  private async repoSpacesForAudience(actx: AgentCtx): Promise<{ row: RepoSpaceRow; repo: Repo }[]> {
    const mine = await this.readableRepoSpaces(actx.workspace, actx.viewer);
    if (!mine.length || actx.rule.kind === "asker") return mine;
    const publicOnly = () => mine.filter((s) => !s.repo.isPrivate);
    if (actx.rule.kind === "workspace" || !this.env.REPOS) return publicOnly();
    const others = await identityClient(this.env.IDENTITY)
      .usersForAudience(actx.rule.user_ids)
      .catch(() => [] as User[]);
    let keep = new Set(mine.map((s) => s.row.repo_id));
    // Someone who isn't a live account reads public repositories only.
    if (others.length < actx.rule.user_ids.length) keep = new Set(publicOnly().map((s) => s.row.repo_id));
    for (const person of others) {
      const readable = await reposClient(this.env.REPOS)
        .readable([...keep], person)
        .catch(() => [] as Repo[]);
      keep = new Set(readable.map((r) => r.id));
      if (!keep.size) break;
    }
    return mine.filter((s) => keep.has(s.row.repo_id));
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
   * `GET /live?workspace=<slug>&folio=<id>`, upgraded to a WebSocket. The
   * viewer comes in DOCS_VIEWER_HEADER, set by the site after checking
   * the session; trusted only because this Worker is reachable through
   * service bindings alone. Checked like any read (opening counts for a
   * link folio), then handed to the room with the viewer's role.
   */
  async live(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    const viewer = this.viewerFrom(request);
    if (!viewer?.id) return new Response("Sign in to use Artifacts\n", { status: 401 });
    const url = new URL(request.url);
    const found = await this.ctx((url.searchParams.get("workspace") ?? "").toLowerCase(), viewer);
    if (!found.ok) return new Response(`${found.error.message}\n`, { status: found.error.code === "forbidden" ? 403 : 404 });
    const ctx = found.value;
    const opened = await this.open(ctx, url.searchParams.get("folio") ?? "", "view", { trashed: true, opening: true });
    if (!opened.ok) return new Response(`${opened.error.message}\n`, { status: opened.error.code === "forbidden" ? 403 : 404 });
    const { row, role } = opened.value;
    if (row.trashed_at) return new Response("That artifact is in the trash\n", { status: 410 });
    if (!kindModel(row.kind)) return new Response("That kind of artifact isn't here yet\n", { status: 409 });
    const room = await this.ready(ctx.workspace, row);
    const member = (await this.who.profiles(ctx.workspace, [ctx.key])).get(ctx.key)!;
    const headers = new Headers(request.headers);
    headers.delete(DOCS_VIEWER_HEADER);
    headers.set(ROOM_MEMBER_HEADER, JSON.stringify({ folio_id: row.id, workspace_slug: ctx.workspace.slug, key: ctx.key, member, role }));
    return room.fetch(new Request(request.url, { method: "GET", headers }));
  }

  /** `PUT /files?workspace=&folio=&name=`: a file for a folio, from someone who can edit it. */
  async upload(request: Request): Promise<Response> {
    const viewer = this.viewerFrom(request);
    const url = new URL(request.url);
    const found = await this.ctx((url.searchParams.get("workspace") ?? "").toLowerCase(), viewer);
    if (!found.ok) return Response.json(found);
    const ctx = found.value;
    const opened = await this.open(ctx, url.searchParams.get("folio") ?? "", "edit");
    if (!opened.ok) return Response.json(opened);
    const bytes = Number(request.headers.get("content-length") ?? "0");
    if (!bytes || bytes > DOC_MAX_FILE_BYTES) return Response.json(fail("invalid", `Files can be up to ${DOC_MAX_FILE_BYTES / 1024 / 1024} MB.`));
    const name = safeName(url.searchParams.get("name") ?? "file");
    const contentType = servedType(request.headers.get("content-type") ?? "");
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const id = newId("fil");
    await fileStore(this.env).put(`docs/${key}`, request.body ?? new Uint8Array(), contentType);
    await this.db
      .prepare("INSERT INTO folio_files (id, workspace_id, folio_id, key, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ctx.workspace.id, opened.value.row.id, key, name, contentType, bytes, ctx.key, now())
      .run();
    return Response.json(ok({ id, url: `/docs-files/${key}`, name, content_type: contentType, bytes }));
  }

  /** `GET /files/<key>` for a folio's file, or null when the key isn't a folio's (then Docs' pages are asked). */
  async file(key: string): Promise<Response | null> {
    const row = await this.db.prepare("SELECT name, content_type FROM folio_files WHERE key = ?").bind(key).first<{ name: string; content_type: string }>();
    if (!row) return null;
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

/** A folio's room found people newly mentioned in it: those who can read it hear of it. */
export async function notifyFolioMentions(env: FoliosEnv, slug: string, folioId: string, usernames: string[], last: string | null): Promise<void> {
  const service = new Folios(env);
  const workspace = await service.who.workspace(slug);
  if (!workspace) return;
  const row = await env.DB.prepare(`SELECT ${FOLIO_COLUMNS.replace("'' AS text", "text")} FROM folios WHERE id = ? AND workspace_id = ?`).bind(folioId, workspace.id).first<FolioRow>();
  if (!row || row.trashed_at) return;
  await service.notifyMentioned(workspace, row, usernames, last, row.text, null);
}

/** Trashed folios this long ago are deleted for good by the daily cron. */
export const TRASH_DAYS = 30;

/**
 * The daily cron: folios in the trash for over TRASH_DAYS are deleted for
 * good, deepest first, at most 500 a run (the rest go the next day).
 */
export async function purgeTrash(env: FoliosEnv, at = new Date()): Promise<number> {
  const cutoff = new Date(at.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = (await env.DB.prepare("SELECT id, path FROM folios WHERE trashed_at IS NOT NULL AND trashed_at < ? ORDER BY length(path) DESC LIMIT 500").bind(cutoff).all<{ id: string; path: string }>()).results;
  if (!rows.length) return 0;
  // Children still alive under one being purged go to the top of where they were.
  const ids = rows.map((r) => r.id);
  await env.DB.prepare("UPDATE folios SET parent_id = NULL WHERE parent_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))").bind(json(ids), json(ids)).run();
  await forgetFolios(env, ids);
  await runBatches(
    env.DB,
    ids.flatMap((id) => [env.DB.prepare("DELETE FROM folios_fts WHERE folio_id = ?").bind(id), env.DB.prepare("DELETE FROM folios WHERE id = ?").bind(id)]),
  );
  if (env.FOLIOS) for (const id of ids) await env.FOLIOS.get(env.FOLIOS.idFromName(id)).destroy().catch(() => undefined);
  return ids.length;
}

/** The `folios.reacl` job: a large subtree's access, rooms and index brought up to date. */
export async function runReacl(env: FoliosEnv, folioId: string): Promise<void> {
  const service = new Folios(env);
  const ids = await rebuildSubtree(env.DB, folioId);
  await service.followAccess(null, ids);
}
