/**
 * Who may see and who may change a workspace's agents. Pure, so it is
 * tested on its own.
 *
 * Any member sees them: agents are members too, and people need to know
 * who they can talk to. Only owners create, change or archive them, since
 * an agent spends the workspace's money and acts in its name. A
 * workspace's own access token, acting as the workspace, counts as an
 * owner, as it does for the workspace's other settings.
 */
import type { User } from "@g1t/contracts";

type Viewer = Pick<User, "kind" | "username" | "workspaces" | "verified"> | null | undefined;

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
