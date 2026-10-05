import { redirect } from "react-router";

import type { Route } from "./+types/logout";
import { assertSameOrigin, endSession, nextPath } from "../lib/session.server";

/**
 * Signs out, then goes home, or to `next` (a path on g1t only): "Switch
 * account" signs out to the sign-in page, which brings them back.
 */
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  throw redirect(nextPath(request), {
    headers: { "set-cookie": await endSession(request) },
  });
}

export function loader() {
  throw redirect("/");
}
