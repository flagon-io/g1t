import { Outlet, data, type ShouldRevalidateFunctionArgs } from "react-router";

import { type DocsSidebar as Sidebar, shownUsername } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import type { DocMentionable } from "../../../components/docs/editor";
import { workspacePeople } from "../../../lib/chat.server";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * Docs mode: what its sidebar shows (the shell draws it from this data:
 * spaces and their page trees, favorites, recent pages) and who can be
 * mentioned in a page. Each part is empty rather than an error when its
 * service does not answer.
 */
export type DocsLayoutData = {
  slug: string;
  role: string;
  me: { key: string; name: string; display_name: string; avatar: string | null };
  sidebar: Sidebar | null;
  mentionables: DocMentionable[];
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<DocsLayoutData> {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [sidebar, { people, agents }] = await Promise.all([
    docs
      .sidebar(slug, viewer)
      .then((r) => (r.ok ? r.value : null))
      .catch(() => null),
    workspacePeople(slug, viewer).catch(() => ({ people: [], agents: [] })),
  ]);
  const self = people.find((p) => p.name === viewer.username.toLowerCase());
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
  };
}

/**
 * The tree changes when something is made, renamed, moved or trashed (a
 * submission, or the page asking again with `useRevalidator`); not when
 * moving between pages.
 */
export function shouldRevalidate({ currentParams, nextParams, currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner;
}

export default function DocsLayout() {
  return <Outlet />;
}
