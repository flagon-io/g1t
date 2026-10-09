/**
 * Folios: what people call artifacts. Artifacts mode is one mode for docs,
 * slides, designs and dashboards, each private, shared with people and
 * agents, in a space or open to the workspace, and edited live together.
 * Kept by the docs service (`services/docs`). Plan and decisions:
 * docs/ARTIFACTS_MODE.md.
 *
 * Naming: code says "folio", people see "artifact" (UI text, URLs
 * `/<ws>/-/artifacts/...`, the `artifact` MCP tool, REST paths, the
 * `artifacts:*` scopes). The Cloudflare Artifacts git store and workflow
 * run artifacts are something else and keep their names.
 *
 * Wire shapes are snake_case end to end. Each kind's own model is in its
 * own file: folios-slides.ts, folios-design.ts, folios-dashboard.ts.
 * `crates/contracts/src/folios.rs` mirrors what the Rust API needs, and a
 * Rust test runs both validators over `folios.fixtures.json`.
 *
 * Access, in one place (section 2.1 of the plan):
 *
 * - Every folio has one owner, always a person, who has `manage`.
 * - It sits in a space, or in its owner's Private section (`space` null).
 * - A person's role is the highest of: owner; explicit grants on it or an
 *   ancestor it inherits from; their space role when it inherits up to a
 *   folio in a space; and the general access of its access root
 *   (`workspace`: every member; `link`: members who opened the link).
 * - `inherit: false` makes a folio its own access root ("Only people
 *   invited"). "Private" (the lock) is computed: only the owner can read it.
 * - An agent's role is never higher than its asker's, narrowed to what
 *   every person in the audience can read.
 */
import type { MemberProfile } from "./chat";
import type { ServiceBinding } from "./clients";
import type { DatasetQuery, DatasetResult } from "./datasets";
import type {
  DocAgentAbilities,
  DocAgentMode,
  DocAudience,
  DocBlockOutline,
  DocDiffLine,
  DocEditTarget,
  DocRepoSpace,
  DocRole,
  DocSpace,
  DocSpaceKind,
  DocSuggestion,
  DocThread,
  DocThreadAction,
} from "./docs";
import type { DashboardOp, DashboardPreview } from "./folios-dashboard";
import type { DesignOp, DesignPreview } from "./folios-design";
import type { SlidesOp, SlidesPreview } from "./folios-slides";
import type { User } from "./identity";
import type { Result } from "./result";

// ── Kinds ─────────────────────────────────────────────────────────────

export type FolioKind = "doc" | "slides" | "design" | "dashboard";
export const FOLIO_KINDS: readonly FolioKind[] = ["doc", "slides", "design", "dashboard"];

/** The kinds as the Artifacts home's tiles name them. */
export const FOLIO_KIND_LABELS: Record<FolioKind, string> = {
  doc: "Docs",
  slides: "Slides",
  design: "Design",
  dashboard: "Dashboard",
};

/** One of a kind, in a sentence: "a doc", "a deck"... */
export const FOLIO_KIND_NOUNS: Record<FolioKind, string> = {
  doc: "doc",
  slides: "deck",
  design: "design",
  dashboard: "dashboard",
};

export function isFolioKind(value: unknown): value is FolioKind {
  return typeof value === "string" && (FOLIO_KINDS as readonly string[]).includes(value);
}

/** Only a doc holds other folios: a doc with children is the folder. */
export function folioCanHaveChildren(kind: FolioKind): boolean {
  return kind === "doc";
}

// ── Roles and access ──────────────────────────────────────────────────

/** What someone may do with a folio, weakest first. The same roles as a space's. */
export type FolioRole = DocRole;
export const FOLIO_ROLES: readonly FolioRole[] = ["view", "comment", "edit", "manage"];

/** Who may open a folio besides its owner, grants and space. */
export type FolioGeneralAccess = "none" | "workspace" | "link";
export const FOLIO_GENERAL_ACCESS: readonly FolioGeneralAccess[] = ["none", "workspace", "link"];

export const FOLIO_GENERAL_ACCESS_LABELS: Record<FolioGeneralAccess, string> = {
  none: "Restricted",
  workspace: "Everyone in the workspace",
  link: "Anyone in the workspace with the link",
};

/** General access never gives `manage`. */
export type FolioGeneralRole = Exclude<FolioRole, "manage">;
export const FOLIO_GENERAL_ROLES: readonly FolioGeneralRole[] = ["view", "comment", "edit"];

/** Space kinds as Artifacts names them (the database keeps workspace / team / private). */
export const FOLIO_SPACE_KIND_LABELS: Record<DocSpaceKind, string> = {
  workspace: "Open",
  team: "Team",
  private: "Members only",
};

/** Who a grant names: `user:<id>`, `agent:<id>` or `team:<slug>`. */
export type FolioPrincipal = string;

const PRINCIPAL = /^(user|agent|team):[A-Za-z0-9_.-]{1,64}$/;

export function isFolioPrincipal(value: unknown): value is FolioPrincipal {
  return typeof value === "string" && PRINCIPAL.test(value);
}

/** The deepest a folio tree goes. */
export const FOLIO_MAX_DEPTH = 10;
/** The longest title, in characters. */
export const FOLIO_MAX_TITLE = 200;
/** The most people a folio is shared with in one change. */
export const FOLIO_MAX_SHARE = 50;
/** A subtree larger than this has its access rebuilt by a queue job, not inline. */
export const FOLIO_INLINE_REACL = 2_000;

// ── Addresses ─────────────────────────────────────────────────────────

const FOLIO_ID = /(fol_[0-9a-hjkmnp-tv-z]{26})$/;

/** The words of a title as an address: `q4-roadmap`. At most 50 characters. */
export function folioTitleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** A folio's last address segment, `<title-slug>-<id>`: only the id is read, so renames keep links working. */
export function folioSlug(title: string, id: string): string {
  const words = folioTitleSlug(title);
  return words ? `${words}-${id}` : id;
}

/** A folio's address. Flat: moving it between spaces and Private never breaks a link. */
export function folioPath(workspace: string, title: string, id: string): string {
  return `/${workspace}/-/artifacts/${folioSlug(title, id)}`;
}

/** The folio id at the end of an address segment, or null. */
export function folioIdFrom(segment: string | null | undefined): string | null {
  return FOLIO_ID.exec(String(segment ?? ""))?.[1] ?? null;
}

/** Every folio id a text links to, for backlinks. */
export function linkedFolioIds(text: string): string[] {
  return [...new Set(text.match(/fol_[0-9a-hjkmnp-tv-z]{26}/g) ?? [])];
}

/** Segments the site's routes use under `-/artifacts/`: never a folio. */
export const FOLIO_ROUTE_SEGMENTS: readonly string[] = ["live", "api", "query", "threads", "upload", "export", "new", "templates", "trash", "stale", "spaces", "repo"];

// ── Folios ────────────────────────────────────────────────────────────

/** Enough to link to a folio. */
export type FolioRef = {
  id: string;
  kind: FolioKind;
  title: string;
  /** An emoji, or null for the kind's icon. */
  icon: string | null;
  /** `<title-slug>-<id>`. */
  slug: string;
  /** `/<ws>/-/artifacts/<slug>`. */
  path: string;
};

/** The space a folio sits in. */
export type FolioSpaceRef = { id: string; slug: string; name: string; kind: DocSpaceKind };

/** Where a folio's access comes from when it inherits. */
export type FolioInheritedFrom = { kind: "space" | "folio"; id: string; name: string };

/** What a card draws: written when the folio is saved, never data values. */
export type FolioPreview = { kind: "doc"; lines: string[] } | SlidesPreview | DesignPreview | DashboardPreview;

/** A folio as lists and its page show it, for one viewer. */
export type Folio = FolioRef & {
  workspace_id: string;
  /** Null: its owner's Private section. */
  space: FolioSpaceRef | null;
  parent_id: string | null;
  position: number;
  owner: MemberProfile;
  created_by: MemberProfile;
  created_at: string;
  /** Any change: rename, move, share. */
  updated_at: string;
  /** Content changes: "Edited 45m ago". */
  edited_by: MemberProfile | null;
  edited_at: string;
  trashed_at: string | null;
  viewer_role: FolioRole;
  favorite: boolean;
  /** Only its owner can read it (the lock). */
  private: boolean;
  /** How many people, agents and teams it is shared with directly. */
  shared_count: number;
  /** The access root's general access. */
  general_access: FolioGeneralAccess;
  general_role: FolioGeneralRole | null;
  /** False: "Only people invited", its own access root. */
  inherit: boolean;
  inherited_from: FolioInheritedFrom | null;
  /** How agents change it: its own, else its space's, else `suggest`. */
  agent_mode: DocAgentMode;
  excerpt: string;
  preview: FolioPreview | null;
  /** Where it was written up from, such as a chat thread, when it was. */
  source: { title: string; href: string } | null;
  /** Possibly out of date: code it cites changed. */
  stale: boolean;
  has_children: boolean;
};

/** A row of the sidebar's trees. */
export type FolioTreeNode = {
  id: string;
  kind: FolioKind;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string | null;
  slug: string;
  /** It restricts access below where it sits (a lock on the row). */
  restricted: boolean;
  stale?: boolean;
};

export type FolioListTab = "all" | "yours" | "shared";
export const FOLIO_LIST_TABS: readonly FolioListTab[] = ["all", "yours", "shared"];

export type FolioListQuery = {
  tab: FolioListTab;
  kinds?: FolioKind[] | null;
  space_id?: string | null;
  /** A member key, `user:<id>`. */
  owner?: string | null;
  /** `owner/name`. */
  project?: string | null;
  /** Words or meaning; hybrid search when given. */
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
};

/** The most folios a page of a list holds. */
export const FOLIO_LIST_MAX = 100;

export type FolioList = { items: Folio[]; next_cursor: string | null };

/** A folio as its own page opens it: the folio, its saved text, where it sits, what is in it and what links to it. */
export type FolioPage = {
  folio: Folio;
  /** Its text rendition when last saved (a doc's Markdown): what shows until the live editor loads. */
  text: string;
  /** The docs it sits under, from the top, that the viewer can read. */
  breadcrumbs: FolioRef[];
  /** What sits under it (a doc's sub-pages) that the viewer can read. */
  children: FolioRef[];
  /** Folios the viewer can read that link to it. */
  backlinks: FolioRef[];
  /** A doc's open suggestions. */
  suggestions: FolioSuggestion[];
};

export type FoliosSidebarSpace = DocSpace & { joined: boolean; tree: FolioTreeNode[] };

export type FoliosSidebar = {
  favorites: FolioRef[];
  /** Joined open spaces, the viewer's team spaces and Members-only spaces. */
  spaces: FoliosSidebarSpace[];
  /** The viewer's own folios in no space. */
  private_tree: FolioTreeNode[];
  /** The tops of what is shared with the viewer: the highest ancestor they can read. */
  shared: FolioRef[];
  /** Projects' docs: repositories' `docs/` folders, read-only. */
  repos: DocRepoSpace[];
  can_create_space: boolean;
  trash_count: number;
  stale_count: number;
};

/** Content to start a folio with: Markdown for docs and slides, a spec for designs and dashboards. */
export type FolioContentInput = { markdown: string } | { spec: unknown };

export type NewFolio = {
  kind: FolioKind;
  title?: string | null;
  icon?: string | null;
  /** Null or absent: the creator's Private section. */
  space_id?: string | null;
  /** A doc to sit under. */
  parent_id?: string | null;
  template_id?: string | null;
  content?: FolioContentInput | null;
  source?: { title: string; href: string } | null;
  share_with?: { principal: FolioPrincipal; role: FolioRole }[] | null;
};

export type FolioChange = {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  projects?: string[];
};

/** Where to put a folio: a space (null: Private) and a parent doc, before a sibling or last. */
export type FolioMove = { space_id: string | null; parent_id: string | null; before_id?: string | null };

// ── Sharing ───────────────────────────────────────────────────────────

/** Where a row of "Who has access" comes from. */
export type FolioAccessSource =
  | { kind: "owner" }
  /** A grant on this folio: editable here. */
  | { kind: "grant" }
  /** A grant on a parent it inherits from: change it there. */
  | { kind: "folio"; id: string; title: string; path: string }
  /** The space it inherits from. */
  | { kind: "space"; id: string; name: string };

export type FolioAccessRow = {
  principal: FolioPrincipal;
  /** A person or agent; a team is shown by name. */
  profile: MemberProfile | { kind: "team"; id: string; name: string; display_name: string };
  role: FolioRole;
  source: FolioAccessSource;
};

/** The share dialog. */
export type FolioAccessList = {
  folio_id: string;
  owner: MemberProfile;
  rows: FolioAccessRow[];
  general_access: FolioGeneralAccess;
  general_role: FolioGeneralRole | null;
  inherit: boolean;
  inherited_from: FolioInheritedFrom | null;
  /** The folio's own setting; null follows its space's. */
  agent_mode: DocAgentMode | null;
  /** The viewer may change any of it. */
  can_share: boolean;
  /** Public links are off until a workspace turns them on (later). */
  public_link: "off";
};

/** One change from the share dialog. */
export type FolioAccessChange =
  /** Share with someone, or change their role; `notify` is an optional message. */
  | { op: "grant"; principal: FolioPrincipal; role: FolioRole; notify?: string | null }
  | { op: "revoke"; principal: FolioPrincipal }
  /** `none` takes no role; `workspace` and `link` take one, never `manage`. */
  | { op: "general"; access: FolioGeneralAccess; role: FolioGeneralRole | null }
  /** Follow the space or parent (true), or "Only people invited" (false). */
  | { op: "inherit"; inherit: boolean }
  | { op: "agent_mode"; agent_mode: DocAgentMode | null };

// ── History, proposals, templates ─────────────────────────────────────

export type FolioVersionKind = "created" | "edit" | "agent" | "suggestion" | "proposal" | "restore";

export type FolioVersion = {
  id: string;
  folio_id: string;
  created_at: string;
  authors: MemberProfile[];
  kind: FolioVersionKind;
  note: string | null;
};

export type FolioVersionDetail = FolioVersion & {
  /** The folio's text rendition then. */
  text: string;
  /** Against the version before it. */
  diff: DocDiffLine[];
};

export type FolioProposalStatus = "open" | "accepted" | "rejected" | "stale";

/** An agent's whole change to a slides deck, design or dashboard, which a person previews and applies or rejects. */
export type FolioProposal = {
  id: string;
  folio_id: string;
  author: MemberProfile;
  asked_by: MemberProfile | null;
  note: string | null;
  /** "Adds slides 4–6; rewrites the title slide". */
  summary: string;
  status: FolioProposalStatus;
  created_at: string;
  decided_by: MemberProfile | null;
  decided_at: string | null;
};

/** A doc's tracked change, as Docs has them, on a folio. */
export type FolioSuggestion = Omit<DocSuggestion, "page_id"> & { folio_id: string };

export type FolioTemplate = {
  id: string;
  kind: FolioKind;
  name: string;
  description: string;
  icon: string | null;
  builtin: boolean;
  /** Markdown (doc, slides) or a JSON spec (design, dashboard). */
  body: string;
  created_by: MemberProfile | null;
};

// ── Live ──────────────────────────────────────────────────────────────

/** JSON text frames on a folio's socket, besides the Yjs protocol's binary ones. */
export type FoliosLiveEvent =
  | { type: "folio.updated"; folio: Folio }
  | { type: "folio.trashed"; folio_id: string }
  | { type: "suggestion.created" | "suggestion.updated"; suggestion: FolioSuggestion }
  | { type: "proposal.created" | "proposal.updated"; proposal: FolioProposal }
  | { type: "version.created"; version: FolioVersion }
  /** Whether it is possibly out of date changed: ask again. */
  | { type: "folio.staleness" }
  /** Its sharing changed: ask for the access list again to refresh badges. */
  | { type: "folio.access" }
  /** The viewer's role changed, or their access ended (`role` null; the socket then closes with 4403). */
  | { type: "access"; role: FolioRole | null };

// ── Agents ────────────────────────────────────────────────────────────

/** Who will see what an agent says. More than 20 people reads as the workspace. */
export type FolioAudience = DocAudience;

export type FolioAgentAbilities = DocAgentAbilities;

/** Options on any agent edit. */
export type FolioEditOptions = {
  note?: string | null;
  /** Never edit directly: file a suggestion (doc) or a proposal (others). */
  suggest_only?: boolean | null;
  /** The edit brings it up to date with the code it cites. */
  marks_current?: boolean | null;
};

/** An agent's (or a token's) change to a folio, in the kind's own terms. */
export type FolioAgentEdit = (
  | { kind: "doc"; target: DocEditTarget; markdown: string }
  | { kind: "slides"; ops: SlidesOp[] }
  | { kind: "design"; ops: DesignOp[] }
  | { kind: "dashboard"; ops: DashboardOp[] }
) &
  FolioEditOptions;

/** The most ops one edit carries. */
export const FOLIO_MAX_OPS = 200;

export type FolioAgentEditResult =
  | { mode: "applied"; version_id: string | null; folio: FolioRef; summary: string }
  | { mode: "suggested"; suggestion: FolioSuggestion; folio: FolioRef }
  | { mode: "proposed"; proposal: FolioProposal; folio: FolioRef };

/**
 * A folio in the form an agent reads and writes: a doc's Markdown with its
 * block ids; a deck's Markdown with slide ids; a design's node spec; a
 * dashboard's spec (tiles and queries, never values).
 */
export type FolioAgentRead = {
  folio: FolioRef & { edited_at: string };
  space: { id: string; slug: string; name: string; agent_mode: DocAgentMode } | null;
  /** Markdown for doc and slides; JSON text for design and dashboard. */
  content: string;
  /** doc: top-level blocks, for `blocks` targets. */
  blocks?: DocBlockOutline[];
  can: FolioAgentAbilities;
  /** False: someone the agent is talking to can't read it, so don't quote it there. */
  audience_can_read: boolean;
};

/** One passage recalled for an agent: part of a folio, or of a repository's docs. */
export type FolioPassage = {
  folio: FolioRef | null;
  repo_file: { repo: string; path: string; href: string } | null;
  space_name: string;
  heading: string | null;
  text: string;
  score: number;
  updated_at: string;
  stale: boolean;
};

export type FolioSearchHit = FolioRef & {
  space_name: string | null;
  snippet: string;
  edited_at: string;
  heading?: string | null;
  matched?: "words" | "meaning" | "both" | null;
};

// ── Validators (pure; mirrored in Rust) ───────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isRole = (value: unknown): value is FolioRole => typeof value === "string" && (FOLIO_ROLES as readonly string[]).includes(value);

/** What is wrong with a new folio, or null. Whether its space and parent exist and allow it is the service's to say. */
export function newFolioError(input: NewFolio): string | null {
  if (!isFolioKind(input.kind)) return `There is no kind of artifact called ${String(input.kind)}.`;
  const title = input.title ?? "";
  if ([...title].length > FOLIO_MAX_TITLE) return `A title is at most ${FOLIO_MAX_TITLE} characters.`;
  const content = input.content ?? null;
  if (content !== null) {
    const wantsMarkdown = input.kind === "doc" || input.kind === "slides";
    if (wantsMarkdown && typeof (content as { markdown?: unknown }).markdown !== "string") return `A ${FOLIO_KIND_NOUNS[input.kind]} starts from markdown.`;
    if (!wantsMarkdown && !isObject((content as { spec?: unknown }).spec)) return `A ${FOLIO_KIND_NOUNS[input.kind]} starts from a spec.`;
    if (input.template_id != null) return "Start from a template or from content, not both.";
  }
  const share = input.share_with ?? [];
  if (share.length > FOLIO_MAX_SHARE) return `Share with at most ${FOLIO_MAX_SHARE} at once.`;
  for (const row of share) {
    if (!isFolioPrincipal(row.principal)) return `${String(row.principal)} is not user:, agent: or team: and an id.`;
    if (!isRole(row.role)) return `There is no role called ${String(row.role)}.`;
  }
  return null;
}

/** What is wrong with a change from the share dialog, or null. */
export function folioAccessChangeError(change: FolioAccessChange): string | null {
  switch (change.op) {
    case "grant":
      if (!isFolioPrincipal(change.principal)) return `${String(change.principal)} is not user:, agent: or team: and an id.`;
      if (!isRole(change.role)) return `There is no role called ${String(change.role)}.`;
      if (change.notify != null && [...change.notify].length > 2_000) return "A message is at most 2000 characters.";
      return null;
    case "revoke":
      return isFolioPrincipal(change.principal) ? null : `${String(change.principal)} is not user:, agent: or team: and an id.`;
    case "general":
      if (!(FOLIO_GENERAL_ACCESS as readonly string[]).includes(change.access)) return `There is no general access called ${String(change.access)}.`;
      if (change.access === "none") return change.role === null ? null : "Restricted takes no role.";
      if (change.role === null) return `${FOLIO_GENERAL_ACCESS_LABELS[change.access]} needs a role.`;
      return (FOLIO_GENERAL_ROLES as readonly string[]).includes(change.role) ? null : "General access gives view, comment or edit, never full access.";
    case "inherit":
      return typeof change.inherit === "boolean" ? null : "inherit is true or false.";
    case "agent_mode":
      return change.agent_mode === null || change.agent_mode === "suggest" || change.agent_mode === "edit" ? null : "agent_mode is suggest, edit or null.";
    default:
      return `There is no access change called ${String((change as { op?: unknown }).op)}.`;
  }
}

/**
 * What is wrong with an agent edit's envelope, or null: its kind, and a
 * doc's target and Markdown or the other kinds' list of ops. Each op is
 * checked by its kind's validator (`slidesOpError`, `designOpError`,
 * `dashboardOpError`).
 */
export function folioAgentEditError(edit: unknown): string | null {
  if (!isObject(edit)) return "An edit is an object.";
  if (!isFolioKind(edit.kind)) return `There is no kind of artifact called ${String(edit.kind)}.`;
  if (edit.note != null && typeof edit.note !== "string") return "note is text.";
  if (edit.kind === "doc") {
    if (typeof edit.markdown !== "string") return "A doc edit has markdown.";
    if (edit.ops !== undefined) return "A doc edit has a target and markdown, not ops.";
    const target = edit.target;
    if (!isObject(target)) return "A doc edit has a target.";
    switch (target.kind) {
      case "append":
      case "document":
        return null;
      case "section":
        return typeof target.heading === "string" && target.heading.length > 0 ? null : "A section target names its heading.";
      case "blocks":
        return typeof target.from_block === "string" && typeof target.to_block === "string" ? null : "A blocks target names from_block and to_block.";
      default:
        return "A doc edit's target is append, document, section or blocks.";
    }
  }
  if (edit.markdown !== undefined || edit.target !== undefined) return `A ${FOLIO_KIND_NOUNS[edit.kind]} edit has ops, not a target and markdown.`;
  if (!Array.isArray(edit.ops) || edit.ops.length === 0) return `A ${FOLIO_KIND_NOUNS[edit.kind]} edit has a list of ops.`;
  if (edit.ops.length > FOLIO_MAX_OPS) return `An edit has at most ${FOLIO_MAX_OPS} ops.`;
  return edit.ops.every((op) => isObject(op) && typeof op.op === "string") ? null : "Each op is an object with an op.";
}

/** What is wrong with a list query, or null. */
export function folioListQueryError(query: FolioListQuery): string | null {
  if (!(FOLIO_LIST_TABS as readonly string[]).includes(query.tab)) return "tab is all, yours or shared.";
  for (const kind of query.kinds ?? []) if (!isFolioKind(kind)) return `There is no kind of artifact called ${String(kind)}.`;
  const limit = query.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > FOLIO_LIST_MAX)) return `limit is between 1 and ${FOLIO_LIST_MAX}.`;
  return null;
}

// ── The docs service's folio RPC ──────────────────────────────────────

/** Every method the docs service answers for folios at `/rpc/<method>` (plan section 7). */
export const FOLIO_RPC_METHODS = [
  // Lists and navigation.
  "folio_list",
  "folio_sidebar",
  "folio",
  "folio_page",
  // Changing folios.
  "create_folio",
  "update_folio",
  "move_folio",
  "duplicate_folio",
  "trash_folio",
  "restore_folio",
  "delete_folio",
  "folio_trash",
  "favorite_folio",
  // A person's (or a token's) own read and edit in the agent form.
  "folio_content",
  "edit_folio",
  // Sharing and spaces.
  "folio_access",
  "set_folio_grant",
  "set_folio_general_access",
  "request_folio_access",
  "join_space",
  "leave_space",
  // Search, history, templates and export.
  "search_folios",
  "folio_versions",
  "folio_version",
  "restore_folio_version",
  "folio_templates",
  "save_folio_template",
  "delete_folio_template",
  "export_folio",
  // Suggestions, proposals and comments.
  "folio_suggestions",
  "decide_folio_suggestion",
  "folio_proposals",
  "decide_folio_proposal",
  "folio_thread",
  "folio_threads",
  // Dashboards.
  "query_tile",
  "query_dataset",
  "query_dataset_for_agent",
  // Agents.
  "folios_for_agent",
  "read_folio_for_agent",
  "create_folio_as_agent",
  "edit_folio_as_agent",
  "share_folio_as_agent",
  "recall_folios_for_agent",
  "stale_folios_for_agent",
  "mark_folio_current",
  "reindex_folios",
] as const;

export type FolioRpcMethod = (typeof FOLIO_RPC_METHODS)[number];

export type FoliosApi = {
  // ── The site, and the API acting for a person ───────────────────────
  list(workspace: string, viewer: User, query: FolioListQuery): Promise<Result<FolioList>>;
  sidebar(workspace: string, viewer: User): Promise<Result<FoliosSidebar>>;
  /**
   * A folio and the viewer's role in it; records the visit (which is what
   * makes a link folio readable). Not found when they can't read it. A
   * `peek` (chat's card for a link) records nothing, so it finds a link
   * folio only once they have opened it, and never one in the trash.
   */
  folio(workspace: string, viewer: User, folioId: string, options?: { peek?: boolean }): Promise<Result<Folio>>;
  /** As `folio`, with what its page shows around it. Records the visit too. */
  page(workspace: string, viewer: User, folioId: string): Promise<Result<FolioPage>>;
  create(workspace: string, viewer: User, input: NewFolio): Promise<Result<Folio>>;
  update(workspace: string, viewer: User, folioId: string, change: FolioChange): Promise<Result<Folio>>;
  /** Edit role where it is and where it goes. Refuses moving under itself, under a non-doc, or deeper than `FOLIO_MAX_DEPTH`. */
  move(workspace: string, viewer: User, folioId: string, move: FolioMove): Promise<Result<Folio>>;
  duplicate(workspace: string, viewer: User, folioId: string): Promise<Result<Folio>>;
  /** To the trash, with everything under it. */
  trash(workspace: string, viewer: User, folioId: string): Promise<Result<Folio>>;
  restore(workspace: string, viewer: User, folioId: string): Promise<Result<Folio>>;
  /** For good: only from the trash, manage role. */
  delete(workspace: string, viewer: User, folioId: string): Promise<Result<boolean>>;
  trashed(workspace: string, viewer: User): Promise<Result<Folio[]>>;
  favorite(workspace: string, viewer: User, folioId: string, on: boolean): Promise<Result<boolean>>;
  /** The folio in its agent form, for a person or their token. */
  content(workspace: string, viewer: User, folioId: string): Promise<Result<FolioAgentRead>>;
  /** Applies an edit in the kind's terms as the viewer: edit role, else a suggestion or proposal with comment role. */
  edit(workspace: string, viewer: User, folioId: string, edit: FolioAgentEdit): Promise<Result<FolioAgentEditResult>>;

  access(workspace: string, viewer: User, folioId: string): Promise<Result<FolioAccessList>>;
  /** One change from the share dialog: grants go to `set_folio_grant`, the rest to `set_folio_general_access`. */
  changeAccess(workspace: string, viewer: User, folioId: string, change: FolioAccessChange): Promise<Result<FolioAccessList>>;
  /** Asks the owner and managers for access; they get an inbox item. */
  requestAccess(workspace: string, viewer: User, folioId: string, message?: string | null): Promise<Result<boolean>>;
  joinSpace(workspace: string, viewer: User, spaceId: string): Promise<Result<boolean>>;
  leaveSpace(workspace: string, viewer: User, spaceId: string): Promise<Result<boolean>>;

  search(workspace: string, viewer: User, query: { q: string; kinds?: FolioKind[] | null; space_id?: string | null; project?: string | null; owner?: string | null; mode?: "words" | "hybrid" | null; limit?: number | null }): Promise<Result<FolioSearchHit[]>>;
  versions(workspace: string, viewer: User, folioId: string): Promise<Result<FolioVersion[]>>;
  version(workspace: string, viewer: User, folioId: string, versionId: string): Promise<Result<FolioVersionDetail>>;
  restoreVersion(workspace: string, viewer: User, folioId: string, versionId: string): Promise<Result<FolioVersion>>;
  templates(workspace: string, viewer: User, kind?: FolioKind | null): Promise<Result<FolioTemplate[]>>;
  saveTemplate(workspace: string, viewer: User, input: { folio_id: string; name: string; description?: string | null }): Promise<Result<FolioTemplate>>;
  deleteTemplate(workspace: string, viewer: User, templateId: string): Promise<Result<boolean>>;
  export(workspace: string, viewer: User, folioId: string, format?: "markdown" | "json" | null): Promise<Result<{ filename: string; content_type: string; body: string }>>;

  suggestions(workspace: string, viewer: User, folioId: string): Promise<Result<FolioSuggestion[]>>;
  decideSuggestion(workspace: string, viewer: User, suggestionId: string, decision: "accept" | "reject"): Promise<Result<FolioSuggestion>>;
  proposals(workspace: string, viewer: User, folioId: string): Promise<Result<FolioProposal[]>>;
  decideProposal(workspace: string, viewer: User, proposalId: string, decision: "accept" | "reject"): Promise<Result<FolioProposal>>;
  thread(workspace: string, viewer: User, folioId: string, action: DocThreadAction): Promise<Result<unknown>>;
  threads(workspace: string, viewer: User, folioId: string): Promise<Result<DocThread[]>>;

  /** A dashboard tile's numbers for the viewer: the tile's query, read from the room. */
  queryTile(workspace: string, viewer: User, folioId: string, tileId: string): Promise<Result<DatasetResult>>;
  /** A query as the viewer, for the API. */
  queryDataset(workspace: string, viewer: User, query: DatasetQuery): Promise<Result<DatasetResult>>;

  // ── Agents (services/agents) ────────────────────────────────────────
  //
  // Each takes the agent and the person it acts for (`viewer`). The agent
  // never reads or changes more than that person can, narrowed to what
  // everyone in `audience` can read. A folio it may not read is not found.

  foliosForAgent(workspace: string, agentId: string, viewer: User, query: FolioListQuery, audience?: FolioAudience | null): Promise<Result<FolioList>>;
  readForAgent(workspace: string, agentId: string, viewer: User, folioId: string, audience?: FolioAudience | null): Promise<Result<FolioAgentRead>>;
  /**
   * A new folio: the viewer owns it, the agent made it and gets `edit` on
   * it. `where` is a space the viewer can edit, `private`, or
   * `conversation` (Private plus `view` for these people).
   */
  createAsAgent(
    workspace: string,
    agentId: string,
    viewer: User,
    input: { kind: FolioKind; title: string; content?: FolioContentInput | null; template_id?: string | null; where: { space_id: string } | "private" | { conversation: string[] }; parent_id?: string | null; source?: { title: string; href: string } | null },
  ): Promise<Result<FolioRef>>;
  editAsAgent(workspace: string, agentId: string, viewer: User, folioId: string, edit: FolioAgentEdit): Promise<Result<FolioAgentEditResult>>;
  /** `view` or `comment` for people already in the conversation, when the viewer has `manage`. Never general access, `edit` or `manage`. */
  shareAsAgent(workspace: string, agentId: string, viewer: User, folioId: string, input: { user_ids: string[]; role: "view" | "comment" }, audience: FolioAudience): Promise<Result<FolioAccessList>>;
  recallForAgent(workspace: string, agentId: string, viewer: User, input: { query: string; limit?: number | null; spaces?: string[] | null; kinds?: FolioKind[] | null }, audience?: FolioAudience | null): Promise<Result<FolioPassage[]>>;
  staleForAgent(workspace: string, agentId: string, viewer: User, options?: { repo?: string | null; since?: string | null }, audience?: FolioAudience | null): Promise<Result<Folio[]>>;
  /** As the asker narrowed to repositories every audience member can read; spend only when the audience is the asker alone. */
  queryDatasetForAgent(workspace: string, agentId: string, viewer: User, input: { query: DatasetQuery } | { folio_id: string; tile_id: string }, audience?: FolioAudience | null): Promise<Result<DatasetResult>>;
  markCurrent(workspace: string, viewer: User, folioId: string): Promise<Result<boolean>>;
  /** Indexes the workspace's folios again in the background. Workspace owners. */
  reindex(workspace: string, viewer: User): Promise<Result<boolean>>;
};

export function foliosClient(service: ServiceBinding): FoliosApi {
  const call = async <T>(method: FolioRpcMethod, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    list: (workspace, viewer, query) => call("folio_list", { workspace, viewer, query }),
    sidebar: (workspace, viewer) => call("folio_sidebar", { workspace, viewer }),
    folio: (workspace, viewer, folioId, options) => call("folio", { workspace, viewer, folio_id: folioId, ...(options?.peek ? { peek: true } : {}) }),
    page: (workspace, viewer, folioId) => call("folio_page", { workspace, viewer, folio_id: folioId }),
    create: (workspace, viewer, input) => call("create_folio", { workspace, viewer, input }),
    update: (workspace, viewer, folioId, change) => call("update_folio", { workspace, viewer, folio_id: folioId, change }),
    move: (workspace, viewer, folioId, move) => call("move_folio", { workspace, viewer, folio_id: folioId, move }),
    duplicate: (workspace, viewer, folioId) => call("duplicate_folio", { workspace, viewer, folio_id: folioId }),
    trash: (workspace, viewer, folioId) => call("trash_folio", { workspace, viewer, folio_id: folioId }),
    restore: (workspace, viewer, folioId) => call("restore_folio", { workspace, viewer, folio_id: folioId }),
    delete: (workspace, viewer, folioId) => call("delete_folio", { workspace, viewer, folio_id: folioId }),
    trashed: (workspace, viewer) => call("folio_trash", { workspace, viewer }),
    favorite: (workspace, viewer, folioId, on) => call("favorite_folio", { workspace, viewer, folio_id: folioId, on }),
    content: (workspace, viewer, folioId) => call("folio_content", { workspace, viewer, folio_id: folioId }),
    edit: (workspace, viewer, folioId, edit) => call("edit_folio", { workspace, viewer, folio_id: folioId, edit }),
    access: (workspace, viewer, folioId) => call("folio_access", { workspace, viewer, folio_id: folioId }),
    changeAccess: (workspace, viewer, folioId, change) =>
      call(change.op === "grant" || change.op === "revoke" ? "set_folio_grant" : "set_folio_general_access", { workspace, viewer, folio_id: folioId, change }),
    requestAccess: (workspace, viewer, folioId, message) => call("request_folio_access", { workspace, viewer, folio_id: folioId, message: message ?? null }),
    joinSpace: (workspace, viewer, spaceId) => call("join_space", { workspace, viewer, space_id: spaceId }),
    leaveSpace: (workspace, viewer, spaceId) => call("leave_space", { workspace, viewer, space_id: spaceId }),
    search: (workspace, viewer, query) => call("search_folios", { workspace, viewer, query }),
    versions: (workspace, viewer, folioId) => call("folio_versions", { workspace, viewer, folio_id: folioId }),
    version: (workspace, viewer, folioId, versionId) => call("folio_version", { workspace, viewer, folio_id: folioId, version_id: versionId }),
    restoreVersion: (workspace, viewer, folioId, versionId) => call("restore_folio_version", { workspace, viewer, folio_id: folioId, version_id: versionId }),
    templates: (workspace, viewer, kind) => call("folio_templates", { workspace, viewer, kind: kind ?? null }),
    saveTemplate: (workspace, viewer, input) => call("save_folio_template", { workspace, viewer, input }),
    deleteTemplate: (workspace, viewer, templateId) => call("delete_folio_template", { workspace, viewer, template_id: templateId }),
    export: (workspace, viewer, folioId, format) => call("export_folio", { workspace, viewer, folio_id: folioId, format: format ?? null }),
    suggestions: (workspace, viewer, folioId) => call("folio_suggestions", { workspace, viewer, folio_id: folioId }),
    decideSuggestion: (workspace, viewer, suggestionId, decision) => call("decide_folio_suggestion", { workspace, viewer, suggestion_id: suggestionId, decision }),
    proposals: (workspace, viewer, folioId) => call("folio_proposals", { workspace, viewer, folio_id: folioId }),
    decideProposal: (workspace, viewer, proposalId, decision) => call("decide_folio_proposal", { workspace, viewer, proposal_id: proposalId, decision }),
    thread: (workspace, viewer, folioId, action) => call("folio_thread", { workspace, viewer, folio_id: folioId, action }),
    threads: (workspace, viewer, folioId) => call("folio_threads", { workspace, viewer, folio_id: folioId }),
    queryTile: (workspace, viewer, folioId, tileId) => call("query_tile", { workspace, viewer, folio_id: folioId, tile_id: tileId }),
    queryDataset: (workspace, viewer, query) => call("query_dataset", { workspace, viewer, query }),
    foliosForAgent: (workspace, agentId, viewer, query, audience) => call("folios_for_agent", { workspace, agent_id: agentId, viewer, query, audience: audience ?? null }),
    readForAgent: (workspace, agentId, viewer, folioId, audience) => call("read_folio_for_agent", { workspace, agent_id: agentId, viewer, folio_id: folioId, audience: audience ?? null }),
    createAsAgent: (workspace, agentId, viewer, input) => call("create_folio_as_agent", { workspace, agent_id: agentId, viewer, input }),
    editAsAgent: (workspace, agentId, viewer, folioId, edit) => call("edit_folio_as_agent", { workspace, agent_id: agentId, viewer, folio_id: folioId, edit }),
    shareAsAgent: (workspace, agentId, viewer, folioId, input, audience) =>
      call("share_folio_as_agent", { workspace, agent_id: agentId, viewer, folio_id: folioId, ...input, audience }),
    recallForAgent: (workspace, agentId, viewer, input, audience) =>
      call("recall_folios_for_agent", { workspace, agent_id: agentId, viewer, ...input, audience: audience ?? null }),
    staleForAgent: (workspace, agentId, viewer, options, audience) =>
      call("stale_folios_for_agent", { workspace, agent_id: agentId, viewer, repo: options?.repo ?? null, since: options?.since ?? null, audience: audience ?? null }),
    queryDatasetForAgent: (workspace, agentId, viewer, input, audience) =>
      call("query_dataset_for_agent", { workspace, agent_id: agentId, viewer, ...input, audience: audience ?? null }),
    markCurrent: (workspace, viewer, folioId) => call("mark_folio_current", { workspace, viewer, folio_id: folioId }),
    reindex: (workspace, viewer) => call("reindex_folios", { workspace, viewer }),
  };
}
