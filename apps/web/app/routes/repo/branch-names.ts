/**
 * A repository's branch names as JSON, for choosing one without loading
 * them with the page: a pull request's base, when someone changes it.
 */
import { data } from "react-router";

import type { Route } from "./+types/branch-names";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const found = await repos.branches({ namespace: params.owner, name: params.repo }, getViewer(context));
  if (!found.ok) throw data({ error: found.error.message }, { status: 404 });
  return Response.json(
    {
      // The merge queue's own branches are g1t's, never a base.
      branches: found.value.map((branch) => branch.name).filter((name) => !name.startsWith("g1t-queue/")),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
