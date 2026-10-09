/**
 * People to invite, as the People page's invite form asks while someone
 * types (components/people-picker.tsx): accounts whose username starts with
 * `q`, or whose name contains it. A username, a name and an avatar each,
 * never an email address. Signed in only. `-` is no workspace's name, so
 * nothing else is ever found here.
 */
import type { Route } from "./+types/people-json";
import { peopleQuery } from "../lib/people-search";
import { identity } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const headers = { "cache-control": "private, max-age=30", vary: "Cookie" };
  if (!viewer || (viewer.kind ?? "user") !== "user") return Response.json({ people: [] }, { status: 401, headers });
  const query = peopleQuery(new URL(request.url).searchParams.get("q") ?? "");
  const people = query ? await identity.findPeople(query, 8).catch(() => []) : [];
  return Response.json({ people }, { headers });
}
