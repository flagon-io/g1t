/**
 * `/<owner>/<repo>/ref/<number>`: `#12` read in the repository, as the
 * work service reads it (lib/refs.ts): its pull request, the work item that
 * was its issue before work items, the workspace's work item or another of its repositories'
 * pull requests. Followed as a link (Markdown's `#12`), it sends the
 * browser on to that page; asked for JSON, it is the card that opens over
 * a `#12` in a commit message or on a timeline (components/commit-message.tsx),
 * for anyone who may read it, signed in or not. Anything the viewer may not
 * read is not found. A card is kept a minute by the browser, and out of
 * indexes (lib/robots.ts).
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/ref-card";
import { refCard, refPath } from "../../lib/refs.server";
import { getViewer } from "../../lib/session.server";

const HEADERS = {
  "cache-control": "private, max-age=60",
  vary: "Cookie, Accept",
  "x-robots-tag": "noindex, nofollow",
};

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner.toLowerCase(), name: params.repo };
  const number = Number(params.number);
  const card = (request.headers.get("accept") ?? "").startsWith("application/json");
  if (!Number.isInteger(number) || number < 1) {
    if (card) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    throw data(null, { status: 404 });
  }
  if (card) {
    const found = await refCard(viewer, { repo }, number);
    if (!found) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    return Response.json(found, { headers: HEADERS });
  }
  const to = await refPath(viewer, { repo }, number);
  if (!to) throw data(null, { status: 404 });
  return redirect(to);
}
