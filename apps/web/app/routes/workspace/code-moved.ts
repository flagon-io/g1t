/**
 * Code called repositories projects: `-/projects` was the address of its
 * list, until Work's projects took the word. Every link to it (in chat,
 * docs, email, bookmarks) comes here and goes on to `-/code/repositories`,
 * query and all (lib/workspace-nav.ts). 308 keeps the method, so a form
 * posted from a page opened before the move still lands.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/code-moved";
import { movedCodePath } from "../../lib/workspace-nav";

function moved(request: Request): Response {
  const url = new URL(request.url);
  const to = movedCodePath(url.pathname, url.search);
  if (!to) throw data(null, { status: 404 });
  return redirect(to, 308);
}

export function loader({ request }: Route.LoaderArgs) {
  return moved(request);
}

export function action({ request }: Route.ActionArgs) {
  return moved(request);
}
