import type { Route } from "./+types/cycle-json";
import { sidebarCycle, utcToday } from "../../../lib/cycles";
import { work } from "../../../lib/services.server";
import { getViewer } from "../../../lib/session.server";

/**
 * The current cycle as Work's sidebar shows it (components/shell.tsx):
 * its number, the days left and how much is done, read by the sidebar
 * itself once it opens. `{ cycle: null }` while cycles are off, and
 * `{ cycle: null, failed: true }` when the work service could not say, so
 * the sidebar leaves the row out rather than guess.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const found = await work.listCycles(workspace, viewer, 0).catch(() => null);
  const headers = { "cache-control": "private, no-store" };
  if (!found) return Response.json({ cycle: null, failed: true }, { headers });
  const cycle = found.ok ? sidebarCycle(found.value.current, utcToday(Date.now())) : null;
  return Response.json({ cycle }, { headers });
}
