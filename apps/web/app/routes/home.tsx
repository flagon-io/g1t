import { useEffect } from "react";
import { data, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/home";
import {
  DESKTOP_COOKIE,
  DESKTOP_COOKIE_SECONDS,
  DESKTOP_QUERY,
  DESKTOP_VALUE,
  fromDesktopApp,
  launchedFromDesktopApp,
  rememberDesktopApp,
} from "../lib/desktop";
import { cookie } from "../lib/github";
import { desktopBridge } from "../lib/notify-client";
import { page } from "../lib/meta";
import { application, organization } from "../lib/structured-data";
import { WORKSPACE_COOKIE, chosenWorkspace } from "../lib/workspace-choice";
import { readCookie } from "../lib/mission";
import { Landing } from "../components/landing";
import { getViewer } from "../lib/session.server";
import { homePath } from "../lib/workspace-nav";

export function meta(args: Route.MetaArgs) {
  return [
    ...page(args, {
      title: "g1t · Where your team's code lands",
      description:
        // At most 200 characters, or a preview cuts it short (lib/meta.ts).
        "Repositories, pull requests, required checks, a merge queue and deployments, for your team and the coding agents you bring over MCP and the API. Chat is free on every plan. Never per seat.",
    }),
    organization(),
    application(20),
  ];
}

/**
 * g1t.sh: the landing page for a visitor. Someone signed in has a Home in
 * their workspace (routes/workspace/home.tsx); the query goes with them.
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
