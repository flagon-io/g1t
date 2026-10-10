/**
 * Who may see and who may change a workspace's agents. Pure, so it is
 * tested on its own.
 *
 * Any member sees the workspace's agents: agents are members too, and
 * people need to know who they can talk to. Only owners create, change or
 * archive them, since such an agent spends the workspace's money and acts
 * in its name. A workspace's own access token, acting as the workspace,
 * counts as an owner, as it does for the workspace's other settings.
 *
 * Personal agents (docs.g1t.sh/guides/agents/, "Personal agents") are a
 * member's own: any member may create one while the workspace lets members
 * (`members_create_agents`, on unless an owner turns it off). Only its
 * member sees it, changes it and talks to it, in their direct message with
 * it; owners see it too, archive it, and promote it to a workspace agent.
 */
import type { WorkspaceAgentScope, User } from "@g1t/contracts";

type Viewer = Pick<User, "kind" | "username" | "workspaces" | "verified"> & { id?: string } | null | undefined;

/** An agent as these rules read it. */
export type Owned = { scope?: string | null; owner_id?: string | null; builtin?: number | boolean };

export function canSee(viewer: Viewer, workspace: string): boolean {
  const slug = workspace.toLowerCase();
  if (!viewer) return false;
  if (viewer.kind === "workspace") return viewer.username.toLowerCase() === slug;
  return !!viewer.workspaces?.some((m) => m.slug.toLowerCase() === slug);
}

export function canManage(viewer: Viewer, workspace: string): boolean {
  const slug = workspace.toLowerCase();
  if (!viewer) return false;
  if (viewer.kind === "workspace") return viewer.username.toLowerCase() === slug;
  return !!viewer.workspaces?.some((m) => m.slug.toLowerCase() === slug && m.role === "owner");
}

export const MANAGE_REFUSAL = "Only the workspace's owners can create, change or archive its agents.";
export const PERSONAL_OFF_REFUSAL = "This workspace's owners have turned off personal agents. Ask an owner to make the agent for the workspace.";
export const NOT_YOURS_REFUSAL = "Only the person whose personal agent this is can change it.";

const personal = (agent: Owned) => agent.scope === "personal";

/** Whether `viewer` is the member a personal agent belongs to. */
export function isOwnerOf(viewer: Viewer, agent: Owned): boolean {
  return !!viewer && (viewer.kind ?? "user") === "user" && personal(agent) && !!agent.owner_id && viewer.id === agent.owner_id;
}

/** Whether the viewer sees this agent at all: a personal one only its member and the owners. */
export function canSeeAgent(viewer: Viewer, workspace: string, agent: Owned): boolean {
  if (!canSee(viewer, workspace)) return false;
  return !personal(agent) || isOwnerOf(viewer, agent) || canManage(viewer, workspace);
}

/** Whether the viewer may change the agent's definition: owners a workspace agent, its member a personal one. */
export function canChange(viewer: Viewer, workspace: string, agent: Owned): boolean {
  return personal(agent) ? isOwnerOf(viewer, agent) : canManage(viewer, workspace);
}

/** Whether the viewer may archive it: owners any agent, a member their own personal one. */
export function canArchive(viewer: Viewer, workspace: string, agent: Owned): boolean {
  return canManage(viewer, workspace) || isOwnerOf(viewer, agent);
}

/**
 * The scope a new agent gets, or why the viewer may not create one:
 * owners make workspace agents unless they ask for a personal one; anyone
 * else makes personal agents, while the workspace lets them.
 */
export function creatableScope(
  viewer: Viewer,
  workspace: string,
  asked: unknown,
  membersMayCreate: boolean,
): { ok: true; scope: WorkspaceAgentScope } | { ok: false; message: string } {
  if (!canSee(viewer, workspace)) return { ok: false, message: "There is no such workspace." };
  const owner = canManage(viewer, workspace);
  const scope: WorkspaceAgentScope = asked === "personal" || asked === "workspace" ? asked : owner ? "workspace" : "personal";
  if (scope === "workspace") return owner ? { ok: true, scope } : { ok: false, message: MANAGE_REFUSAL };
  // A personal agent belongs to a person: never to a workspace's token or another agent.
  if ((viewer!.kind ?? "user") !== "user" || !viewer!.id) return { ok: false, message: "A personal agent belongs to a person: create it signed in as yourself." };
  if (!owner && !membersMayCreate) return { ok: false, message: PERSONAL_OFF_REFUSAL };
  return { ok: true, scope };
}

/**
 * Whether a personal agent may answer here: only its member, only in the
 * direct message of the two of them. `members` is how many people and
 * agents are in the conversation, when known. Null: it may; otherwise why not.
 */
export function personalRefusal(agent: Owned, place: { asked_by: string; channel_kind: "channel" | "dm"; members?: number | null }): string | null {
  if (!personal(agent)) return null;
  if (place.asked_by !== agent.owner_id) return "I'm someone's personal agent, so only they can talk to me.";
  if (place.channel_kind !== "dm" || (place.members != null && place.members > 2)) {
    return "I'm a personal agent: I answer only in my direct message with the person I belong to.";
  }
  return null;
}
