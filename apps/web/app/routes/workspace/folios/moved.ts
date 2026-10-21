/**
 * Artifacts are the Library's now: `/<ws>/-/artifacts/...` was their
 * address before, and every link to one (in chat, docs, email, bookmarks)
 * comes here and goes on to the same place under `-/library/artifacts/`,
 * query and all. `-/library` itself opens on its artifacts. 308 keeps the
 * method, so a form posted from a page opened before the move still lands.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/moved";
import { libraryAddress } from "../../../lib/folios";

function moved(request: Request): Response {
  const url = new URL(request.url);
  url.searchParams.delete("_routes");
  return redirect(libraryAddress(url.pathname, url.search), 308);
}

export function loader({ request }: Route.LoaderArgs) {
  return moved(request);
}

export function action({ request }: Route.ActionArgs) {
  return moved(request);
}
