/** Customize opens on Skills. */
import { redirect } from "react-router";

import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/index";

export function loader({ params, request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`${customizePath("skills", params.owner.toLowerCase())}${search}`);
}
