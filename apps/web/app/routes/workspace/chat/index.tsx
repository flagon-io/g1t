import { useEffect } from "react";
import { redirect } from "react-router";
import { usePageNavigation } from "../../../lib/use-page-navigation";

import type { Route } from "./+types/index";
import { ChatUnavailable, NoChannels } from "../../../components/chat/empty";
import { ChatSidebar } from "../../../components/chat/sidebar";
import { NewChatButton, useChatData } from "../../../components/chat/actions";
import { isPhone } from "../../../lib/phone";
import { channelPath } from "../../../lib/chat";
import { LAST_CHAT_COOKIE, sidebarOrNull } from "../../../lib/chat.server";
import { readCookie } from "../../../lib/mission";
import { page } from "../../../lib/meta";
import { requireUser } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Chat · ${params.owner} · g1t` });
}

/**
 * Chat opens on the conversation you were in, else #general, else the
 * first there is; a phone opens on the list of conversations. Home, the
 * workspace's front page, is a tab of its own (routes/workspace/home.tsx).
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const phone = isPhone(request.headers);
  const last = readCookie(request.headers.get("cookie"), LAST_CHAT_COOKIE);
  const remembered = last && last.startsWith(`/${slug}/-/chat/`) && !last.includes("..") ? last : null;
  if (remembered && !phone) throw redirect(remembered);
  const sidebar = await sidebarOrNull(slug, viewer);
  if (!sidebar) return { unavailable: true, phone, to: null };
  const entries = sidebar.entries;
  const first =
    entries.find((entry) => entry.channel.kind === "channel" && entry.channel.name === "general") ??
    entries.find((entry) => entry.channel.kind === "channel") ??
    entries[0];
  const to = remembered ?? (first ? channelPath(slug, first.channel) : null);
  if (to && !phone) throw redirect(to);
  return { unavailable: false, phone, to };
}

export default function ChatIndex({ loaderData, params }: Route.ComponentProps) {
  const { navigate } = usePageNavigation();
  const { to } = loaderData;
  const slug = params.owner.toLowerCase();
  const data = useChatData();
  // Told it was a phone, but wider: on to the conversation after all.
  useEffect(() => {
    if (to && window.matchMedia("(min-width: 768px)").matches) navigate(to, { replace: true });
  }, [to, navigate]);
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
