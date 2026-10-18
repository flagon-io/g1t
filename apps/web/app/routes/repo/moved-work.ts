/**
 * A repository's issues, labels and milestones moved to its workspace's
 * Work, and its Work page became its Sessions page: old links are sent on
 * (lib/work-items.ts `movedWorkPath` says where). An old issue's address
 * is read as `#n` in the repository (lib/refs.ts): the work item its issue
 * became, or a pull request. A work item belongs to the workspace, so these
 * are open to every member, Code access or not (lib/workspace-nav.ts
 * `codeGate`).
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/moved-work";
import { refPath } from "../../lib/refs.server";
import { getViewer } from "../../lib/session.server";
import { movedWorkPath } from "../../lib/work-items";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const to = movedWorkPath(url.pathname, url.search);
  if (to == null) throw data(null, { status: 404 });
  if (typeof to === "string") return redirect(to, 301);
  const found = await refPath(getViewer(context), { repo: { namespace: params.owner.toLowerCase(), name: params.repo } }, to.resolve);
  if (!found) throw data(null, { status: 404 });
  return redirect(found, 301);
}
