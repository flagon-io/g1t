import { Outlet, data, type ShouldRevalidateFunctionArgs } from "react-router";

import type { ChatSidebar, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import type { Mentionable } from "../../../lib/chat";
import { sidebarOrNull, workspacePeople } from "../../../lib/chat.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * Chat mode: what its sidebar shows (the shell draws it, from this data)
 * and who can be mentioned or messaged. Each part is empty rather than an
 * error when its service does not answer.
 */
export type ChatLayoutData = {
  slug: string;
  me: { id: string; username: string; avatar: string | null };
  sidebar: ChatSidebar | null;
  people: Mentionable[];
  agents: WorkspaceAgent[];
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<ChatLayoutData> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [sidebar, { people, agents }] = await Promise.all([sidebarOrNull(slug, viewer), workspacePeople(slug, viewer)]);
  return { slug, me: { id: viewer.id, username: viewer.username, avatar: viewer.avatar ?? null }, sidebar, people, agents };
}

/**
 * Moving between conversations keeps the sidebar: it refreshes itself
 * (components/chat/sidebar.tsx) and after anything is sent.
 */
export function shouldRevalidate({ currentParams, nextParams, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner;
}

export default function ChatLayout() {
  return <Outlet />;
}
