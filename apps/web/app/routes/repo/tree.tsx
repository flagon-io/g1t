import type { Route } from "./+types/tree";
import { page } from "../../lib/meta";
import { TreeView } from "../../components/repo-view";
import { redirectIfBranchRenamed } from "../../lib/branch-redirect.server";
import { aboutFor } from "../../lib/about.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { useProject } from "./layout";

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
  // Each entry's last commit walks history: streamed in after the list.
  const lastCommits = lastCommitsFor(path, viewer, params.ref, params["*"] ?? "");
  const value = unwrap(tree);
  // At the root, the About beside the files, streamed in after them.
  const about = value.head && !value.path ? aboutFor(path, viewer, value.repo.id) : null;
  return { tree: value, branches: branches?.ok ? branches.value : null, lastCommits, about };
}

export default function Tree({ loaderData }: Route.ComponentProps) {
  const project = useProject();
  return (
    <TreeView
      tree={loaderData.tree}
      branches={loaderData.branches}
      lastCommits={loaderData.lastCommits}
      about={loaderData.about}
      canPush={Boolean(project?.access.can.push)}
    />
  );
}
