/**
 * A workflow's status badge: an SVG saying how its newest finished run went,
 * on `?branch=` (the default branch, else any) and `?event=` when given.
 * Anyone may load a public repository's; a private repository's needs
 * someone who can see it, and is never cached where others could read it.
 */
import type { Route } from "./+types/actions-badge";
import { badgeState, badgeSvg } from "../../lib/badge";
import { actions, repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

function svg(body: string, isPrivate: boolean, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Shown in READMEs elsewhere, which fetch it through their own caches.
      "cache-control": isPrivate ? "private, no-store" : "public, max-age=60, s-maxage=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const query = new URL(request.url).searchParams;
  const branch = query.get("branch")?.trim() || undefined;
  const event = query.get("event")?.trim() || undefined;
  const repo = await repos.get(path, viewer).catch(() => null);
  // Not there, or not this viewer's to see: the same answer either way.
  if (!repo?.ok) return new Response("Not found.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const isPrivate = repo.value.isPrivate;
  const workflows = await actions.workflows(path, viewer);
  const file = params.file;
  const workflow = workflows.ok ? workflows.value.find((w) => w.path.endsWith(`/${file}`) || w.id === file) : undefined;
  if (!workflow) return svg(badgeSvg(file, "no status"), isPrivate, 404);
  const runsOn = async (onBranch: string | undefined) => {
    const runs = await actions.runs(path, viewer, { workflow: workflow.id, branch: onBranch, event, limit: 20 });
    return runs.ok ? runs.value : [];
  };
  // The default branch unless one is asked for; any branch when it has none.
  let runs = await runsOn(branch ?? repo.value.defaultBranch);
  if (!branch && !runs.some((run) => run.status === "completed")) runs = await runsOn(undefined);
  return svg(badgeSvg(workflow.name, badgeState(runs)), isPrivate);
}
