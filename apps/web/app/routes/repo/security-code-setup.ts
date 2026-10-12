/**
 * "Set up code scanning": commits the starter workflow on a new branch as
 * the person asking and opens it as their pull request, then goes to it.
 * It changes the repository's workflows: Maintain, as settings do.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/security-code-setup";
import { refusal } from "../../lib/access.server";
import { setupCodeScanning } from "../../lib/security-suite.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_settings");
  if (refused) return { error: refused };
  const opened = await setupCodeScanning(user, { namespace: params.owner, name: params.repo });
  if (!opened.ok) return { error: opened.message };
  throw redirect(`/${params.owner}/${params.repo}/pull/${opened.number}`);
}

export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/${params.owner}/${params.repo}/security/code-scanning`);
}
