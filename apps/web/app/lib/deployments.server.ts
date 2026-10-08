import type { DeploymentEnvironments, RepoPath, Viewer } from "@g1t/contracts";

import { deployments } from "./services.server";

/**
 * A repository's environments for a sidebar's Deployments panel, or null
 * when there are none or they cannot be read just now: the page shows
 * without the panel rather than failing.
 */
export async function environmentsFor(repo: RepoPath, viewer: Viewer): Promise<DeploymentEnvironments | null> {
  try {
    const found = await deployments.environments(repo, viewer);
    return found.ok && found.value.environments.length > 0 ? found.value : null;
  } catch (error) {
    console.warn("deployments:", error);
    return null;
  }
}
