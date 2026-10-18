/**
 * A new work item's choices, as the site's New work item has them
 * (apps/web/app/routes/workspace/work/new.tsx): the repositories of its
 * own workspace it may land in, and the one it is filed from, ticked as
 * a target to start with.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

/** A workspace's project as the API answers: only its repository, `owner/name`, when it has one. */
export type ProjectRepo = { repository: string | null };

/** The repositories of a workspace's projects, `owner/name`, each once, in the order given. Another workspace's are left out. */
export function workspaceRepos(workspace: string, projects: readonly ProjectRepo[]): string[] {
  const own = workspace.toLowerCase();
  const seen = new Map<string, string>();
  for (const project of projects) {
    const path = project.repository;
    if (!path || path.split("/")[0]?.toLowerCase() !== own) continue;
    if (!seen.has(path.toLowerCase())) seen.set(path.toLowerCase(), path);
  }
  return [...seen.values()];
}

/**
 * The repository a new item is filed from, `owner/name`, from a link's
 * `repo` (`web` or `acme/web`): only one of this workspace, else none.
 */
export function originOf(workspace: string, repo: string | null | undefined): string | null {
  const parts = (repo ?? "").split("/").filter(Boolean);
  if (parts.length === 1) return `${workspace}/${parts[0]}`;
  if (parts.length === 2 && parts[0]!.toLowerCase() === workspace.toLowerCase()) return `${workspace}/${parts[1]}`;
  return null;
}
