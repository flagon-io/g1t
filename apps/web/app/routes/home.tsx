import { env } from "cloudflare:workers";
import { data, redirect } from "react-router";

import type { Route } from "./+types/home";
import { page } from "../lib/meta";
import { application, organization } from "../lib/structured-data";
import { WORKSPACE_COOKIE, chosenWorkspace } from "../lib/workspace-choice";
import { readCookie } from "../lib/mission";
import { type NotStarted, chosenRepo, delegateForm, issuePath, notStarted } from "../lib/delegate";
import { Landing } from "../components/landing";
import { repos as reposApi } from "../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../lib/session.server";
import { homePath } from "../lib/workspace-nav";

export function meta(args: Route.MetaArgs) {
  return [
    ...page(args, {
      title: "g1t · Your team and its agents, working in one place",
      description:
        "Chat with your team and your agents in channels and DMs. Agents are teammates with a role, a personality and a budget, and their code lands through pull requests, checks and a merge queue. Chat is free on every plan, never per seat.",
    }),
    organization(),
    application(20),
  ];
}

/**
 * g1t.sh: the landing page for a visitor. Someone signed in has a Home in
 * their workspace (routes/workspace/home.tsx); Mission control's code
 * panels are Code's Overview. `/?agent=new` and the rest of the query go
 * with them.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer) return data({ signedIn: false as const });
  const url = new URL(request.url);
  const slug = chosenWorkspace(viewer.workspaces ?? [], readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE))?.slug ?? null;
  // A workspace-less account is sent to make one by the session (lib/session.server.ts).
  if (!slug) throw redirect("/workspaces/new");
  throw redirect(homePath(slug, url.search));
}

/** What the composer said back, when the issue opened but the agent did not start, or nothing opened. */
export type DelegateResult = { error: string; notStarted: null } | { error: null; notStarted: NotStarted };

/**
 * "Put an agent on it": opens an issue in one of the viewer's projects and
 * puts g1t on it, then lands on the issue. When the agent could not
 * start, the issue is still open, and the composer says why and where to
 * fix it.
 */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") !== "delegate") return data<DelegateResult>({ error: "Nothing to do.", notStarted: null }, { status: 400 });
  const projects = await reposApi.list(user, { memberOnly: true }).catch(() => []);
  const repo = chosenRepo(form.get("repo"), projects.map((repo) => ({ namespace: repo.namespace, name: repo.name })));
  if (!repo) return data<DelegateResult>({ error: "Choose one of your projects.", notStarted: null }, { status: 400 });
  const result = await env.RUNNER.delegate(user, repo, delegateForm(form));
  if (!result.ok) return data<DelegateResult>({ error: result.error.message, notStarted: null }, { status: 400 });
  const { issue, agent } = result.value;
  const refused = notStarted(agent, repo, issue.number);
  if (!refused) throw redirect(issuePath(repo, issue.number));
  return data<DelegateResult>({ error: null, notStarted: refused });
}


export default function Home() {
  return <Landing />;
}
