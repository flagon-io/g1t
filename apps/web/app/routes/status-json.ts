/** The status JSON moved with the page, to status.g1t.sh. */
import { redirect } from "react-router";

import { STATUS_JSON_URL } from "../lib/status";

export function loader() {
  return redirect(STATUS_JSON_URL, 301);
}
