/**
 * Sessions are Chat's now, beside the people you talk to: `-/work/sessions`
 * and each session under it were their addresses before, and every link to
 * them (in notifications, chat, the CLI's output) goes on to the same place
 * under `-/chat/sessions`, filters and all.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/moved";
import { movedSessionsPath } from "../../../../lib/work-items";

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  url.searchParams.delete("_routes");
  const search = url.searchParams.toString();
  return redirect(movedSessionsPath(url.pathname, search ? `?${search}` : "") ?? "/", 301);
}
