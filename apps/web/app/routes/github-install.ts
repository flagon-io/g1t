import { redirect } from "react-router";

import type { Route } from "./+types/github-install";
import { INSTALL_COOKIE, cookie, installCookieValue, newState } from "../lib/github";
import { githubApp } from "../lib/github.server";
import { requireUser, roleIn } from "../lib/session.server";

/**
 * Sends a workspace owner to GitHub to install g1t's GitHub App on an
 * account or organization. GitHub returns to /integrations/github/setup
 * with the state, which must match the cookie set here.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const workspace = (new URL(request.url).searchParams.get("workspace") ?? "").toLowerCase();
  if (roleIn(user, workspace) !== "owner") throw redirect(`/new/github?workspace=${encodeURIComponent(workspace)}`);
  const status = await githubApp.status(user, workspace);
  if (!status.ok || !status.value.installUrl) throw redirect("/new");
  const state = newState();
  const target = new URL(status.value.installUrl);
  target.searchParams.set("state", state);
  throw redirect(target.toString(), {
    headers: { "set-cookie": cookie(INSTALL_COOKIE, installCookieValue(state, workspace), 1800) },
  });
}
