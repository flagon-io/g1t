/**
 * Who may do what in a space: pure, so the rules are tested apart from the
 * service (docs.g1t.sh/guides/agent-access/, "Rule one: the asker's access
 * caps the agent").
 *
 * - `workspace` spaces give every member `default_role`; `team` spaces give
 *   the team's members `default_role`; `private` spaces give nobody
 *   anything by default.
 * - Listed members (`user:<id>`, `agent:<id>`, `team:<slug>`) add to that:
 *   a person's role is the highest that applies to them.
 * - Workspace owners manage every workspace and team space. A private
 *   space is its members' alone, owners included.
 * - An agent acts for a person: it reads what they read, suggests where
 *   they can comment, and edits directly only where they can edit and the
 *   space lets agents edit.
 */
import type { DocAgentAbilities, DocAgentMode, DocRole, DocSpaceKind } from "@g1t/contracts";

export const RANK: Record<DocRole, number> = { view: 1, comment: 2, edit: 3, manage: 4 };

export function isRole(value: unknown): value is DocRole {
  return value === "view" || value === "comment" || value === "edit" || value === "manage";
}

export function atLeast(role: DocRole | null | undefined, need: DocRole): boolean {
  return !!role && RANK[role] >= RANK[need];
}

export function higher(a: DocRole | null, b: DocRole | null): DocRole | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function lower(a: DocRole | null, b: DocRole | null): DocRole | null {
  if (!a || !b) return null;
  return RANK[a] <= RANK[b] ? a : b;
}

/** The parts of a space access depends on. */
export type SpaceRules = {
  kind: DocSpaceKind;
  team: string | null;
  default_role: DocRole | null;
  members: { principal: string; role: DocRole }[];
};

/** A person, as access needs them. */
export type Person = {
  user_id: string;
  /** Owner of the workspace. */
  owner: boolean;
  /** The slugs of their teams in the workspace, lowercased. */
  teams: ReadonlySet<string>;
};

/** A person's role in a space, or null when they can't read it. */
export function roleOf(space: SpaceRules, person: Person): DocRole | null {
  let role: DocRole | null = null;
  if (space.kind === "workspace") role = space.default_role;
  if (space.kind === "team" && space.team && person.teams.has(space.team.toLowerCase())) role = space.default_role;
  for (const m of space.members) {
    if (m.principal === `user:${person.user_id}`) role = higher(role, m.role);
    else if (m.principal.startsWith("team:") && person.teams.has(m.principal.slice(5).toLowerCase())) role = higher(role, m.role);
  }
  if (person.owner && space.kind !== "private") role = "manage";
  return role;
}

/** Whether every one of `people` can read the space; for an agent answering to an audience. */
export function readableByAll(space: SpaceRules, people: Person[]): boolean {
  return people.every((person) => atLeast(roleOf(space, person), "view"));
}

/**
 * Whether a space is readable by "everyone in the workspace": a public
 * channel's audience. Only a workspace space with a base role is.
 */
export function readableByWorkspace(space: SpaceRules): boolean {
  return space.kind === "workspace" && atLeast(space.default_role, "view");
}

/** What an agent may do for a person whose role is `asker`, in a space whose agents `mode`. */
export function agentAbilities(asker: DocRole | null, mode: DocAgentMode): DocAgentAbilities {
  return {
    read: atLeast(asker, "view"),
    suggest: atLeast(asker, "comment"),
    edit: atLeast(asker, "edit") && mode === "edit",
  };
}

/** Whether `role` holders may change who is in a space and its settings. */
export function mayManage(role: DocRole | null): boolean {
  return atLeast(role, "manage");
}

/**
 * Whether removing or lowering `member` would leave a private space with
 * no one to manage it. Workspace and team spaces always have the owners.
 */
export function leavesNoManager(kind: DocSpaceKind, members: { principal: string; role: DocRole }[], member: string, role: DocRole | null): boolean {
  if (kind !== "private") return false;
  const after = members.filter((m) => m.principal !== member).map((m) => m.role);
  if (role) after.push(role);
  return !after.includes("manage");
}

/** A member key's parts, or null when it is not one. */
export function memberKey(key: string): { kind: "user" | "agent" | "team"; id: string } | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!id || (kind !== "user" && kind !== "agent" && kind !== "team")) return null;
  return { kind, id };
}

// ── Folios (Artifacts mode) ──────────────────────────────────────────────
//
// A person's role on a folio is the highest of:
// 1. its owner → `manage` (and the owner of every ancestor it inherits
//    from, as if that owner held a `manage` grant there);
// 2. grants on it or on an ancestor it inherits from, to their `user:` key
//    or one of their `team:` keys;
// 3. their space role, when the chain reaches the top of a space without a
//    restriction (`inheritsSpace`): workspace owners manage those, as for
//    pages, through `roleOf`;
// 4. the access root's general access: `workspace` gives every member its
//    role, `link` gives it to members who opened the link (a visit).
//
// A restricted folio (`inherit` false) is its own access root: grants
// above it, its space and its parent's general access stop there. An
// agent never has more than the person it acts for, narrowed to what
// everyone it is talking to can read.

/** One folio as access needs it. */
export type FolioAclNode = {
  id: string;
  /** `user:<id>`. */
  owner: string;
  parent_id: string | null;
  space_id: string | null;
  /** False: "Only people invited", its own access root. */
  inherit: boolean;
  general_access: "none" | "workspace" | "link";
  general_role: DocRole | null;
  created_at?: string;
};

/** An explicit share, as set. */
export type FolioGrant = { principal: string; role: DocRole; granted_at?: string };

/** Grants by folio id. */
export type FolioGrants = ReadonlyMap<string, readonly FolioGrant[]>;

/** The deepest a chain is followed: the tree's depth cap, with room. */
const MAX_CHAIN = 32;

/** The keys a person's grants can name: `user:<id>` and each `team:<slug>`. */
export function personKeys(person: Person): string[] {
  return [`user:${person.user_id}`, ...[...person.teams].map((t) => `team:${t.toLowerCase()}`)];
}

/** Where a folio's access comes from: itself when restricted or at the top, else its parent's access root. */
export function aclRootOf(node: { id: string; inherit: boolean; parent_id: string | null }, parentAclRoot: string | null): string {
  return !node.inherit || !node.parent_id || !parentAclRoot ? node.id : parentAclRoot;
}

/** A folio's path: `/<top id>/…/<id>/`. */
export function folioPathOf(id: string, parentPath: string | null): string {
  return parentPath ? `${parentPath}${id}/` : `/${id}/`;
}

/**
 * The chain access is read along: the folio, then each ancestor it
 * inherits from, up to and including its access root. A missing parent
 * ends the chain there.
 */
export function aclChain(id: string, byId: ReadonlyMap<string, FolioAclNode>): FolioAclNode[] {
  const out: FolioAclNode[] = [];
  let at = byId.get(id);
  const seen = new Set<string>();
  while (at && !seen.has(at.id) && out.length < MAX_CHAIN) {
    out.push(at);
    seen.add(at.id);
    if (!at.inherit || !at.parent_id) break;
    at = byId.get(at.parent_id);
  }
  return out;
}

/** Whether a chain's access root takes its space's access: at the top of a space, not restricted. */
export function inheritsSpace(chain: readonly FolioAclNode[]): boolean {
  const root = chain[chain.length - 1];
  return !!root && !!root.space_id && root.inherit && !root.parent_id;
}

/** General access never gives `manage`. */
export function generalRoleCap(role: DocRole | null | undefined): DocRole {
  if (!role) return "view";
  return role === "manage" ? "edit" : role;
}

/** One principal's explicit access to a folio: its role, whose grant or ownership it is, and since when. */
export type FolioAccessEntry = { role: DocRole; via: string; since: string };

/**
 * Explicit access along a chain: the folio's owner (`via` "owner"), the
 * owners of the ancestors it inherits from, and every grant up to the
 * access root; the highest role per principal, the nearest on a tie.
 */
export function explicitAccess(chain: readonly FolioAclNode[], grants: FolioGrants): Map<string, FolioAccessEntry> {
  const out = new Map<string, FolioAccessEntry>();
  const put = (principal: string, role: DocRole, via: string, since: string) => {
    const was = out.get(principal);
    if (!was || RANK[role] > RANK[was.role]) out.set(principal, { role, via, since });
  };
  chain.forEach((node, i) => {
    put(node.owner, "manage", i === 0 ? "owner" : node.id, node.created_at ?? "");
    for (const g of grants.get(node.id) ?? []) put(g.principal, g.role, node.id, g.granted_at ?? "");
  });
  return out;
}

/**
 * A person's role on a folio, or null when they can't read it. `chain` is
 * `aclChain`'s; `spaceRole` is their role in the folio's space (`roleOf`),
 * used only when the chain inherits it; `visited` says they opened the
 * folio's link (or its access root's).
 */
export function effectiveRole(chain: readonly FolioAclNode[], grants: FolioGrants, spaceRole: DocRole | null, person: Person, options: { visited?: boolean } = {}): DocRole | null {
  const root = chain[chain.length - 1];
  if (!root) return null;
  const keys = new Set(personKeys(person));
  let role: DocRole | null = null;
  for (const [principal, entry] of explicitAccess(chain, grants)) if (keys.has(principal)) role = higher(role, entry.role);
  if (inheritsSpace(chain)) role = higher(role, spaceRole);
  if (root.general_access === "workspace") role = higher(role, generalRoleCap(root.general_role));
  if (root.general_access === "link" && options.visited) role = higher(role, generalRoleCap(root.general_role));
  return role;
}

/** The lock: only the folio's owner can read it (no other owners or grants, no general access, no space it inherits). */
export function isPrivateFolio(chain: readonly FolioAclNode[], grants: FolioGrants): boolean {
  const root = chain[chain.length - 1];
  const self = chain[0];
  if (!root || !self) return true;
  if (root.general_access !== "none" || inheritsSpace(chain)) return false;
  for (const principal of explicitAccess(chain, grants).keys()) if (principal !== self.owner) return false;
  return true;
}

/**
 * Whether "everyone in the workspace" can read a folio: a public
 * channel's audience. Only through an open space it inherits (with a base
 * role) or general access `workspace`; never a link, grants or Private.
 */
export function folioReadableByWorkspace(chain: readonly FolioAclNode[], space: SpaceRules | null): boolean {
  const root = chain[chain.length - 1];
  if (!root) return false;
  if (root.general_access === "workspace") return true;
  return inheritsSpace(chain) && !!space && readableByWorkspace(space);
}

/** Whether every one of `people` can read a folio. `visited` says whether a person opened its link. */
export function folioReadableByAll(
  chain: readonly FolioAclNode[],
  grants: FolioGrants,
  space: SpaceRules | null,
  people: readonly Person[],
  visited: (person: Person) => boolean = () => false,
): boolean {
  return people.every((person) => atLeast(effectiveRole(chain, grants, space ? roleOf(space, person) : null, person, { visited: visited(person) }), "view"));
}

/**
 * The index scope a folio's passages are filed under: its space's when
 * its access is exactly the space's (inherits to the top, nothing shared
 * beyond its owners, no general access); otherwise its access root's.
 */
export function folioScope(chain: readonly FolioAclNode[], grants: FolioGrants): string {
  const root = chain[chain.length - 1];
  if (!root) return "folio:unknown";
  if (inheritsSpace(chain) && root.general_access === "none") {
    const owners = new Set(chain.map((n) => n.owner));
    const shared = [...explicitAccess(chain, grants).keys()].some((p) => !owners.has(p));
    if (!shared) return `space:${root.space_id}`;
  }
  return `folio:${root.id}`;
}

export type FolioAccessRecord = { folio_id: string; principal: string; role: DocRole; via: string; since: string };

/** The rows of `folio_access` for these folios: everything `explicitAccess` finds along each one's chain. */
export function materialize(ids: readonly string[], byId: ReadonlyMap<string, FolioAclNode>, grants: FolioGrants): FolioAccessRecord[] {
  const out: FolioAccessRecord[] = [];
  for (const id of ids) {
    const chain = aclChain(id, byId);
    if (!chain.length) continue;
    for (const [principal, entry] of explicitAccess(chain, grants)) out.push({ folio_id: id, principal, role: entry.role, via: entry.via, since: entry.since });
  }
  return out;
}

/** Whether `role` may change who a folio is shared with: `manage`, or `edit` where editors may share. */
export function canShare(role: DocRole | null, editorsCanShare = false): boolean {
  return atLeast(role, "manage") || (editorsCanShare && atLeast(role, "edit"));
}

/**
 * An agent's role on a folio: never more than its asker's, and nothing
 * when someone it is talking to can't read the folio. The agent's own
 * grants never widen this; they make it a participant, nothing more.
 */
export function agentFolioRole(askerRole: DocRole | null, audienceCanRead: boolean): DocRole | null {
  return audienceCanRead ? askerRole : null;
}
