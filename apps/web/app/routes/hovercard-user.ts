/**
 * The card over a person's name or avatar, fetched when it first opens
 * (components/user-card.tsx): their public profile, the workspaces the
 * viewer may know they belong to, and, given `?repo=owner/name` the viewer
 * can read, how recently they committed there. Works signed out, with
 * public answers only. Kept a minute by the browser, for this viewer only.
 */
import type { Route } from "./+types/hovercard-user";
import { buildCard, parseRepo } from "../lib/hovercard";
import { identity, repos } from "../lib/services.server";
import { getViewer } from "../lib/session.server";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = parseRepo(new URL(request.url).searchParams.get("repo"));
  const card = await buildCard(
    params.username,
    viewer,
    repo,
    {
      profile: (username) => identity.profile(username),
      accountId: async (username) => (await identity.userByUsername(username))?.id ?? null,
      publicNamespaces: (id) => repos.publicNamespaces(id),
      profileWorkspaces: (username, who, publicIn) => identity.profileWorkspaces(username, who, publicIn),
      contributors: (path, who) => repos.contributors(path, who),
    },
    Date.now(),
  );
  const headers = { "cache-control": "private, max-age=60", vary: "Cookie" };
  if (!card) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json(card, { headers });
}
