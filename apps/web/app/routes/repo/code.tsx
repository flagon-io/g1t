import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { page } from "../../lib/meta";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const [tree, branches] = await Promise.all([
    repos.tree(path, viewer, null, ""),
    // For the branch menu; the page still shows without it.
    repos.branches(path, viewer).catch(() => null),
  ]);
  // Each entry's last commit walks history: streamed in after the list.
  const lastCommits = lastCommitsFor(path, viewer, null, "");
  const found = unwrap(tree);
  // The latest commit's checks: streamed in beside it.
  const checks = commitChecksFor(path, viewer, [found.head?.hash]);
  return { tree: found, branches: branches?.ok ? branches.value : null, lastCommits, checks };
}

export default function Code({ loaderData }: Route.ComponentProps) {
  return <TreeView tree={loaderData.tree} branches={loaderData.branches} lastCommits={loaderData.lastCommits} checks={loaderData.checks} />;
}
