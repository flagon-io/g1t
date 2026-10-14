/**
 * A file's blame at a ref, as JSON, for the blame view to fetch once the
 * file is on screen: `/<owner>/<repo>/blame/<ref>/<path>`. A first blame
 * walks the file's history in repos and can take longer than the page's
 * stream may stay open (entry.server.tsx `streamTimeout`), so it is asked
 * for on its own request instead; once worked out, repos keeps it and it
 * comes back at once. Kept out of indexes like the blame view
 * (lib/robots.ts).
 */
import type { Route } from "./+types/blame-data";
import { showCommits } from "../../lib/commit-people.server";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

const HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const file = params["*"] ?? "";
  const found = await repos.blame(path, viewer, params.ref, file).catch(() => null);
  if (!found?.ok) {
    const status = found?.error.code === "not_found" ? 404 : 502;
    return Response.json({ blame: null }, { status, headers: HEADERS });
  }
  // Every commit's people at once.
  const blame = { ...found.value, commits: await showCommits(found.value.commits) };
  return Response.json({ blame }, { headers: HEADERS });
}
