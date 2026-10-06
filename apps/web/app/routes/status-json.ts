/**
 * The live status as JSON: what /status shows and what the footer's dot
 * is coloured by. Public, with no viewer in it, so browsers and the edge
 * may keep it for a minute.
 */
import { STATUS_HEADERS, currentStatus } from "../lib/status.server";

export async function loader() {
  return Response.json(await currentStatus(), { headers: STATUS_HEADERS });
}
