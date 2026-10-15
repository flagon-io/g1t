import { useEffect } from "react";
import { type ShouldRevalidateFunctionArgs, data, redirect } from "react-router";


import type { Channel, ChannelAccessRequest, ChannelDetail, ChannelInvitation, ChannelMember, ChatMessage, User } from "@g1t/contracts";

import type { Route } from "./+types/channel";
import { ChannelView } from "../../../components/chat/channel";
import { conversationCache } from "../../../components/chat/conversation-cache";
import { ChatUnavailable, RequestAccess } from "../../../components/chat/empty";
import { channelPath } from "../../../lib/chat";
import { rememberChat } from "../../../lib/chat.server";
import { page } from "../../../lib/meta";
import { chat, identity } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const title = loaderData && "title" in loaderData ? loaderData.title : "Chat";
  return page(args, { title: `${title} · ${params.owner} · g1t` });
}

export type ChannelData =
  | {
      unavailable: true;
      title: string;
      /**
       * A channel by name the viewer cannot open: private, kept to a
       * workspace they are not in, or not there at all (which looks the
       * same). They may ask to be let in.
       */
      locked?: { name: string; workspace: { slug: string; name: string }; member: boolean };
    }
  | {
      unavailable: false;
      title: string;
      channel: Channel;
      members: ChannelMember[];
      messages: ChatMessage[];
      older: string | null;
      /** Whether the viewer is in it: a public channel can be read before joining. */
      joined: boolean;
      /** Whether the viewer may rename, archive and unarchive it (the workspace's chat settings). */
      can_manage?: boolean;
      /** What else the viewer may do there, and who is asked in or asks to come in (`ChannelDetail`). */
      can_make_public?: boolean;
      can_invite_guests?: boolean;
      can_remove_members?: boolean;
      /** The viewer is not a member of the workspace: a guest here. */
      guest?: boolean;
      workspace?: ChannelDetail["workspace"];
      invited?: ChannelInvitation[];
      requests?: ChannelAccessRequest[];
    };

/**
 * One conversation: a channel by its name (`-/chat/general`) or a direct
 * message by its id (`-/chat/dm/<id>`), with its latest messages. Live
 * updates arrive over the socket once the page is open.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  // Members and guests alike: the chat service answers with what the viewer may read.
  const member = roleIn(viewer, params.owner) != null;
  const slug = params.owner.toLowerCase();
  const name = "channel" in params ? (params.channel as string | undefined) : undefined;
  // `-/chat/dm/g1t`: the viewer's direct message with @g1t, opened on first use; members only.
  if (!member && "id" in params) throw data(null, { status: 404 });
  if ("id" in params && params.id === "g1t") {
    const opened = await chat.g1tDm(slug, viewer).catch(() => null);
    if (opened?.ok) throw redirect(channelPath(slug, opened.value));
  }
  const fallbackTitle = name ? `#${name}` : "Direct message";
  const read = await readConversation(slug, viewer, name, "id" in params ? (params.id as string | undefined) : undefined).catch(
    (error: unknown) => {
      console.error("chat: the conversation could not be read", error);
      return "unavailable" as const;
    },
  );
  if (read === "missing") {
    // A channel's link that does not open: offer to ask to be let in, the same whether or not it is there.
    if (!name) throw data(null, { status: 404 });
    const workspace = await identity.getWorkspace(slug).catch(() => null);
    if (!workspace) throw data(null, { status: 404 });
    return data(
      { unavailable: true, title: `#${name}`, locked: { name, workspace: { slug: workspace.slug.toLowerCase(), name: workspace.name }, member } } satisfies ChannelData,
      { status: 403 },
    );
  }
  if (read === "unavailable") return { unavailable: true, title: fallbackTitle } satisfies ChannelData;
  const secure = new URL(request.url).protocol === "https:";
  return data(read, { headers: { "Set-Cookie": rememberChat(channelPath(slug, read.channel), secure) } });
}

/** The conversation and its latest messages; "missing" for a 404, "unavailable" when chat does not answer. */
async function readConversation(
  slug: string,
  viewer: User,
  name: string | undefined,
  byId: string | undefined,
): Promise<Extract<ChannelData, { unavailable: false }> | "missing" | "unavailable"> {
  // A channel's address is its name; a direct message's, its id.
  const lookup = byId ? chat.channel(slug, byId, viewer) : name ? chat.channelByName(slug, name, viewer) : null;
  if (!lookup) return "missing";
  const detail = await lookup;
  if (!detail.ok) return detail.error.code === "not_found" || detail.error.code === "forbidden" ? "missing" : "unavailable";
  const history = await chat.messages(slug, detail.value.channel.id, viewer, { limit: 60 });
  const { channel, members } = detail.value;
  // A public channel can be read before joining it.
  const joined = members.some((m) => m.member.kind === "user" && m.member.id === viewer.id);
  const others = members.filter((m) => !(m.member.kind === "user" && m.member.id === viewer.id));
  const title =
    channel.kind === "channel"
      ? `#${channel.name}`
      : others.map((m) => m.member.display_name || m.member.name).join(", ") || "Direct message";
  return {
    unavailable: false,
    title,
    channel,
    members,
    messages: history.ok ? history.value.messages : [],
    older: history.ok ? history.value.older : null,
    joined,
    can_manage: detail.value.can_manage === true,
    can_make_public: detail.value.can_make_public === true,
    can_invite_guests: detail.value.can_invite_guests === true,
    can_remove_members: detail.value.can_remove_members === true,
    guest: detail.value.guest === true,
    workspace: detail.value.workspace,
    invited: detail.value.invited ?? [],
    requests: detail.value.requests ?? [],
  };
}

/** Opening a thread (`?thread=`) is the same page: nothing to load again. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

/** Conversations already seen in this tab (lib/chat-cache.ts), kept by the page as it changes. */
const cache = conversationCache;

/**
 * Switching conversations: one seen before draws at once from the cache,
 * and the server is asked again behind it; what it answers is merged in by
 * id (components/chat/channel.tsx listens for `g1t:chat-fresh`). One not
 * seen waits for the server, and is kept for next time.
 */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  const key = new URL(request.url).pathname;
  const kept = cache.peek(key) ?? (await cache.load(key));
  const fresh = serverLoader().then((value) => {
    if (!value.unavailable) {
      cache.set(key, value);
      window.dispatchEvent(new CustomEvent("g1t:chat-fresh", { detail: { key, value } }));
    }
    return value;
  });
  if (kept && !kept.unavailable) {
    fresh.catch(() => undefined);
    return kept;
  }
  return fresh;
}

export default function ChannelPage({ loaderData }: Route.ComponentProps) {
  // What the server drew first is kept too, for coming back.
  useEffect(() => {
    if (!loaderData.unavailable) cache.set(window.location.pathname, loaderData);
  }, [loaderData]);
  if (loaderData.unavailable) return "locked" in loaderData && loaderData.locked ? <RequestAccess {...loaderData.locked} /> : <ChatUnavailable title={loaderData.title} />;
  return <ChannelView key={loaderData.channel.id} data={loaderData} />;
}
