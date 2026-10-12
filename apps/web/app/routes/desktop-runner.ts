/**
 * The desktop app's runner, from its page (lib/desktop-runner.ts): a
 * registration token for a workspace the person owns, which the page
 * hands to the app and never shows, and the app's reports of how its
 * runner is, kept for the workspace's Runners page.
 *
 * Signed in, same origin, and owners of the workspace only, as the
 * Runners page's own New runner is; the actions service checks again.
 * `-` is no workspace's name, so nothing else is ever found here.
 *
 *   POST { "intent": "token", "workspace": "acme" }
 *     → { "token": "g1trt_…", "workspace": "acme", "url": "https://g1t.sh", "expires_at": "…" }
 *     → 403 { "error": "…", "allowed": false }
 *   POST { "intent": "report", "workspace", "machine", "backend", "version", "diagnosis", "closed" }
 *     → { "ok": true }
 */
import type { Route } from "./+types/desktop-runner";
import { backendOf, diagnosisOf, text } from "../lib/desktop-runner";
import { runners } from "../lib/runners.server";
import { assertSameOrigin, getViewer, roleIn } from "../lib/session.server";

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const headers = { "cache-control": "no-store" };
  const viewer = getViewer(context);
  if (!viewer || (viewer.kind ?? "user") !== "user") return Response.json({ error: "Sign in to g1t." }, { status: 401, headers });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspace = text(body?.workspace)?.toLowerCase() ?? null;
  if (!body || !workspace) return Response.json({ error: "Name a workspace." }, { status: 400, headers });
  if (roleIn(viewer, workspace) !== "owner") {
    return Response.json({ error: `You can't add runners to ${workspace}: only its owners can.`, allowed: false }, { status: 403, headers });
  }
  switch (body.intent) {
    case "token": {
      const made = await runners.createToken(viewer, { workspace });
      if (!made.ok) return Response.json({ error: made.error.message, allowed: true }, { status: 409, headers });
      const token = made.value;
      return Response.json({ token: token.token, workspace: token.workspace, url: token.url, expires_at: token.expiresAt }, { headers });
    }
    case "report": {
      const backend = backendOf(body.backend);
      const machine = text(body.machine);
      const diagnosis = diagnosisOf(body.diagnosis);
      const closed = diagnosisOf(body.closed);
      if (!backend || !machine || !diagnosis || !closed) return Response.json({ error: "That isn't a desktop's report." }, { status: 400, headers });
      const kept = await runners.reportDesktop(viewer, { workspace, machine, backend, version: text(body.version), diagnosis, closed });
      return kept.ok ? Response.json({ ok: true }, { headers }) : Response.json({ error: kept.error.message }, { status: 409, headers });
    }
    default:
      return Response.json({ error: "Nothing to do." }, { status: 400, headers });
  }
}
