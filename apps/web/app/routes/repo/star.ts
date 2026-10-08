/**
 * Starring a repository, or taking the star back (`intent` star or
 * unstar), from the Star button in the project's header
 * (components/star-button.tsx).
 */
import { data } from "react-router";

import type { Route } from "./+types/star";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "star" && intent !== "unstar") return data({ error: "Nothing to do.", stars: null }, { status: 400 });
  try {
    const found = await repos.star(user, { namespace: params.owner, name: params.repo }, intent === "star");
    if (!found.ok) return data({ error: found.error.message, stars: null }, { status: found.error.code === "not_found" ? 404 : 403 });
    return { error: null, stars: found.value };
  } catch {
    return data({ error: "That did not save. Try again in a moment.", stars: null }, { status: 503 });
  }
}
