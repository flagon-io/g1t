import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { page } from "../../lib/meta";
import { aboutFor } from "../../lib/about.server";
import { environmentsFor } from "../../lib/deployments.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { projectHomepage } from "../../lib/about";
import { useProject } from "./layout";

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
  const value = unwrap(tree);
  // The About beside the files, streamed in after them.
  const about = value.head ? aboutFor(path, viewer, value.repo.id) : null;
  return { tree: value, branches: branches?.ok ? branches.value : null, lastCommits, about, deployments: environments };
}

export default function Code({ loaderData }: Route.ComponentProps) {
  const project = useProject();
  return (
    <TreeView
      tree={loaderData.tree}
      branches={loaderData.branches}
      lastCommits={loaderData.lastCommits}
      about={loaderData.about}
      canPush={Boolean(project?.access.can.push)}
      homepage={projectHomepage(project?.project ?? null)}
      deployments={loaderData.deployments}
    />
  );
}
