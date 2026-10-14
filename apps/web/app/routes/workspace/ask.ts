/**
 * Ask g1t (components/ask-composer): `GET -/ask` says what Ask answers with
 * in the workspace, or why it cannot yet, and whether the viewer is an
 * owner who can choose; with `?sessions`, whether sessions can start on the
 * workspace's Anthropic account. The conversation itself is the viewer's
 * direct message with @g1t in chat (`-/chat/api`, intents `g1t_dm`, `post`,
 * `g1t_stop`, `g1t_reset`, `g1t_retry`, `g1t_clear`): the chat service has g1t answer
 * there, with the provider an owner chose, on the workspace's own key.
 *
 * `POST -/ask` starts a session g1t proposed in an answer (the proposal
 * card in components/ask-steps): the person's click is the confirmation.
 * `handoff` asks for the Claude Code command instead of starting one on
 * the workspace's Anthropic account.
 */
import { data } from "react-router";

import { AGENT_MODES } from "@g1t/contracts";

import type { Route } from "./+types/ask";
import { agentSessions, integrations } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const workspace = params.owner.toLowerCase();
  const headers = { "cache-control": "no-store" };
  if (new URL(request.url).searchParams.has("sessions")) {
    const setup = await agentSessions.setup(workspace, viewer).catch(() => null);
    return Response.json({ available: Boolean(setup?.ok && setup.value.available), model: setup?.ok ? setup.value.model : null }, { headers });
  }
  const setup = await integrations.askSettings(workspace, viewer);
  return Response.json({ ...setup, owner: role === "owner" }, { headers });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  if (!roleIn(getViewer(context), params.owner)) throw data(null, { status: 404 });
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const [namespace, name, extra] = String(input?.repo ?? "").split("/");
  // A proposal is for a repository in this workspace only.
  if (!namespace || !name || extra !== undefined || namespace.toLowerCase() !== params.owner.toLowerCase()) {
    return Response.json({ error: "That repository isn't in this workspace." }, { status: 400 });
  }
  const text = (key: string) => (typeof input?.[key] === "string" && (input[key] as string).trim()) || undefined;
  const issue = Number.isInteger(input?.issue) && (input?.issue as number) > 0 ? (input?.issue as number) : undefined;
  const title = issue ? undefined : text("title");
  if (!issue && !title) return Response.json({ error: "The proposal names no issue." }, { status: 400 });
  const mode = AGENT_MODES.find((one) => one.mode === input?.mode)?.mode ?? "implement";
  const result = await agentSessions
    .start(user, { namespace, name }, { issue, title, body: issue ? undefined : text("body"), instruction: text("instruction"), mode, handoff: input?.handoff === true })
    .catch(() => null);
  if (!result) return Response.json({ error: "The session could not be started. Try again in a moment." }, { status: 502 });
  if (!result.ok) return Response.json({ error: result.error.message }, { status: 400 });
  const started = result.value;
  return Response.json({
    issue: started.issue,
    session_url: started.sessionUrl ?? (started.session ? `/${namespace}/${name}/work/sessions/${started.session.id}` : null),
    provider_session_url: started.providerSessionUrl,
    handoff: started.handoff,
    command: started.command,
    prompt: started.prompt,
  });
}
