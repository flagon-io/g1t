import { data } from "react-router";

import type { Route } from "./+types/not-found";
import { redirectIfRenamed } from "../lib/renamed.server";
import { pagePath } from "../lib/workspace-nav";

/**
 * Any address no other route matches. Throwing the 404 from a route, rather
 * than leaving the router to, means the root loader still runs, so someone
 * signed in sees the page in their own sidebar and not the public frame.
 *
 * An address under a renamed workspace's old name, or under an alias, is
 * sent to the workspace's name first, so deep links keep working the same
 * as its pages do.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const first = pagePath(new URL(request.url).pathname).split("/")[1];
  if (first) await redirectIfRenamed(request, first);
  throw data(null, { status: 404 });
}

export default function NotFound() {
  return null;
}
