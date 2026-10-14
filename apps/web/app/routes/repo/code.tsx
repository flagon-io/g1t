import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { page } from "../../lib/meta";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { aboutFor } from "../../lib/about.server";
import { environmentsFor } from "../../lib/deployments.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { showOneCommit } from "../../lib/commit-people.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { useProject } from "./layout";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

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
  const found = unwrap(tree);
  // The latest commit's author, as their account where there is one.
  const value = { ...found, head: await showOneCommit(found.head) };
  // The About beside the files, streamed in after them.
  const about = value.head ? aboutFor(path, viewer, value.repo.id) : null;
  // The latest commit's checks: streamed in beside it.
  const checks = commitChecksFor(path, viewer, [value.head?.hash]);
  return { tree: value, branches: branches?.ok ? branches.value : null, lastCommits, about, deployments: environments, checks };
}

export default function Code({ loaderData }: Route.ComponentProps) {
  const project = useProject();
  // The files and latest commit follow pushes to the branch; the latest
  // commit's checks update as they report.
  const { tree, branches } = loaderData;
  useRepoLive({ match: repoPages.files({ branch: tree.ref, branches: branches?.map((branch) => branch.name), sha: tree.head?.hash }) });
  return (
    <TreeView
      tree={loaderData.tree}
      branches={loaderData.branches}
      lastCommits={loaderData.lastCommits}
      checks={loaderData.checks}
      about={loaderData.about}
      canPush={Boolean(project?.access.can.push)}
      deployments={loaderData.deployments}
    />
  );
}
