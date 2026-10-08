import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { page } from "../../lib/meta";
import { environmentsFor } from "../../lib/deployments.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const [tree, branches, environments] = await Promise.all([
    repos.tree(path, viewer, null, ""),
    // For the branch menu; the page still shows without it.
    repos.branches(path, viewer).catch(() => null),
    // For the About sidebar's Deployments panel; null without any.
    environmentsFor(path, viewer),
  ]);
  // Each entry's last commit walks history: streamed in after the list.
  const lastCommits = lastCommitsFor(path, viewer, null, "");
  return { tree: unwrap(tree), branches: branches?.ok ? branches.value : null, lastCommits, deployments: environments };
}

export default function Code({ loaderData }: Route.ComponentProps) {
  return <TreeView tree={loaderData.tree} branches={loaderData.branches} lastCommits={loaderData.lastCommits} deployments={loaderData.deployments} />;
}
