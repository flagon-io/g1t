/**
 * Who may do what in a space: pure, so the rules are tested apart from the
 * service (docs/WORKSPACE.md, "The asker's access caps the agent").
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
