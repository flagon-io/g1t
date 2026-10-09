import { redirect } from "react-router";

import type { Route } from "./+types/index";
import { ChatUnavailable, NoChannels } from "../../../components/chat/empty";
import { channelPath } from "../../../lib/chat";
import { LAST_CHAT_COOKIE, sidebarOrNull } from "../../../lib/chat.server";
import { readCookie } from "../../../lib/mission";
import { page } from "../../../lib/meta";
import { requireUser } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Chat · ${params.owner} · g1t` });
}

/**
 * Chat opens where it was left: the last conversation open in this
 * workspace, else #general, else the first there is.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const last = readCookie(request.headers.get("cookie"), LAST_CHAT_COOKIE);
  if (last && last.startsWith(`/${slug}/-/chat/`) && !last.includes("..")) throw redirect(last);
  const sidebar = await sidebarOrNull(slug, viewer);
  if (!sidebar) return { unavailable: true };
  const entries = sidebar.entries;
  const first =
    entries.find((entry) => entry.channel.kind === "channel" && entry.channel.name === "general") ??
    entries.find((entry) => entry.channel.kind === "channel") ??
    entries[0];
  if (first) throw redirect(channelPath(slug, first.channel));
  return { unavailable: false };
}

export default function ChatIndex({ loaderData }: Route.ComponentProps) {
  return loaderData.unavailable ? <ChatUnavailable /> : <NoChannels />;
}
