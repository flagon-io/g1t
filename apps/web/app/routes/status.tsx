/**
 * The status page moved to status.g1t.sh, a Worker of its own that stays
 * up when the site does not. Old links land there.
 */
import { redirect } from "react-router";

import { STATUS_URL } from "../lib/status";

export function loader() {
  return redirect(`${STATUS_URL}/`, 301);
}
