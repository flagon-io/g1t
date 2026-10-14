import type { Route } from "./+types/tree";
import { page } from "../../lib/meta";
import { TreeView } from "../../components/repo-view";
import { redirectIfBranchRenamed } from "../../lib/branch-redirect.server";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { aboutFor } from "../../lib/about.server";
import { environmentsFor } from "../../lib/deployments.server";
import { lastCommitsFor } from "../../lib/last-commits.server";
import { showOneCommit } from "../../lib/commit-people.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { useProject } from "./layout";
import { ForkBar } from "../../components/fork-bar";
import { forkSourceFor } from "../../lib/forks.server";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

export function meta({ params, ...args }: Route.MetaArgs) {
  const path = params["*"] ? `${params["*"]} · ` : "";
  return page(args, { title: `${path}${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const [tree, branches, environments, fork] = await Promise.all([
    repos.tree(path, viewer, params.ref, params["*"] ?? ""),
    // For the branch menu; the page still shows without it.
    repos.branches(path, viewer).catch(() => null),
    // For the About sidebar's Deployments panel, shown at the root only.
    params["*"] ? null : environmentsFor(path, viewer),
    // A fork's parent, for the bar above its files, at the root only.
    params["*"] ? null : forkSourceFor(context, params, viewer),
  ]);
  // A branch that was renamed: the same folder on its new name.
  if (!tree.ok && tree.error.code === "not_found") await redirectIfBranchRenamed(request, path, viewer, params.ref);
  // Each entry's last commit walks history: streamed in after the list.
  const lastCommits = lastCommitsFor(path, viewer, params.ref, params["*"] ?? "");
  const found = unwrap(tree);
  // The latest commit's author, as their account where there is one.
  const value = { ...found, head: await showOneCommit(found.head) };
  // The About beside the files, streamed in after them.
  const about = value.head && !value.path ? aboutFor(path, viewer, value.repo.id) : null;
  // The latest commit's checks: streamed in beside it.
  const checks = commitChecksFor(path, viewer, [value.head?.hash]);
  return { tree: value, branches: branches?.ok ? branches.value : null, lastCommits, about, deployments: environments, checks, fork };
}

export default function Tree({ loaderData }: Route.ComponentProps) {
  const project = useProject();
  // The files and latest commit follow pushes to the branch (none for a
  // tag or a commit); the latest commit's checks update as they report.
  const { tree, branches } = loaderData;
  const names = branches?.map((branch) => branch.name);
  useRepoLive({ match: repoPages.files({ branch: !names || names.includes(tree.ref) ? tree.ref : null, branches: names, sha: tree.head?.hash }) });
  return (
    <TreeView
      tree={loaderData.tree}
      branches={loaderData.branches}
      lastCommits={loaderData.lastCommits}
      checks={loaderData.checks}
      about={loaderData.about}
      canPush={Boolean(project?.access.can.push)}
      deployments={loaderData.deployments}
      fork={
        loaderData.fork && project && branches?.some((branch) => branch.name === tree.ref) ? (
          <ForkBar
            base={`/${tree.repo.namespace}/${tree.repo.name}`}
            branch={tree.ref}
            parent={loaderData.fork}
            canPush={Boolean(project.access.can.push)}
          />
        ) : null
      }
    />
  );
}
