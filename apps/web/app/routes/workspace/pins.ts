/**
 * Pinning a workspace's projects, for the person signed in: `intent` pin
 * (with `slug`, and `position` to put it somewhere other than the end),
 * unpin (with `slug`), or reorder (with every pinned `slug`, in order).
 * Posted by the pin buttons on a project's header and the Projects page,
 * and by dragging pins in the sidebar (lib/pins.ts). The projects service
 * keeps them; the sidebar and pages reload after.
 */
import { data, redirect } from "react-router";

import type { Route } from "./+types/pins";
import { pinFromForm } from "../../lib/pins";
import { projects } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

/** Nothing to see here: the workspace's projects are. */
export function loader({ params }: Route.LoaderArgs) {
  return redirect(`/${params.owner}/-/projects`);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const change = pinFromForm(await request.formData());
  if (!change) return data({ error: "Nothing to do." }, { status: 400 });
  try {
    const result =
      change.intent === "pin"
        ? await projects.pin(user, params.owner, change.slug, change.position)
        : change.intent === "unpin"
          ? await projects.unpin(user, params.owner, change.slug)
          : await projects.reorderPins(user, params.owner, change.slugs);
    if (!result.ok) return data({ error: result.error.message }, { status: result.error.code === "not_found" ? 404 : 400 });
    return { error: null, pinned: result.value.map((project) => project.slug) };
  } catch {
    return data({ error: "That did not save. Try again in a moment." }, { status: 503 });
  }
}
