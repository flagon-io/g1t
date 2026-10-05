import { data, redirect } from "react-router";

import type { Route } from "./+types/legacy-accounts";
import { requireStaff } from "~/lib/staff";
import { legacyAccountPath } from "~/lib/workspaces";

/**
 * Old links: `/accounts` was the list, `/accounts/ws_<slug>` a workspace's
 * own account and `/accounts/ent_…` an enterprise.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  requireStaff(context);
  const id = (params["*"] ?? "").replace(/\/+$/, "");
  if (!id) return redirect(`/${new URL(request.url).search}`, 301);
  const path = legacyAccountPath(id);
  if (!path) throw data("That is not a workspace or an enterprise.", { status: 404 });
  return redirect(path, 301);
}

export default function LegacyAccounts() {
  return null;
}
