import { redirect } from "react-router";

import type { Route } from "./+types/logout";
import { assertSameOrigin, endSession } from "../lib/session.server";

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  throw redirect("/", {
    headers: { "set-cookie": await endSession(request) },
  });
}

export function loader() {
  throw redirect("/");
}
