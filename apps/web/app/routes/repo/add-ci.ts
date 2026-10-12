/**
 * Adds a starter CI workflow to a repository that has no checks, as a pull
 * request opened by whoever asked, and goes to it. Posted by the "Add CI"
 * prompt (components/add-ci.tsx). Anyone who can push may.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/add-ci";
import { addCi } from "../../lib/add-ci.server";
import { refusal } from "../../lib/access.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "push");
  if (refused) return { error: refused };
  const added = await addCi(user, { namespace: params.owner, name: params.repo });
  if (!added.ok) return { error: added.message };
  throw redirect(`/${params.owner}/${params.repo}/pull/${added.value.number}`);
}

export async function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/${params.owner}/${params.repo}/actions`);
}
