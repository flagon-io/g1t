import { LIST_PAGE } from "@g1t/contracts";

import type { Route } from "./+types/plan-later";
import { originPath } from "../../../lib/plan";
import { work } from "../../../lib/services.server";
import { getViewer } from "../../../lib/session.server";
import { repoFilter } from "../../../lib/work-items";

/**
 * One of the Plan's Later groups, read when it is opened: the open work
 * items on Later filed in a repository (`?repo=acme/web`), or in the
 * workspace itself (`?repo=`), in the plan's order, at most 100.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const repoName = new URL(request.url).searchParams.get("repo")?.trim() ?? "";
  const repo = repoName ? repoFilter(workspace, repoName) : null;
  if (repoName && !repo) return { error: "That is not a repository of the workspace." };
  const found = await work
    .listWorkItems(workspace, viewer, { horizon: "later", limit: LIST_PAGE, ...(repo ? { repo, role: "origin" as const } : {}) })
    .catch(() => null);
  if (!found) return { error: "Later could not be loaded just now." };
  if (!found.ok) return { error: found.error.message };
  // Those filed in the workspace have no origin repository.
  const items = repo ? found.value : found.value.filter((item) => originPath(item) == null);
  return { items, more: found.value.length >= LIST_PAGE };
}
