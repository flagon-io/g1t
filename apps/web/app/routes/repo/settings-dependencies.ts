import { redirect } from "react-router";

import type { Route } from "./+types/settings-dependencies";

/**
 * Projects no longer declare which other projects they use. An old link to
 * that settings page lands on the project's settings.
 */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/${params.owner}/${params.repo}/settings`, 301);
}
