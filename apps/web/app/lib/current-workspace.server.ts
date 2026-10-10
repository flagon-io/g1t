/**
 * The workspace a page outside `/<workspace>` acts on (New project, Import
 * from GitHub): always the one you're in, as the sidebar shows it, never a
 * choice made on the page. A link that names another of your workspaces
 * (`?workspace=`) switches you to it first, so the page and the shell
 * agree, and then drops it from the address.
 */
import { redirect } from "react-router";
import type { User } from "@g1t/contracts";

import { readCookie } from "./mission";
import { WORKSPACE_COOKIE, chosenWorkspace, rememberWorkspace } from "./workspace-choice";
import { pagePath } from "./workspace-nav";

export function currentWorkspace(user: User, request: Request) {
  const memberships = user.workspaces ?? [];
  const url = new URL(request.url);
  const asked = url.searchParams.get("workspace")?.trim().toLowerCase();
  const current = chosenWorkspace(memberships, readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE));
  if (asked) {
    const named = memberships.find((membership) => membership.slug.toLowerCase() === asked);
    url.searchParams.delete("workspace");
    // A click asks for `<path>.data?_routes=…`; the address given is the page's own.
    url.searchParams.delete("_routes");
    const headers = named && named.slug !== current?.slug ? { "set-cookie": rememberWorkspace(named.slug, url.protocol === "https:") } : undefined;
    throw redirect(`${pagePath(url.pathname)}${url.search}`, { headers });
  }
  return current;
}
