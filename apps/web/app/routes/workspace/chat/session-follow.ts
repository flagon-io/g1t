/**
 * `-/chat/sessions/:id/follow?repo=owner/name`: what a hosted session's page
 * asks every few seconds while the session runs and the page is in view
 * (lib/use-session-follow.ts), so what it does shows as it goes. The
 * integrations service's `follow_agent_session` reads the session from
 * Anthropic at most once every `FOLLOW_EVERY_MS` however many pages ask
 * (on the workspace's own key, where reading costs nothing), and answers
 * `{ running, mark }`; the page reads itself again when the mark changes.
 * With `&waiting=1` (g1t's card for the session in Chat), it also says
 * whether a call of it waits for an approval the viewer may answer: one
 * look at the session's calls in the same request, left out for the page,
 * which reads its waiting calls itself.
 * For the workspace's members, who see a session's transcript.
 */
import type { AgentSessionFollowed } from "@g1t/contracts";
import { data } from "react-router";

import type { Route } from "./+types/session-follow";
import { agentSessions } from "../../../lib/services.server";
import { getViewer, roleIn } from "../../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const headers = { "cache-control": "private, no-store" };
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  if (!viewer || !roleIn(viewer, workspace)) throw data(null, { status: 404, headers });
  const search = new URL(request.url).searchParams;
  const [namespace, name, extra] = (search.get("repo") ?? "").split("/");
  if (!namespace || !name || extra !== undefined || namespace.toLowerCase() !== workspace) throw data(null, { status: 404, headers });
  const followed = await agentSessions.follow({ namespace, name }, params.id, viewer, search.get("waiting") === "1").catch(() => null);
  if (!followed) return Response.json({ error: "unavailable" }, { status: 503, headers });
  if (!followed.ok) throw data(null, { status: 404, headers });
  return Response.json(followed.value satisfies AgentSessionFollowed, { headers });
}
