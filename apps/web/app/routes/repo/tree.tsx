import { env } from "cloudflare:workers";

import type { Route } from "./+types/tree";
import { TreeView } from "../../components/repo-view";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  const path = params["*"] ? `${params["*"]} · ` : "";
  return [{ title: `${path}${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return unwrap(
    await env.REPOS.tree(path, getViewer(context), params.ref, params["*"] ?? ""),
  );
}

export default function Tree({ loaderData }: Route.ComponentProps) {
  return <TreeView tree={loaderData} />;
}
