import { data } from "react-router";

import type { Route } from "./+types/ref";
import { refCard } from "../../../lib/refs.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export type { RefCard } from "../../../lib/refs.server";

/**
 * `-/chat/ref?repo=<namespace>/<name>&number=<n>`, or with
 * `workspace=<slug>` (this workspace when left out) instead of `repo`: the
 * card that opens over an `owner/repo#12`, `acme#12` or `#12` chip in chat
 * and in g1t's answers, read as lib/refs.ts says. Only what the viewer may read; anything
 * else is not found. Kept a minute by the browser.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const named = url.searchParams.get("repo") ?? "";
  const [namespace, name] = named.split("/");
  const number = Number(url.searchParams.get("number"));
  const headers = { "cache-control": "private, max-age=60", vary: "Cookie" };
  if (!Number.isInteger(number) || number < 1 || (named && (!namespace || !name))) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  const workspace = (url.searchParams.get("workspace") || params.owner).toLowerCase();
  const scope = namespace && name ? { repo: { namespace: namespace.toLowerCase(), name } } : { workspace };
  const card = await refCard(viewer, scope, number);
  if (!card) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json(card, { headers });
}
