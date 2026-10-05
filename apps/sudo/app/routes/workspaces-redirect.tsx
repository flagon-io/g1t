import { redirect } from "react-router";

import type { Route } from "./+types/workspaces-redirect";
import { requireStaff } from "~/lib/staff";

/** The workspaces list lives at `/`; `/workspaces` goes there too. */
export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  return redirect(`/${new URL(request.url).search}`);
}

export default function WorkspacesRedirect() {
  return null;
}
