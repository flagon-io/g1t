import type { Route } from "./+types/projects-json";
import { sidebarProjects } from "../../../lib/projects";
import { work } from "../../../lib/services.server";
import { getViewer } from "../../../lib/session.server";

/**
 * The live projects Work's sidebar lists (components/shell.tsx), read by
 * the sidebar itself once it opens: active first, then shaping and
 * paused, each by name, with its health. `{ projects: null }` when the
 * work service could not say, so the sidebar says so instead of "none".
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const found = await work.listProjects(workspace, viewer).catch(() => null);
  const headers = { "cache-control": "private, no-store" };
  if (!found) return Response.json({ projects: null }, { headers });
  if (!found.ok) return Response.json({ projects: [] }, { headers });
  const projects = sidebarProjects(found.value).map(({ slug, name, color, icon, health, state }) => ({ slug, name, color, icon, health, state }));
  return Response.json({ projects }, { headers });
}
