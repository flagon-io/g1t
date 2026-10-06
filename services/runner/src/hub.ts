/**
 * The context hub's section of an agent's prompt: the project's catalog
 * entry, the memories closest to its task and recent decisions, from the
 * context service. Never holds up a run: on any trouble, nothing.
 */

import { contextClient, reposClient, type RepoPath, type ServiceBinding, type User } from "@g1t/contracts";

/** How much of a prompt the hub's section may take, in characters. */
const BUDGET = 4000;

export async function hubContext(
  env: { CONTEXT?: ServiceBinding; REPOS: ServiceBinding },
  repo: RepoPath,
  task: string,
  /** The person the run acts for: the section holds only what they may read. */
  requester: User,
): Promise<string | null> {
  if (!env.CONTEXT) return null;
  try {
    // g1t itself, as a member of the repository's workspace, so a private one is found.
    const viewer = {
      id: "g1t_runner",
      username: "g1t",
      workspaces: [{ slug: repo.namespace.toLowerCase(), role: "member" as const }],
    };
    const found = await reposClient(env.REPOS).get(repo, viewer);
    if (!found.ok) return null;
    const context = await contextClient(env.CONTEXT).runContext(found.value.id, task.slice(0, 2000), BUDGET, requester);
    return context.text;
  } catch (error) {
    console.log("no context hub section", `${repo.namespace}/${repo.name}`, String(error));
    return null;
  }
}
