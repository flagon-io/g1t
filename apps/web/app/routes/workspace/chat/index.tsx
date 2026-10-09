import { useEffect } from "react";
import { redirect, useNavigate } from "react-router";

import type { Route } from "./+types/index";
import { ChatUnavailable, NoChannels } from "../../../components/chat/empty";
import { ChatSidebar } from "../../../components/chat/sidebar";
import { NewMessageButton } from "../../../components/chat/actions";
import { isPhone } from "../../../lib/phone";
import { channelPath } from "../../../lib/chat";
import { LAST_CHAT_COOKIE, sidebarOrNull } from "../../../lib/chat.server";
import { readCookie } from "../../../lib/mission";
import { page } from "../../../lib/meta";
import { chat, workspaceAgents } from "../../../lib/services.server";
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
  // `?agent=<handle>`: the direct message with that agent, opened or made
  // (the top bar's Ask g1t, and links to an agent from anywhere).
  const asked = new URL(request.url).searchParams.get("agent");
  if (asked) {
    const listed = await workspaceAgents.list(slug, viewer).catch(() => null);
    const agent = listed?.ok ? listed.value.find((a) => a.handle === asked.toLowerCase()) : null;
    const dm = agent ? await chat.openDm(slug, viewer, [{ kind: "agent", id: agent.id }]).catch(() => null) : null;
    if (dm?.ok) throw redirect(channelPath(slug, dm.value));
  }
  // A phone opens on the list of conversations; a wider screen on one.
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
  const navigate = useNavigate();
  const { to } = loaderData;
  // Told it was a phone, but wider: on to the conversation after all.
  useEffect(() => {
    if (to && window.matchMedia("(min-width: 768px)").matches) navigate(to, { replace: true });
  }, [to, navigate]);
  return (
    <>
      {/* A phone: the list of conversations, full screen. */}
      <div className="h-[calc(100dvh-var(--topbar-h)-var(--tabbar-h))] md:hidden">
        <ChatSidebar slug={params.owner.toLowerCase()} heading={false} />
        <div className="fixed right-4 bottom-[calc(var(--tabbar-h)+1rem)] z-30">
          <NewMessageButton slug={params.owner.toLowerCase()} variant="fab" />
        </div>
      </div>
      <div className="max-md:hidden">{loaderData.unavailable ? <ChatUnavailable /> : to ? null : <NoChannels />}</div>
    </>
  );
}
