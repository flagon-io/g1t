/**
 * Docs: the workspace's written knowledge, kept by the artifacts service
 * (`services/artifacts`). Spaces hold trees of pages; each page is a CRDT
 * document (Yjs) edited live over a socket, saved with a Markdown
 * rendition that search, agents, export and the read view use.
 *
 * Wire shapes are snake_case end to end: the site, agents and the live
 * socket all carry the same objects.
 *
 * Access, in one place:
 *
 * - A space has a kind: `workspace` (every member gets `default_role`),
 *   `team` (the team's members get `default_role`) or `private` (only the
 *   people, agents and teams listed as its members).
 * - Members are listed with a role: view < comment < edit < manage. A
 *   person's role is the highest of the space's base role (when it applies
 *   to them) and every listing that names them or one of their teams.
 *   Workspace owners manage every workspace and team space; a private space
 *   is its members' alone.
 * - An agent never sees or changes more than the person it acts for (the
 *   `viewer` on every agent call). It reads what that person can read,
 *   narrowed further to what every person in the `audience` can read; it
 *   suggests where that person can comment; and it edits directly only
 *   where that person can edit AND the space lets agents edit
 *   (`agent_mode: "edit"`). Otherwise its edit becomes a suggestion.
 */
import type { MemberProfile, Principal } from "./chat";
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

/** What someone may do in a space, weakest first. */
export type DocRole = "view" | "comment" | "edit" | "manage";
export const DOC_ROLES: readonly DocRole[] = ["view", "comment", "edit", "manage"];

export const DOC_ROLE_LABELS: Record<DocRole, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
  manage: "Full access",
};

export const DOC_ROLE_SUMMARIES: Record<DocRole, string> = {
  view: "Read pages and their history.",
  comment: "Read pages and comment on them.",
  edit: "Write and organize pages, and accept or reject suggestions.",
  manage: "Edit, and change who has access and how agents work here.",
};

/** Who a space is for. */
export type DocSpaceKind = "workspace" | "team" | "private";

export const DOC_SPACE_KIND_LABELS: Record<DocSpaceKind, string> = {
  workspace: "Everyone in the workspace",
  team: "A team",
  private: "Only its members",
};

/** How agents change pages in a space: as tracked suggestions (the default), or directly. */
export type DocAgentMode = "suggest" | "edit";

export const DOC_AGENT_MODE_LABELS: Record<DocAgentMode, string> = {
  suggest: "Suggest changes",
  edit: "Edit directly",
};

/** A key for a space member: `user:<id>`, `agent:<id>` or `team:<slug>`. */
export type DocMemberKey = string;

export type DocSpace = {
  id: string;
  workspace_id: string;
  /** Unique in the workspace; in the URL: `/<workspace>/-/docs/<slug>`. */
  slug: string;
  name: string;
  description: string | null;
  /** An emoji, or null for the default book. */
  icon: string | null;
  kind: DocSpaceKind;
  /** The team's slug, for a team space. */
  team: string | null;
  /** What every workspace member (workspace) or team member (team) gets; null for a private space. */
  default_role: DocRole | null;
  agent_mode: DocAgentMode;
  /** People with edit access may share what is in it (Artifacts), as people with full access can. Off unless turned on. */
  editors_can_share: boolean;
  /**
   * The workspace's General space, made once when Artifacts is first
   * opened and shown to every member without joining. It can be archived
   * and deleted like any other; once deleted it is not made again, and no
   * other space takes its place.
   */
  is_default: boolean;
  /** Projects (repositories, `owner/name`) the space is about: Docs filters by them. */
  projects: string[];
  created_by: Principal;
  created_at: string;
  archived_at: string | null;
  /** The viewer's role in it. */
  viewer_role: DocRole;
  /** Pages in it that are not in the trash. */
  page_count: number;
};

/** A space member, as the space's settings show it. */
export type DocSpaceMember = {
  key: DocMemberKey;
  kind: "user" | "agent" | "team";
  /** Username, agent handle or team slug. */
  name: string;
  display_name: string;
  avatar: string | null;
  avatar_seed?: string | null;
  role: DocRole;
};

/** Enough to link to a page. */
export type DocPageRef = {
  id: string;
  space_id: string;
  space_slug: string;
  title: string;
  /** An emoji, or null for the default page icon. */
  icon: string | null;
  /** `<title-slug>-<id>`: the last part of the page's URL. */
  slug: string;
  /** `/<workspace>/-/docs/<space>/<slug>`. */
  path: string;
};

export type DocPage = DocPageRef & {
  parent_id: string | null;
  position: number;
  /** A cover image's URL, or a CSS gradient name (`gradient:<n>`); null for none. */
  cover: string | null;
  created_by: MemberProfile;
  created_at: string;
  updated_by: MemberProfile | null;
  updated_at: string;
  /** When it went to the trash; null when it is not there. */
  archived_at: string | null;
  has_children: boolean;
  /** Projects (`owner/name`) the page is about, besides its space's. */
  projects: string[];
  owners: MemberProfile[];
  /** The first lines of its text, for cards. */
  excerpt: string;
  /** Whether code it cites changed since someone last marked it current: possibly out of date. */
  stale: boolean;
};

// ── Citations and staleness ───────────────────────────────────────────────
//
// A page can cite code: a path (a file, a folder, or a glob like
// `src/export/**`) in a repository, optionally naming what at that path it
// describes (a symbol, an endpoint, an environment variable). Citations
// come from the page's text (the editor's citation chips, and links to
// files in a repository: `/<owner>/<repo>/blob/<ref>/<path>`) and from
// the page's header ("Describes"). When a merged pull request or a push
// to a repository's default branch changes a cited path, the page is
// marked possibly out of date with that change, until someone with edit
// access marks it current again (or an agent updates it).

/** What a citation names at its path. */
export type DocCitationKind = "path" | "symbol" | "endpoint" | "env";
export const DOC_CITATION_KINDS: readonly DocCitationKind[] = ["path", "symbol", "endpoint", "env"];

export const DOC_CITATION_KIND_LABELS: Record<DocCitationKind, string> = {
  path: "A file or folder",
  symbol: "A symbol",
  endpoint: "An endpoint",
  env: "An environment variable",
};

export type DocCitation = {
  /** `owner/name`, lowercased. */
  repo: string;
  /** A file, a folder (everything under it), or a glob (`*`, `**`, `?`). */
  path: string;
  kind: DocCitationKind;
  /** The symbol, endpoint (`POST /v1/export`) or variable (`EXPORT_BUCKET`), for those kinds. */
  label: string | null;
  /** The commit it was cited at, when known. */
  ref: string | null;
  /** From the page's text, or from its header's "Describes". */
  source: "body" | "header";
};

/** One entry of a page's "Describes": a repository and a path in it. */
export type DocDescribes = { repo: string; path: string };

/** A change that made a page possibly out of date. */
export type DocStaleChange = {
  /**
   * False when the viewer can't read the repository: then `repo`, `pull`,
   * `commit` and `paths` are blank, and the page only says that a change
   * they can't see touched code it cites.
   */
  visible: boolean;
  repo: string | null;
  commit: string | null;
  /** The merged pull request, when the change came from one. */
  pull: { number: number; title: string | null } | null;
  /** The cited paths it changed (the changed files, at most 20). */
  paths: string[];
  /** When it was noticed. RFC 3339. */
  at: string;
};

/** Why a page is possibly out of date: every change since it was last marked current, newest first. */
export type DocStaleness = { since: string; changes: DocStaleChange[] };

// ── A project's docs ──────────────────────────────────────────────────────
//
// A repository's `docs/` folder (and README.md), shown read-only in Docs
// next to the workspace's spaces and found by the same search. It is read
// from the default branch and kept up to date on every push to it. Each
// reader sees only the repositories they can read. Changes go through the
// repository: "Edit in Code" opens the file.

export type DocRepoFile = {
  /** From the repository's root: `docs/guide/setup.md`, `README.md`. */
  path: string;
  /** Its first heading, or its file name. */
  title: string;
};

export type DocRepoSpace = {
  id: string;
  /** `owner/name`, as the repository is named now. */
  repo: string;
  default_branch: string;
  /** The commit it was read at; null until it has been. */
  commit: string | null;
  indexed_at: string | null;
  added_by: MemberProfile;
  files: DocRepoFile[];
  /** Whether the viewer may stop showing it (whoever added it, or an owner). */
  can_remove: boolean;
};

export type DocRepoPage = {
  space: DocRepoSpace;
  file: DocRepoFile & {
    markdown: string;
    /** `/<workspace>/-/docs/repo/<owner>/<name>/<path>`. */
    href: string;
    /** The file in Code, on the default branch. */
    code_href: string;
  };
};

/** A page as the sidebar's tree lists it: flat, ordered by `position` within each parent. */
export type DocTreeNode = {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string | null;
  slug: string;
  /** Possibly out of date (see `DocPage.stale`). */
  stale?: boolean;
};

export type DocsSidebarSpace = DocSpace & { pages: DocTreeNode[] };

export type DocsSidebar = {
  spaces: DocsSidebarSpace[];
  favorites: DocPageRef[];
  /** The pages the viewer opened last, newest first. */
  recent: DocPageRef[];
  /** Whether the viewer may make spaces (members of the workspace may). */
  can_create_space: boolean;
  trash_count: number;
  /** Pages the viewer can read that are possibly out of date. */
  stale_count: number;
  /** Projects' docs folders shown in Docs, those whose repository the viewer can read. */
  repos: DocRepoSpace[];
};

export type DocsHome = {
  /** Recently edited pages the viewer can read, newest first. */
  recent: DocPage[];
  /** Pages the viewer made or owns. */
  mine: DocPage[];
  /** Pages possibly out of date, most recently flagged first. */
  stale: DocPage[];
  spaces: DocSpace[];
  /** Every project some space or page is linked to, for the filter. */
  projects: string[];
  /** The project the lists are filtered to, or null. */
  project: string | null;
};

/** A tracked change an agent proposed. `blocks` targets name top-level block ids from `page_markdown`. */
export type DocEditTarget =
  /** Add to the end of the page. */
  | { kind: "append" }
  /** Replace the whole page. */
  | { kind: "document" }
  /** Replace a section: the heading whose text matches (case-insensitive) and everything under it, up to the next heading of the same or a higher level. The new Markdown should include the heading if it is to stay. */
  | { kind: "section"; heading: string }
  /** Replace top-level blocks `from_block` through `to_block`, inclusive (with any blocks nested under them). */
  | { kind: "blocks"; from_block: string; to_block: string };

export type DocSuggestionStatus = "open" | "accepted" | "rejected" | "stale";

export type DocSuggestion = {
  id: string;
  page_id: string;
  /** The agent that suggested it. */
  author: MemberProfile;
  /** The person it acted for. */
  asked_by: MemberProfile | null;
  target: DocEditTarget;
  /** The target's Markdown when it was suggested. */
  before_markdown: string;
  /** What it proposes instead. */
  after_markdown: string;
  /** Why, in a line. */
  note: string | null;
  status: DocSuggestionStatus;
  created_at: string;
  decided_by: MemberProfile | null;
  decided_at: string | null;
  /** The top-level blocks it covers now, so the editor can mark them; empty for an append or when the target is gone. */
  block_ids: string[];
};

export type DocVersionKind = "created" | "edit" | "agent" | "suggestion" | "restore";

export type DocVersion = {
  id: string;
  page_id: string;
  created_at: string;
  /** Everyone whose changes are in it, people and agents. */
  authors: MemberProfile[];
  kind: DocVersionKind;
  /** "Suggested by @inky, accepted by @ana"; "Restored from Oct 3, 14:02". */
  note: string | null;
};

export type DocDiffLine = { op: "same" | "add" | "del"; text: string };

export type DocVersionDetail = DocVersion & {
  markdown: string;
  /** Against the version before it (or nothing, for the first). */
  diff: DocDiffLine[];
};

export type DocPageDetail = {
  page: DocPage;
  space: DocSpace;
  /** The page's ancestors, root first. */
  breadcrumbs: DocPageRef[];
  /** As last saved: the read view, and what the editor shows before the socket connects. */
  markdown: string;
  role: DocRole;
  backlinks: DocPageRef[];
  children: DocPageRef[];
  favorite: boolean;
  /** When the viewer last opened it, before now. */
  last_viewed_at: string | null;
  suggestions: DocSuggestion[];
  /** Code the page cites: from its text and its header. */
  citations: DocCitation[];
  /** The header's "Describes" list. */
  describes: DocDescribes[];
  /** Why it is possibly out of date; null when it isn't. */
  staleness: DocStaleness | null;
};

export type DocSearchHit = DocPageRef & {
  space_name: string;
  /** Text around the match; `[[` and `]]` mark matched words. */
  snippet: string;
  updated_at: string;
  projects: string[];
  /** Set for a file from a project's docs folder (then `id` is `repo:<space>:<path>` and `path` its address in Docs). */
  repo_file?: { repo: string; path: string } | null;
  /** The heading of the passage that matched, when search found one (`mode: "hybrid"`). */
  heading?: string | null;
  /** How it was found: by its words, by meaning (the semantic index), or both. */
  matched?: "words" | "meaning" | "both" | null;
};

export type DocTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Built in (meeting notes, RFC, ...) rather than saved by the workspace. */
  builtin: boolean;
  markdown: string;
  created_by: Principal | null;
};

/** One top-level block, as agents see a page. */
export type DocBlockOutline = {
  id: string;
  /** BlockNote's type: `heading`, `paragraph`, `bulletListItem`, `codeBlock`, `callout`, ... */
  type: string;
  /** For a heading. */
  level: number | null;
  /** The block and anything nested under it. */
  markdown: string;
};

/**
 * What an agent may do on a page, for the person it acts for: read it,
 * suggest changes, edit its body (only in a space whose agents edit), and
 * attach a file it made (whenever the person could edit: a file beside the
 * page changes nothing in it).
 */
export type DocAgentAbilities = { read: boolean; suggest: boolean; edit: boolean; attach: boolean };

export type NewDocSpace = {
  name: string;
  slug?: string | null;
  description?: string | null;
  icon?: string | null;
  kind: DocSpaceKind;
  team?: string | null;
  default_role?: DocRole | null;
  agent_mode?: DocAgentMode | null;
  projects?: string[] | null;
  editors_can_share?: boolean | null;
};

export type DocSpaceChange = Partial<Omit<NewDocSpace, "kind">> & { kind?: DocSpaceKind; archived?: boolean };

export type NewDocPage = {
  space_id: string;
  parent_id?: string | null;
  title?: string | null;
  icon?: string | null;
  /** A built-in template's id (`builtin:<name>`) or a saved one's. */
  template_id?: string | null;
  /** Starting Markdown, when there is no template. */
  markdown?: string | null;
  projects?: string[] | null;
};

export type DocPageChange = {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  projects?: string[];
  /** Member keys (`user:<id>`, `agent:<id>`). */
  owners?: string[];
  /** Replaces the header's "Describes" list (at most 20). */
  describes?: DocDescribes[];
};

/** Where a page goes: under `parent_id` (null for the top of the space), before `before_id` (null for the end). */
export type DocMove = { space_id?: string | null; parent_id: string | null; before_id?: string | null };

export type DocSearchQuery = {
  query: string;
  space_id?: string | null;
  /** `owner/name`: pages linked to it, or in a space linked to it. */
  project?: string | null;
  limit?: number | null;
  /**
   * `words` (the default): titles and text by their words, as you type.
   * `hybrid`: words and meaning (the semantic index) together, each hit
   * with the passage and heading that matched; the Docs search page.
   */
  mode?: "words" | "hybrid" | null;
};

/**
 * The comment operations of the editor's thread store (BlockNote's
 * `RESTYjsThreadStore`), applied by the page's room to the `threads` map in
 * the page's Yjs document, so every open editor sees them at once.
 */
export type DocThreadAction =
  | { op: "create"; body: unknown; metadata?: unknown; page_level?: boolean }
  /** Anchors a thread to the text between two Yjs relative positions (JSON). */
  | { op: "anchor"; thread_id: string; anchor: unknown; head: unknown }
  | { op: "comment"; thread_id: string; body: unknown; metadata?: unknown }
  | { op: "edit_comment"; thread_id: string; comment_id: string; body: unknown; metadata?: unknown }
  | { op: "delete_comment"; thread_id: string; comment_id: string; soft?: boolean }
  | { op: "delete_thread"; thread_id: string }
  | { op: "resolve" | "unresolve"; thread_id: string }
  | { op: "react" | "unreact"; thread_id: string; comment_id: string; emoji: string };

/** A comment thread, as agents and the inbox see it. */
export type DocThread = {
  id: string;
  /** The text it is on; null for a comment on the whole page. */
  quote: string | null;
  resolved: boolean;
  comments: { id: string; author: MemberProfile; text: string; created_at: string }[];
};

/** A file put in a page: served from the usercontent origin. */
export type DocFile = { id: string; url: string; name: string; content_type: string; bytes: number };

/**
 * What a page's live socket carries besides the Yjs protocol (binary
 * frames: y-protocols sync and awareness). These are JSON text frames.
 */
export type DocsLiveEvent =
  | { type: "page.updated"; page: DocPage }
  | { type: "page.archived"; page_id: string }
  | { type: "suggestion.created" | "suggestion.updated"; suggestion: DocSuggestion }
  | { type: "version.created"; version: DocVersion }
  /** Whether it is possibly out of date changed: ask for the page again (what each reader sees of why depends on what they can read). */
  | { type: "page.staleness" }
  /** The viewer's role changed, or their access ended (`role` null). */
  | { type: "access"; role: DocRole | null };

/**
 * Header the site sets on a forwarded live socket and on uploads: the
 * viewer, as JSON. Trusted only because the artifacts service is reachable
 * through service bindings alone.
 */
export const DOCS_VIEWER_HEADER = "x-g1t-docs-viewer";

/** The largest file a page takes, in bytes. */
export const DOC_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The name of the Yjs XML fragment that holds a page's blocks. */
export const DOC_FRAGMENT = "document-store";
/** The name of the Yjs map that holds a page's comment threads. */
export const DOC_THREADS = "threads";

export type DocsApi = {
  // ── The site ─────────────────────────────────────────────────────────

  /** Spaces with their page trees, favorites, recent pages. Makes the General space the first time. */
  sidebar(workspace: string, viewer: User): Promise<Result<DocsSidebar>>;
  home(workspace: string, viewer: User, options?: { project?: string | null }): Promise<Result<DocsHome>>;
  space(workspace: string, spaceSlug: string, viewer: User): Promise<Result<{ space: DocSpace; members: DocSpaceMember[]; pages: DocPage[] }>>;
  /** Every space the viewer can open, archived ones included (never deleted ones), General first. */
  spaces(workspace: string, viewer: User): Promise<Result<DocSpace[]>>;
  createSpace(workspace: string, viewer: User, input: NewDocSpace): Promise<Result<DocSpace>>;
  /** Manage role only. `archived` true or false archives a space or brings it back, the General space too. */
  updateSpace(workspace: string, spaceId: string, viewer: User, change: DocSpaceChange): Promise<Result<DocSpace>>;
  /** Adds, changes (`role`) or removes (`role` null) a member. Manage role only; the last manager stays. */
  setSpaceMember(workspace: string, spaceId: string, viewer: User, member: DocMemberKey, role: DocRole | null): Promise<Result<DocSpaceMember[]>>;

  /** A page, and the viewer's role in it; records the view. Not found when they can't read it. */
  page(workspace: string, pageId: string, viewer: User): Promise<Result<DocPageDetail>>;
  createPage(workspace: string, viewer: User, input: NewDocPage): Promise<Result<DocPage>>;
  updatePage(workspace: string, pageId: string, viewer: User, change: DocPageChange): Promise<Result<DocPage>>;
  /** Edit role in both spaces. Refuses moving a page under itself. */
  movePage(workspace: string, pageId: string, viewer: User, move: DocMove): Promise<Result<DocPage>>;
  duplicatePage(workspace: string, pageId: string, viewer: User): Promise<Result<DocPage>>;
  /** To the trash, with every page under it. */
  archivePage(workspace: string, pageId: string, viewer: User): Promise<Result<DocPage>>;
  restorePage(workspace: string, pageId: string, viewer: User): Promise<Result<DocPage>>;
  /** For good: only from the trash, manage role. */
  deletePage(workspace: string, pageId: string, viewer: User): Promise<Result<boolean>>;
  trash(workspace: string, viewer: User): Promise<Result<DocPage[]>>;
  favorite(workspace: string, pageId: string, viewer: User, on: boolean): Promise<Result<boolean>>;

  search(workspace: string, viewer: User, query: DocSearchQuery): Promise<Result<DocSearchHit[]>>;

  versions(workspace: string, pageId: string, viewer: User): Promise<Result<DocVersion[]>>;
  version(workspace: string, pageId: string, versionId: string, viewer: User): Promise<Result<DocVersionDetail>>;
  /** Makes the page what it was then, as a new version. Edit role. */
  restoreVersion(workspace: string, pageId: string, versionId: string, viewer: User): Promise<Result<DocVersion>>;

  templates(workspace: string, viewer: User): Promise<Result<DocTemplate[]>>;
  /** Saves a page as one of the workspace's templates. */
  saveTemplate(workspace: string, viewer: User, input: { page_id: string; name: string; description?: string | null }): Promise<Result<DocTemplate>>;
  deleteTemplate(workspace: string, templateId: string, viewer: User): Promise<Result<boolean>>;

  exportPage(workspace: string, pageId: string, viewer: User): Promise<Result<{ filename: string; markdown: string }>>;
  /** Every page in a space as Markdown, at paths that follow the tree. */
  exportSpace(workspace: string, spaceId: string, viewer: User): Promise<Result<{ name: string; files: { path: string; markdown: string }[] }>>;

  suggestions(workspace: string, pageId: string, viewer: User): Promise<Result<DocSuggestion[]>>;
  /** Accept (applies it to the live document, attributed to both) or reject. Edit role. */
  decideSuggestion(workspace: string, suggestionId: string, viewer: User, decision: "accept" | "reject"): Promise<Result<DocSuggestion>>;
  acceptAll(workspace: string, pageId: string, viewer: User): Promise<Result<DocSuggestion[]>>;

  /** A comment operation from the editor; comment role (deleting others' comments or threads needs edit). */
  thread(workspace: string, pageId: string, viewer: User, action: DocThreadAction): Promise<Result<unknown>>;
  threads(workspace: string, pageId: string, viewer: User): Promise<Result<DocThread[]>>;

  /** Clears "possibly out of date": the page says what the code does now. Edit role. */
  markCurrent(workspace: string, pageId: string, viewer: User): Promise<Result<boolean>>;
  /** Pages the viewer can read that are possibly out of date, most recently flagged first; `repo` (`owner/name`) narrows to changes there. */
  stalePages(workspace: string, viewer: User, options?: { repo?: string | null }): Promise<Result<DocPage[]>>;

  /**
   * Shows a repository's `docs/` folder and README.md in Docs, read from
   * its default branch. Any member who can read the repository may; the
   * files are read at once and again on every push to the default branch.
   */
  addRepoSpace(workspace: string, viewer: User, repo: string): Promise<Result<DocRepoSpace>>;
  /** Stops showing it. Whoever added it, or a workspace owner. */
  removeRepoSpace(workspace: string, viewer: User, id: string): Promise<Result<boolean>>;
  /** One file of a project's docs, for a viewer who can read the repository; not found otherwise. */
  repoPage(workspace: string, viewer: User, repo: string, path: string): Promise<Result<DocRepoPage>>;
  /**
   * Indexes the workspace's pages and projects' docs for search
   * again, in batches in the background. Workspace owners. True when a run
   * started (false: one is already going).
   */
  reindexDocs(workspace: string, viewer: User): Promise<Result<boolean>>;
};

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

export function docsClient(service: ServiceBinding): DocsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    sidebar: (workspace, viewer) => call("sidebar", { workspace, viewer }),
    home: (workspace, viewer, options) => call("home", { workspace, viewer, project: options?.project ?? null }),
    space: (workspace, spaceSlug, viewer) => call("space", { workspace, space: spaceSlug, viewer }),
    spaces: (workspace, viewer) => call("spaces", { workspace, viewer }),
    createSpace: (workspace, viewer, input) => call("create_space", { workspace, viewer, input }),
    updateSpace: (workspace, spaceId, viewer, change) => call("update_space", { workspace, space_id: spaceId, viewer, change }),
    setSpaceMember: (workspace, spaceId, viewer, member, role) => call("set_space_member", { workspace, space_id: spaceId, viewer, member, role }),
    page: (workspace, pageId, viewer) => call("page", { workspace, page_id: pageId, viewer }),
    createPage: (workspace, viewer, input) => call("create_page", { workspace, viewer, input }),
    updatePage: (workspace, pageId, viewer, change) => call("update_page", { workspace, page_id: pageId, viewer, change }),
    movePage: (workspace, pageId, viewer, move) => call("move_page", { workspace, page_id: pageId, viewer, move }),
    duplicatePage: (workspace, pageId, viewer) => call("duplicate_page", { workspace, page_id: pageId, viewer }),
    archivePage: (workspace, pageId, viewer) => call("archive_page", { workspace, page_id: pageId, viewer }),
    restorePage: (workspace, pageId, viewer) => call("restore_page", { workspace, page_id: pageId, viewer }),
    deletePage: (workspace, pageId, viewer) => call("delete_page", { workspace, page_id: pageId, viewer }),
    trash: (workspace, viewer) => call("trash", { workspace, viewer }),
    favorite: (workspace, pageId, viewer, on) => call("favorite", { workspace, page_id: pageId, viewer, on }),
    search: (workspace, viewer, query) => call("search", { workspace, viewer, query }),
    versions: (workspace, pageId, viewer) => call("versions", { workspace, page_id: pageId, viewer }),
    version: (workspace, pageId, versionId, viewer) => call("version", { workspace, page_id: pageId, version_id: versionId, viewer }),
    restoreVersion: (workspace, pageId, versionId, viewer) => call("restore_version", { workspace, page_id: pageId, version_id: versionId, viewer }),
    templates: (workspace, viewer) => call("templates", { workspace, viewer }),
    saveTemplate: (workspace, viewer, input) => call("save_template", { workspace, viewer, input }),
    deleteTemplate: (workspace, templateId, viewer) => call("delete_template", { workspace, template_id: templateId, viewer }),
    exportPage: (workspace, pageId, viewer) => call("export_page", { workspace, page_id: pageId, viewer }),
    exportSpace: (workspace, spaceId, viewer) => call("export_space", { workspace, space_id: spaceId, viewer }),
    suggestions: (workspace, pageId, viewer) => call("suggestions", { workspace, page_id: pageId, viewer }),
    decideSuggestion: (workspace, suggestionId, viewer, decision) => call("decide_suggestion", { workspace, suggestion_id: suggestionId, viewer, decision }),
    acceptAll: (workspace, pageId, viewer) => call("accept_all", { workspace, page_id: pageId, viewer }),
    thread: (workspace, pageId, viewer, action) => call("thread", { workspace, page_id: pageId, viewer, action }),
    threads: (workspace, pageId, viewer) => call("threads", { workspace, page_id: pageId, viewer }),
    markCurrent: (workspace, pageId, viewer) => call("mark_current", { workspace, page_id: pageId, viewer }),
    stalePages: (workspace, viewer, options) => call("stale_pages", { workspace, viewer, repo: options?.repo ?? null }),
    addRepoSpace: (workspace, viewer, repo) => call("add_repo_space", { workspace, viewer, repo }),
    removeRepoSpace: (workspace, viewer, id) => call("remove_repo_space", { workspace, viewer, id }),
    repoPage: (workspace, viewer, repo, path) => call("repo_page", { workspace, viewer, repo, path }),
    reindexDocs: (workspace, viewer) => call("reindex_docs", { workspace, viewer }),
  };
}
