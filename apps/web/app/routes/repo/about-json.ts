/**
 * The Files page's About as JSON, asked for again by the panel while the
 * default branch is first being read (components/repo-about.tsx).
 */
import { data } from "react-router";

import type { Route } from "./+types/about-json";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const found = await repos.about({ namespace: params.owner, name: params.repo }, getViewer(context));
  if (!found.ok) throw data({ error: found.error.message }, { status: 404 });
  return Response.json(found.value, { headers: { "cache-control": "no-store" } });
}
