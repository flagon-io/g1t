/**
 * A screenshot of a project's production, for its overview. Members only,
 * like the deployments it shows. The overview asks with `?v=` naming the
 * deploy (its commit and when it went live), so the browser keeps a
 * screenshot of that deploy for good, and a resumed or moved app, deployed
 * again at the same commit, is asked for anew. One taken before the
 * deploy, while the new one is being taken, is kept only for a minute.
 */
import { env } from "cloudflare:workers";

import type { Route } from "./+types/production-screenshot";
import { deployments } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

const LONG = "private, max-age=31536000, immutable";

/** What names one deploy of production: its commit and when it went live. */
export function shotVersion(app: { commit: string; deployedAt: string }): string {
  return `${app.commit}-${Date.parse(app.deployedAt) || 0}`;
}
const BRIEF = "private, max-age=60";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const none = (status: number) => new Response(null, { status, headers: { "cache-control": BRIEF } });
  if (!viewer || !env.SCREENSHOTS) return none(404);
  const list = await deployments.list({ workspace: params.owner, slug: params.repo }, viewer).catch(() => null);
  const production = list?.ok ? list.value.live.find((app) => app.kind === "production") : undefined;
  if (!production) return none(404);
  const shot = await env.SCREENSHOTS.image({
    host: new URL(production.url).host,
    commit: production.commit,
    since: production.deployedAt,
  }).catch(
    (error: unknown) => (console.warn("screenshot:", error), null),
  );
  if (!shot) return none(404);
  const asked = new URL(request.url).searchParams.get("v");
  const current =
    shot.commit === production.commit &&
    Date.parse(shot.capturedAt) >= Date.parse(production.deployedAt) &&
    asked === shotVersion(production);
  return new Response(shot.body, {
    headers: {
      "content-type": shot.contentType,
      "cache-control": current ? LONG : BRIEF,
      "x-content-type-options": "nosniff",
      "last-modified": new Date(shot.capturedAt).toUTCString(),
    },
  });
}
