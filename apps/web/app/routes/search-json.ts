/**
 * What the command palette shows as someone types: a few repositories,
 * issues, pull requests and people, as the viewer may see them. Signed out,
 * public ones only.
 */
import type { Route } from "./+types/search-json";
import { search } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 256);
  const headers = { "cache-control": "no-store" };
  if (q.length < 2) return Response.json({ q, hits: [] }, { headers });
  try {
    return Response.json({ q, hits: await search.suggest(getViewer(context), q) }, { headers });
  } catch {
    return Response.json({ q, hits: [] }, { headers });
  }
}
