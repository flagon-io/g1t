import { env } from "cloudflare:workers";
import { useEffect } from "react";
import { data, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/home";
import { DESKTOP_COOKIE, DESKTOP_COOKIE_SECONDS, DESKTOP_QUERY, DESKTOP_VALUE, fromDesktopApp, launchedFromDesktopApp, rememberDesktopApp } from "../lib/desktop";
import { cookie } from "../lib/github";
import { desktopBridge } from "../lib/notify-client";
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
 *
 * The desktop app is for using g1t, so a visitor there goes to the sign-in
 * page instead (lib/desktop.ts). Its launcher opens `/?app=desktop`, which
 * sets the cookie that says so.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const url = new URL(request.url);
  const launched = launchedFromDesktopApp(url);
  const headers = new Headers();
  if (launched) {
    headers.set("set-cookie", cookie(DESKTOP_COOKIE, DESKTOP_VALUE, DESKTOP_COOKIE_SECONDS));
    url.searchParams.delete(DESKTOP_QUERY);
  }
  if (!viewer) {
    if (launched || fromDesktopApp(request)) throw redirect("/login", { headers });
    return data({ signedIn: false as const });
  }
  const slug = chosenWorkspace(viewer.workspaces ?? [], readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE))?.slug ?? null;
  // A workspace-less account is sent to make one by the session (lib/session.server.ts).
  if (!slug) throw redirect("/workspaces/new", { headers });
  throw redirect(homePath(slug, url.search), { headers });
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
  const navigate = useNavigate();
  // A build of the desktop app older than `?app=desktop` opens `/` as it
  // is: the page sets the cookie itself and moves on to signing in.
  useEffect(() => {
    if (!desktopBridge()) return;
    rememberDesktopApp();
    navigate("/login", { replace: true });
  }, [navigate]);
  return <Landing />;
}
