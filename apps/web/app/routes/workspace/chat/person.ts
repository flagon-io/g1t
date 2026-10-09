import { data } from "react-router";

import type { Route } from "./+types/person";
import { buildCard } from "../../../lib/hovercard";
import { identity, repos } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * A person's card in Chat (components/chat/profile-card.tsx): their public
 * profile as the hovercard has it, and the teams they are on in this
 * workspace that the viewer can see. Kept a minute by the browser.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [card, teams] = await Promise.all([
    buildCard(
      params.username,
      viewer,
      null,
      {
        profile: (username) => identity.profile(username),
        accountId: async (username) => (await identity.userByUsername(username))?.id ?? null,
        publicNamespaces: (id) => repos.publicNamespaces(id),
        profileWorkspaces: (username, who, publicIn) => identity.profileWorkspaces(username, who, publicIn),
        contributors: (path, who) => repos.contributors(path, who),
      },
      Date.now(),
    ).catch(() => null),
    identity.userTeams(viewer, params.owner, params.username).catch(() => null),
  ]);
  const headers = { "cache-control": "private, max-age=60", vary: "Cookie" };
  if (!card || card.kind !== "user") return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json({ ...card, teams: teams?.ok ? teams.value.map((team) => ({ slug: team.slug, name: team.name })) : [] }, { headers });
}
