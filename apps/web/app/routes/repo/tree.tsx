import type { Route } from "./+types/tree";
import { page } from "../../lib/meta";
import { TreeView } from "../../components/repo-view";
import { redirectIfBranchRenamed } from "../../lib/branch-redirect.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  const path = params["*"] ? `${params["*"]} · ` : "";
  return page(args, { title: `${path}${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const [tree, branches] = await Promise.all([
    repos.tree(path, viewer, params.ref, params["*"] ?? ""),
    // For the branch menu; the page still shows without it.
    repos.branches(path, viewer).catch(() => null),
  ]);
  // A branch that was renamed: the same folder on its new name.
  if (!tree.ok && tree.error.code === "not_found") await redirectIfBranchRenamed(request, path, viewer, params.ref);
  return { tree: unwrap(tree), branches: branches?.ok ? branches.value : null };
}

export default function Tree({ loaderData }: Route.ComponentProps) {
  return <TreeView tree={loaderData.tree} branches={loaderData.branches} />;
}
