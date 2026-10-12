/**
 * Where a connector's sign-in comes back to: the server sends the browser
 * here with the `state` the sign-in started with and a `code` (or an
 * `error`). The agents service finishes the sign-in, lists the connector's
 * tools, and the browser lands on the connector's page saying so.
 */
import { data, redirect } from "react-router";

import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/connector-callback";
import { connectorPagePath } from "../../../lib/customize";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const back = (problem: string) => redirect(`${customizePath("connectors", slug)}?problem=${encodeURIComponent(problem)}`);
  const error = url.searchParams.get("error");
  if (error) return back(`The sign-in didn't finish: ${url.searchParams.get("error_description") || error}.`);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return back("The sign-in came back without what it needs. Start it again.");
  const done = await workspaceAgents.finishConnectorSignIn(slug, viewer, state, code).catch(() => null);
  if (!done) return back("The agents service didn't answer. Start the sign-in again in a moment.");
  if (!done.ok) return back(done.error.message);
  return redirect(`${connectorPagePath(slug, done.value.id)}?signed_in=1`);
}
