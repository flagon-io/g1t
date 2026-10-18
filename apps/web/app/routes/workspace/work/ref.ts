/**
 * `/<workspace>/-/work/ref/<number>`: `#12` read in the workspace alone
 * (lib/refs.ts): its work item, else its pull request. Asked for JSON, it
 * is the card over a `#12` on a work item's timeline
 * (components/commit-message.tsx), for anyone who may see it; followed as
 * a link, it sends the browser on. Kept a minute by the browser, and out
 * of indexes.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/ref";
import { refCard, refPath } from "../../../lib/refs.server";
import { getViewer } from "../../../lib/session.server";

const HEADERS = {
  "cache-control": "private, max-age=60",
  vary: "Cookie, Accept",
  "x-robots-tag": "noindex, nofollow",
};

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const scope = { workspace: params.owner.toLowerCase() };
  const number = Number(params.number);
  const card = (request.headers.get("accept") ?? "").startsWith("application/json");
  if (card) {
    const found = await refCard(viewer, scope, number);
    if (!found) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    return Response.json(found, { headers: HEADERS });
  }
  const to = await refPath(viewer, scope, number);
  if (!to) throw data(null, { status: 404 });
  return redirect(to);
}
