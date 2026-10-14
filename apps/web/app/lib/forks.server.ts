import type { Viewer } from "@g1t/contracts";

import type { ForkSource } from "../components/fork-bar";
import { repoFor } from "./access.server";
import { repos } from "./services.server";

/**
 * The repository the one at `params` was forked from, for its fork bar
 * (components/fork-bar.tsx), when it is a fork whose parent the viewer can
 * read; null otherwise, or when either cannot be read just now.
 */
export async function forkSourceFor(
  context: Parameters<typeof repoFor>[0],
  params: { owner?: string; repo?: string },
  viewer: Viewer,
): Promise<ForkSource | null> {
  try {
    const found = await repoFor(context, params);
    if (!found.ok || !found.value.parent) return null;
    const parent = await repos.get(found.value.parent, viewer);
    if (!parent.ok) return null;
    return {
      namespace: parent.value.namespace,
      name: parent.value.name,
      defaultBranch: parent.value.defaultBranch,
      forkDefault: found.value.defaultBranch,
    };
  } catch {
    return null;
  }
}
