import type { DeploymentEnvironments, RepoPath, Viewer } from "@g1t/contracts";

import { deployments } from "./services.server";

/**
 * A repository's environments for a sidebar's Deployments panel, or null
 * when there are none. It throws when they cannot be read just now: the
 * page reads it as a part (lib/partial.ts), so the panel says so in its
 * place rather than going missing.
 */
export async function environmentsFor(repo: RepoPath, viewer: Viewer): Promise<DeploymentEnvironments | null> {
  const found = await deployments.environments(repo, viewer);
  return found.ok && found.value.environments.length > 0 ? found.value : null;
}
