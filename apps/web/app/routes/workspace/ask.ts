/**
 * Ask g1t (components/ask-composer): `GET -/ask` says what Ask answers with
 * in the workspace, or why it cannot yet, and whether the viewer is an
 * owner who can choose; with `?sessions`, whether sessions can start on the
 * workspace's Anthropic account. The conversation itself is the viewer's
 * direct message with @g1t in chat (`-/chat/api`, intents `g1t_dm`, `post`,
 * `g1t_stop`, `g1t_reset`, `g1t_retry`, `g1t_clear`): the chat service has g1t answer
 * there, with the provider an owner chose, on the workspace's own key.
 * Home's Summarize does this setup check, `g1t_dm` and `post` in one
 * request instead (`ask_g1t`).
 *
 * `POST -/ask` starts a session g1t proposed in an answer (the proposal
 * card in components/ask-steps): the person's click is the confirmation.
 * `handoff` asks for the Claude Code command instead of starting one on
 * the workspace's Anthropic account. A proposal with `new_repository`
 * first creates the repository as the person (its project described with
 * the work item's title), turns on its deployments when `deploy`, and tells
 * the session to push the first version to the default branch, which
 * deploys it. Sent again (a retry, or Copy after Start), a repository
 * already made is used as it is.
 */
import { data } from "react-router";

import { AGENT_MODES, type AskProposalState, type User } from "@g1t/contracts";

import type { Route } from "./+types/ask";
import { agentSessions, ai, chat, deployments, projects, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { sessionPath } from "../../lib/work-items";

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
  const setup = await ai.askSettings(workspace, viewer);
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
  const handoff = input?.handoff === true;
  // What the card did is kept on the answer that proposed it, step by step, so
  // the card shows it wherever the answer is read and another click carries on.
  const kept = keeper(user, params.owner, input);
  const before = await kept.save({});
  if (before?.started && !handoff) {
    return Response.json({ ...before, handoff: false, command: null, prompt: "" });
  }
  if (!handoff && before?.starting_at && Date.now() - before.starting_at < STARTING_MS) {
    return Response.json({ error: "It's already starting. This card shows it in a moment.", ...before }, { status: 409 });
  }
  const asked = Number.isInteger(input?.item) && (input?.item as number) > 0 ? (input?.item as number) : undefined;
  // A work item a click already opened is worked on, not opened again.
  const item = asked ?? before?.item;
  const title = item ? undefined : text("title");
  if (!item && !title) return Response.json({ error: "The proposal names no work item." }, { status: 400 });
  const mode = AGENT_MODES.find((one) => one.mode === input?.mode)?.mode ?? "implement";
  if (!handoff) await kept.save({ starting_at: Date.now() });
  let instruction = text("instruction");
  let built: Built | null = null;
  if (input?.new_repository === true) {
    const made =
      before?.repo_url && before.default_branch
        ? {
            repo_url: before.repo_url,
            default_branch: before.default_branch,
            production_url: before.production_url ?? null,
            deploy_error: before.deploy_error ?? null,
          }
        : await newRepository(user, namespace, name, {
            title: (title ?? text("title")) || name,
            isPrivate: input.private === true,
            deploy: input.deploy !== false,
          });
    if ("error" in made) {
      await kept.save({ starting_at: 0 });
      return Response.json({ error: made.error }, { status: 400 });
    }
    built = made;
    await kept.save(made);
    instruction = [firstPush(made), instruction].filter(Boolean).join("\n\n");
  }
  const result = await agentSessions
    .start(user, { namespace, name }, { item, title, body: item ? undefined : text("body"), instruction, mode, handoff })
    .catch(() => null);
  if (!result?.ok) {
    if (!handoff) await kept.save({ starting_at: 0 });
    if (!result) return Response.json({ error: "The session could not be started. Try again in a moment.", ...built }, { status: 502 });
    return Response.json({ error: result.error.message, ...built }, { status: 400 });
  }
  const started = result.value;
  const session_url = started.sessionUrl ?? (started.session ? sessionPath(namespace, started.session.id) : null);
  await kept.save(
    started.handoff ? { item: started.item } : { item: started.item, started: true, session_url, provider_session_url: started.providerSessionUrl ?? null },
  );
  return Response.json({
    item: started.item,
    session_url,
    provider_session_url: started.providerSessionUrl,
    handoff: started.handoff,
    command: started.command,
    prompt: started.prompt,
    ...built,
  });
}

/** How long a click that began starting a proposal holds off another. */
const STARTING_MS = 90_000;

/**
 * Keeps what a proposal's card did on the @g1t answer it came in
 * (`message_id` in `channel_id`, the viewer's direct message with g1t),
 * through chat's `g1t_proposal`; `save({})` only reads it. Without a
 * message, or when chat can't be reached, nothing is kept and null is said:
 * the card still works, it just won't remember.
 */
function keeper(user: User, workspace: string, input: Record<string, unknown> | null) {
  const id = typeof input?.id === "string" ? input.id : "";
  const channel = typeof input?.channel_id === "string" ? input.channel_id : "";
  const message = typeof input?.message_id === "string" ? input.message_id : "";
  return {
    async save(change: Omit<AskProposalState, "id">): Promise<AskProposalState | null> {
      if (!id || !channel || !message) return null;
      const kept = await chat.g1tProposal(workspace.toLowerCase(), channel, user, message, { ...change, id }).catch((error: unknown) => {
        console.error("ask: proposal state not kept", id, error);
        return null;
      });
      return kept?.ok ? kept.value : null;
    },
  };
}

/** What the card made before the session: the repository, and where it deploys or why it can't. */
type Built = { repo_url: string; default_branch: string; production_url: string | null; deploy_error: string | null };

/**
 * The repository a new-repository proposal names, made as the person, or
 * the one already made by an earlier click; its project described; its
 * deployments on when asked. A deploy that can't be turned on (no plan, no
 * Admin role) is said, not fatal: the session still builds it.
 */
async function newRepository(
  user: User,
  namespace: string,
  name: string,
  wanted: { title: string; isPrivate: boolean; deploy: boolean },
): Promise<Built | { error: string }> {
  const created = await repos.create(user, { namespace, name, isPrivate: wanted.isPrivate }).catch(() => null);
  let repo = created?.ok ? created.value : null;
  if (!repo) {
    // Already made: a second click, or Copy after Start. Anything else is the reason it wasn't.
    const found = await repos.get({ namespace, name }, user).catch(() => null);
    if (!found?.ok) return { error: created && !created.ok ? created.error.message : "The repository could not be created. Try again in a moment." };
    repo = found.value;
  } else {
    const described = await projects.describe(user, repo.id, wanted.title).catch((error: unknown) => String(error));
    if (typeof described === "string" || !described.ok) console.error("ask: new repository without its description", repo.id, described);
  }
  const built: Built = { repo_url: `/${repo.namespace}/${repo.name}`, default_branch: repo.defaultBranch, production_url: null, deploy_error: null };
  if (!wanted.deploy) return built;
  const saved = await deployments.updateSettings(user, { workspace: repo.namespace, slug: repo.name }, { enabled: true }).catch(() => null);
  if (saved?.ok) built.production_url = saved.value.productionUrl;
  else built.deploy_error = saved ? saved.error.message : "Deployments could not be turned on. Try again from the project's Settings → Deployments.";
  return built;
}

/** What the session is told about a repository the card just made. */
function firstPush(built: Built): string {
  const live = built.production_url
    ? `Its deployments are on: that push deploys production to ${built.production_url}. Watch it with \`g1t deploy list\` until it is live; if it fails, read why (\`g1t deploy view ID\`), fix it and push again. End your report with the address.`
    : "Its deployments are off, so nothing deploys yet; say so in your report.";
  return (
    `The repository was just created for this and is empty. Build the first working version and push it straight to the default branch ` +
    `(\`git push origin HEAD:${built.default_branch}\`): there is nothing to open a pull request against yet, so open none. ` +
    `Keep it small and make it build and serve from the repository's root. Put \`Closes #\` and the work item's number in the commit message, so the push closes it. ${live}`
  );
}
