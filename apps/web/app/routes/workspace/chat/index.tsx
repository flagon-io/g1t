import { useEffect } from "react";
import { redirect } from "react-router";
import { usePageNavigation } from "../../../lib/use-page-navigation";

import type { Route } from "./+types/index";
import type { Route as HomeRoute } from "../+types/home";
import { HomePage, loader as homeLoader } from "../home";
import { ChatUnavailable, NoChannels } from "../../../components/chat/empty";
import { ChatSidebar } from "../../../components/chat/sidebar";
import { NewChatButton, useChatData } from "../../../components/chat/actions";
import { isPhone } from "../../../lib/phone";
import { channelPath } from "../../../lib/chat";
import { LAST_CHAT_COOKIE, sidebarOrNull } from "../../../lib/chat.server";
import { readCookie } from "../../../lib/mission";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Chat · ${params.owner} · g1t` });
}

/**
 * Chat is the app a workspace opens on, and on a computer it opens on Home:
 * where you're needed and what happened while you were away (routes/
 * workspace/home.tsx), with your conversations and sessions beside it. A
 * phone opens on the list of conversations, and keeps Home as a tab of its
 * own. Someone in another workspace's chat as a guest has no Home there:
 * Chat opens where they left it, else #general, else the first there is.
 */
export async function loader(args: Route.LoaderArgs) {
  const { params, context, request } = args;
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const phone = isPhone(request.headers);
  if (!phone && roleIn(viewer, slug)) {
    const home = await homeLoader(args as unknown as HomeRoute.LoaderArgs);
    return { home, unavailable: false, phone, to: null };
  }
  const last = readCookie(request.headers.get("cookie"), LAST_CHAT_COOKIE);
  const remembered = last && last.startsWith(`/${slug}/-/chat/`) && !last.includes("..") ? last : null;
  if (remembered && !phone) throw redirect(remembered);
  const sidebar = await sidebarOrNull(slug, viewer);
  if (!sidebar) return { home: null, unavailable: true, phone, to: null };
  const entries = sidebar.entries;
  const first =
    entries.find((entry) => entry.channel.kind === "channel" && entry.channel.name === "general") ??
    entries.find((entry) => entry.channel.kind === "channel") ??
    entries[0];
  const to = remembered ?? (first ? channelPath(slug, first.channel) : null);
  if (to && !phone) throw redirect(to);
  return { home: null, unavailable: false, phone, to };
}

export default function ChatIndex({ loaderData, params }: Route.ComponentProps) {
  const { navigate } = usePageNavigation();
  const { to, home } = loaderData;
  const slug = params.owner.toLowerCase();
  const data = useChatData();
  // Told it was a phone, but wider: on to Home, or the conversation, after all.
  useEffect(() => {
    if (!home && window.matchMedia("(min-width: 768px)").matches) navigate(to ?? `/${slug}/-/home`, { replace: true });
  }, [home, to, slug, navigate]);
  // Home drawn here takes its data as a prop: its route's own export would read this route's data instead.
  // A page of its own per workspace, so nothing of the last one is held over after switching.
  if (home) return <HomePage key={slug} data={home} />;
  return (
    <>
      {/* A phone: the list of conversations, full screen. */}
      <div className="h-[calc(100dvh-var(--topbar-h)-var(--tabbar-h))] md:hidden">
        <ChatSidebar slug={slug} heading={false} />
        {/* New chat, as the sidebar's wide button on a computer: New on its g1t tab. Not for a guest. */}
        {data?.role != null && (
          <div className="fixed right-4 bottom-[calc(var(--tabbar-h)+1rem)] z-30">
            <NewChatButton slug={slug} variant="fab" />
          </div>
        )}
      </div>
      <div className="max-md:hidden">{loaderData.unavailable ? <ChatUnavailable /> : to ? null : <NoChannels />}</div>
    </>
  );
}
