/**
 * Workspace pages that moved: `-/members` is People now, and `-/overview`
 * the workspace's own page (lib/workspace-nav.ts).
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/moved";
import { workspaceRedirect } from "../../lib/workspace-nav";

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const to = workspaceRedirect(url.pathname, url.search);
  if (!to) throw data(null, { status: 404 });
  return redirect(to, 301);
}
