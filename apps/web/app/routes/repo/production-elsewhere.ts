/**
 * A screenshot of a project's production deployed elsewhere, for its
 * overview: of the address its reported production deployment gives, else
 * the one set for it (lib/production-image.ts `externalTarget`). The
 * address is always the project's own, never one the request names, and
 * the og service visits only public ones. For anyone who can see the
 * project: it shows a public address. Kept by the browser for an hour; the
 * overview's `?v=` changes with each reported deploy and each day.
 */
import { env } from "cloudflare:workers";

import type { Route } from "./+types/production-elsewhere";
import { reportedProduction } from "../../lib/deployments";
import { externalTarget } from "../../lib/production-image";
import { deployments } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { projectFor } from "../../lib/access.server";

const HOUR = "private, max-age=3600";
const BRIEF = "private, max-age=60";

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const none = (status: number) => new Response(null, { status, headers: { "cache-control": BRIEF } });
  if (!env.SCREENSHOTS) return none(404);
  const project = await projectFor(context, params).catch(() => null);
  if (!project?.ok) return none(404);
  const repo = project.value.source.kind === "hosted" ? project.value.source.repo : { namespace: params.owner, name: params.repo };
  const environments = await deployments.environments(repo, viewer).catch(() => null);
  const reported = reportedProduction(environments?.ok ? environments.value.environments : []);
  const target = externalTarget(project.value, reported, Date.now());
  if (!target) return none(404);
  const shot = await env.SCREENSHOTS.externalImage({ url: target.url, commit: target.commit, since: target.since ?? undefined }).catch(
    (error: unknown) => (console.warn("screenshot:", error), null),
  );
  if (!shot) return none(404);
  return new Response(shot.body, {
    headers: {
      "content-type": shot.contentType,
      "cache-control": HOUR,
      "x-content-type-options": "nosniff",
      // A picture of someone's site: shown, never run.
      "content-security-policy": "default-src 'none'; sandbox",
      "last-modified": new Date(shot.capturedAt).toUTCString(),
    },
  });
}
