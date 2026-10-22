import { redirect } from "react-router";

import type { Route } from "./+types/cycles-index";
import { cyclePath } from "../../../lib/cycles";

/** `-/work/cycles`: the current cycle's page, which lists the past ones. */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(cyclePath(params.owner));
}
