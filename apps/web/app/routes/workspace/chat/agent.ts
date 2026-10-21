/**
 * `-/chat/api/agent`: what Chat's New needs to have g1t start agent work in
 * a repository (components/chat/agent-composer.tsx), and starting it.
 *
 * `GET` says whether hosted sessions can start on the workspace's
 * Anthropic account (and if not, why, and whether the viewer is an owner
 * who can set it up), the repositories the viewer may read, and the one
 * the workspace's recent sessions ran in most. With `?items=owner/name`,
 * the open work items linked to that repository, for the work item picker.
 *
 * `POST` starts a hosted session through the integrations service's
 * `start_agent_session`, which checks who may start one and runs it on the
 * workspace's own key: g1t meters nothing. With a work item, it works on
 * it, with what was asked as its instruction; without, on what was asked,
 * tied to no work item. Then a new conversation in the viewer's direct
 * message with g1t records it (chat's `g1t_session`): what they asked, and
 * g1t's card for the session, linked to its page. Answers `{ to, session }`
 * (the conversation, and the session's page), or `{ error }`.
 */
import { AGENT_MODES, type AgentSessionsSetup, LIST_PAGE, MAX_PROMPT_CHARS } from "@g1t/contracts";
import { data } from "react-router";

import type { Route } from "./+types/agent";
import { mostUsedRepo } from "../../../lib/agent-chat";
import { channelPath } from "../../../lib/chat";
import { agentSessions, chat, work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../../lib/session.server";
import { sessionPath } from "../../../lib/work-items";

/** The workspace's recent sessions read to find the repository it uses most. */
const RECENT = 60;

export type AgentComposerData = {
  /** Null when it could not be read. */
  setup: AgentSessionsSetup | null;
  /** Whether the viewer is an owner, who can set hosted sessions up. */
  owner: boolean;
  /** `owner/name` of each repository the viewer may read here; null when they could not be read. */
  repos: string[] | null;
  /** The one the workspace's recent sessions ran in most. */
  suggested: string | null;
};

export type AgentItemsData = { items: { number: number; title: string }[] | null };

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const headers = { "cache-control": "private, no-store" };
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!viewer || !role) throw data(null, { status: 404 });
  const workspace = params.owner.toLowerCase();
  const asked = new URL(request.url).searchParams.get("items");
  if (asked != null) {
    const [namespace, name, extra] = asked.split("/");
    if (!namespace || !name || extra !== undefined || namespace.toLowerCase() !== workspace)
      return Response.json({ items: [] } satisfies AgentItemsData, { headers });
    const listed = await work.listWorkItems(workspace, viewer, { state: "open", repo: { namespace, name }, limit: LIST_PAGE }).catch(() => null);
    const items = listed?.ok ? listed.value.map((item) => ({ number: item.number, title: item.title })) : null;
    return Response.json({ items } satisfies AgentItemsData, { headers });
  }
  const [setup, sessions] = await Promise.all([
    agentSessions.setup(workspace, viewer).catch(() => null),
    work.listWorkspaceSessions(workspace, viewer, { shown: "recent", sessionsOnly: true, limit: RECENT }).catch(() => null),
  ]);
  const repos = sessions?.ok ? sessions.value.repos.map((repo) => repo.path) : null;
  const body: AgentComposerData = {
    setup: setup?.ok ? setup.value : null,
    owner: role === "owner",
    repos,
    suggested: sessions?.ok && repos ? mostUsedRepo(sessions.value.sessions, repos) : null,
  };
  return Response.json(body, { headers });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  if (!roleIn(getViewer(context), params.owner)) throw data(null, { status: 404 });
  const workspace = params.owner.toLowerCase();
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const [namespace, name, extra] = String(input?.repo ?? "").split("/");
  if (!namespace || !name || extra !== undefined || namespace.toLowerCase() !== workspace) {
    return Response.json({ error: "Choose one of this workspace's repositories for it to work in." }, { status: 400 });
  }
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return Response.json({ error: "Write what you want done." }, { status: 400 });
  if (prompt.length > MAX_PROMPT_CHARS) return Response.json({ error: `What you ask is at most ${MAX_PROMPT_CHARS} characters.` }, { status: 400 });
  const item = Number.isInteger(input?.item) && (input?.item as number) > 0 ? (input?.item as number) : undefined;
  const mode = AGENT_MODES.find((one) => one.mode === input?.mode)?.mode;
  const repo = { namespace, name };
  // Never a hand-off: New starts it here, on the workspace's Anthropic account, or says why it cannot.
  const started = await agentSessions
    .start(user, repo, item ? { item, instruction: prompt, mode, handoff: false } : { prompt, handoff: false })
    .catch(() => null);
  if (!started) return Response.json({ error: "The session could not be started. Try again in a moment." }, { status: 502 });
  if (!started.ok) return Response.json({ error: started.error.message }, { status: 400 });
  const session = started.value.session;
  if (!session) return Response.json({ error: "No session was started." }, { status: 502 });
  const page = sessionPath(workspace, session.id);
  // The session is not the conversation: a new conversation with g1t says what was
  // asked, and g1t's card there links to the session. Should that fail, the session
  // runs all the same, and its own page is where to go.
  const recorded = await (async () => {
    const opened = await chat.g1tDm(workspace, user);
    if (!opened.ok) return null;
    await chat.g1tReset(workspace, opened.value.id, user);
    const title =
      session.title?.trim() ||
      prompt
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ||
      "Hosted session";
    const kept = await chat.g1tSession(workspace, opened.value.id, user, { body: prompt, session: { id: session.id, title, repo: `${namespace}/${name}` } });
    return kept.ok ? channelPath(workspace, opened.value) : null;
  })().catch(() => null);
  return Response.json({ to: recorded ?? page, session: page });
}
