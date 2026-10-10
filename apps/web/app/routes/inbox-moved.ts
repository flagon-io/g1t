/** `/inbox` is Notifications now: the page, with the same query. */
import { redirect } from "react-router";

import type { Route } from "./+types/inbox-moved";

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  url.searchParams.delete("_routes");
  const query = url.searchParams.toString();
  return redirect(`/notifications${query ? `?${query}` : ""}`, 301);
}
