import { Outlet, data, type ShouldRevalidateFunctionArgs } from "react-router";

import { type FoliosSidebar as Sidebar, shownUsername } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import type { DocMentionable } from "../../../components/folios/doc/editor";
import { workspacePeople } from "../../../lib/chat.server";
import { readCookie } from "../../../lib/mission";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { knownTimeZone } from "../../../lib/time-zone";

/**
 * Artifacts mode (code says "folio"): what its
 * sidebar shows (the shell draws it from this data: favorites, spaces and
 * their trees, Private, Shared, projects' docs), who can be mentioned or
 * shared with, and the viewer's time zone for the home list's days. Each
 * part is empty rather than an error when its service does not answer.
 */
export type FoliosLayoutData = {
  slug: string;
  role: string;
  me: { key: string; name: string; display_name: string; avatar: string | null };
  sidebar: Sidebar | null;
  mentionables: DocMentionable[];
  /** The viewer's zone, as their browser last told the site (Home sets it); null until then. */
  zone: string | null;
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<FoliosLayoutData> {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [sidebar, { people, agents }] = await Promise.all([
    folios
      .sidebar(slug, viewer)
      .then((r) => (r.ok ? r.value : null))
      .catch(() => null),
    workspacePeople(slug, viewer).catch(() => ({ people: [], agents: [] })),
  ]);
  const self = people.find((p) => p.name === viewer.username.toLowerCase());
  const zone = readCookie(request.headers.get("cookie"), "g1t_tz");
  return {
    slug,
    role,
    me: {
      key: `user:${viewer.id}`,
      name: viewer.username.toLowerCase(),
      display_name: self?.display_name ?? shownUsername({ username: viewer.username, display_username: viewer.display_username ?? null }),
      avatar: viewer.avatar ?? null,
    },
    sidebar,
    mentionables: [
      ...people.map((p): DocMentionable => ({ kind: "user", id: p.name, name: p.name, display_name: p.display_name, avatar: p.avatar })),
      ...agents.map((a): DocMentionable => ({ kind: "agent", id: a.id, name: a.handle, display_name: a.display_name, avatar: a.avatar, avatar_seed: a.avatar_seed ?? null })),
    ],
    zone: zone && knownTimeZone(zone) ? zone : null,
  };
}

/**
 * The sidebar changes when something is made, renamed, moved, shared or
 * trashed (a submission, or a page asking again with `useRevalidator`);
 * not when moving between pages.
 */
export function shouldRevalidate({ currentParams, nextParams, currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner;
}

export default function FoliosLayout() {
  return <Outlet />;
}
