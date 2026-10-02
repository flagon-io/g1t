import type { Route } from "./+types/code";
import { TreeView } from "../../components/repo-view";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return unwrap(await repos.tree(path, getViewer(context), null, ""));
}

export default function Code({ loaderData }: Route.ComponentProps) {
  return <TreeView tree={loaderData} />;
}
