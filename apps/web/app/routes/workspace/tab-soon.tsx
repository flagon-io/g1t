import { data } from "react-router";

import type { Route } from "./+types/tab-soon";
import { page } from "../../lib/meta";
import { roadmapItem } from "../../lib/roadmap";
import { getViewer, roleIn } from "../../lib/session.server";
import { pagePath } from "../../lib/workspace-nav";
import { SoonView } from "../repo/soon";

/** The tab is the last part of the address: `-/insights`. */
const tabOf = (pathname: string) => pagePath(pathname).split("/").pop() ?? "";

export function meta({ params, ...args }: Route.MetaArgs) {
  const item = roadmapItem(tabOf(args.location.pathname));
  return page(args, {
    title: `${item?.title ?? "Soon"} · ${params.owner} · g1t`,
    description: item ? `Soon on g1t: ${item.summary}` : null,
  });
}

export function loader({ params, context, request }: Route.LoaderArgs) {
  // For the workspace's members, as their tabs are.
  if (!roleIn(getViewer(context), params.owner)) throw data(null, { status: 404 });
  const item = roadmapItem(tabOf(new URL(request.url).pathname));
  if (!item || item.section !== "Workspace") throw data(null, { status: 404 });
  return { item };
}

/** A tab of the workspace's page that is coming: Insights. */
export default function WorkspaceTabSoon({ loaderData, params }: Route.ComponentProps) {
  return <SoonView item={loaderData.item} base={`/${params.owner}/-`} newProject={`/new?workspace=${params.owner}`} />;
}
