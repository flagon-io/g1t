/**
 * `POST -/home/seen` with `{ "at": <epoch ms> }`: Home marks the viewer's
 * visit once the page has been in view for a few seconds, with the time it
 * loaded (routes/workspace/home.tsx). Notify keeps it per person and
 * workspace and only moves it forward.
 */
import { data } from "react-router";

import type { Route } from "./+types/home-seen";
import { markVisit } from "../../lib/home.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";

export async function action({ params, context, request }: Route.ActionArgs) {
  if (request.method !== "POST") throw data(null, { status: 405 });
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const sent = (await request.json().catch(() => ({}))) as { at?: unknown };
  const at = typeof sent.at === "number" && Number.isFinite(sent.at) ? Math.min(sent.at, Date.now()) : Date.now();
  const ok = await markVisit(viewer, slug, at);
  return new Response(null, { status: ok ? 204 : 503, headers: { "cache-control": "no-store" } });
}
