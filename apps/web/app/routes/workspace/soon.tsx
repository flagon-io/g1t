import { data } from "react-router";

import type { Route } from "./+types/soon";
import { page } from "../../lib/meta";
import { roadmapItem } from "../../lib/roadmap";
import { SoonView } from "../repo/soon";

export function meta({ params, ...args }: Route.MetaArgs) {
  const item = roadmapItem(params.feature);
  return page(args, {
    title: `${item?.title ?? "Soon"} · ${params.owner} · g1t`,
    description: item ? `Soon on g1t: ${item.summary}` : null,
    version: item ? [item.title, item.summary] : undefined,
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const item = roadmapItem(params.feature);
  // Only what spans projects lives under the workspace.
  if (!item || item.section !== "Workspace") throw data(null, { status: 404 });
  return { item };
}

/** What a workspace will have across its projects: boards, the roadmap, packages, the fleet. */
export default function WorkspaceSoon({ loaderData, params }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
      <SoonView item={loaderData.item} base={`/${params.owner}/-`} />
    </div>
  );
}
