/**
 * The workspace's settings open on its Profile, as GitHub's organization
 * settings open on General: `-/settings` is the Profile's address.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/settings-index";
import { settingsPath } from "../../lib/workspace-nav";

export function loader({ params }: Route.LoaderArgs) {
  return redirect(settingsPath(params.owner));
}
