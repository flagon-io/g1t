import { redirect } from "react-router";

import type { Route } from "./+types/github-install";
import { INSTALL_COOKIE, connectStep, cookie, installCookieValue, newState, notYetAdded } from "../lib/github";
import { githubApp } from "../lib/github.server";
import { requireUser, roleIn } from "../lib/session.server";

/**
 * "Connect GitHub" for a workspace owner, in one click: links their GitHub
 * account on the way if it is not linked yet, adds an installation they
 * already have, and otherwise sends them to GitHub to install g1t's GitHub
 * App. GitHub returns to /integrations/github/setup with the state, which
 * must match the cookie set here. `?another=1` always installs, for adding
 * one more account.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const workspace = (url.searchParams.get("workspace") ?? "").toLowerCase();
  const back = `/new/github?workspace=${encodeURIComponent(workspace)}`;
  if (roleIn(user, workspace) !== "owner") throw redirect(back);
  const status = await githubApp.status(user, workspace);
  if (!status.ok || !status.value.installUrl) throw redirect("/new");
  const another = url.searchParams.get("another") === "1";
  const linked = status.value.linked;
  const visible = linked ? await githubApp.visibleInstallations(user).catch(() => null) : null;
  const recorded = new Set(status.value.installations.map((item) => item.id));
  const unadded = visible?.ok ? notYetAdded(visible.value, workspace).filter((item) => !recorded.has(item.id)) : [];
  const step = connectStep({ linked, justLinked: url.searchParams.get("linked") === "1", another, unadded });
  switch (step.kind) {
    case "link": {
      // Back here once GitHub says who they are, to carry on installing.
      const here = `${url.pathname}?workspace=${encodeURIComponent(workspace)}${another ? "&another=1" : ""}&linked=1`;
      throw redirect(`/auth/github?link=1&next=${encodeURIComponent(here)}`);
    }
    case "add": {
      const added = await githubApp.addInstallation(user, workspace, step.installation);
      throw redirect(added.ok ? `${back}&installation=${step.installation}` : back);
    }
    case "choose":
      throw redirect(back);
    case "install": {
      const state = newState();
      const target = new URL(status.value.installUrl);
      target.searchParams.set("state", state);
      throw redirect(target.toString(), {
        headers: { "set-cookie": cookie(INSTALL_COOKIE, installCookieValue(state, workspace), 1800) },
      });
    }
  }
}
