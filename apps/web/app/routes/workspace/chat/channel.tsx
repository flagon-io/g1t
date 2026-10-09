import { type ShouldRevalidateFunctionArgs, data } from "react-router";

import type { Channel, ChannelMember, ChatMessage, User } from "@g1t/contracts";

import type { Route } from "./+types/channel";
import { ChannelView } from "../../../components/chat/channel";
import { ChatUnavailable } from "../../../components/chat/empty";
import { channelPath } from "../../../lib/chat";
import { rememberChat } from "../../../lib/chat.server";
import { page } from "../../../lib/meta";
import { chat } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const title = loaderData && "title" in loaderData ? loaderData.title : "Chat";
  return page(args, { title: `${title} · ${params.owner} · g1t` });
}

export type ChannelData =
  | { unavailable: true; title: string }
  | {
      unavailable: false;
      title: string;
      channel: Channel;
      members: ChannelMember[];
      messages: ChatMessage[];
      older: string | null;
      /** Whether the viewer is in it: a public channel can be read before joining. */
      joined: boolean;
    };

/**
 * One conversation: a channel by its name (`-/chat/general`) or a direct
 * message by its id (`-/chat/dm/<id>`), with its latest messages. Live
 * updates arrive over the socket once the page is open.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const name = "channel" in params ? (params.channel as string | undefined) : undefined;
  const fallbackTitle = name ? `#${name}` : "Direct message";
  const read = await readConversation(slug, viewer, name, "id" in params ? (params.id as string | undefined) : undefined).catch(
    (error: unknown) => {
      console.error("chat: the conversation could not be read", error);
      return "unavailable" as const;
    },
  );
  if (read === "missing") throw data(null, { status: 404 });
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
  };
}

/** Opening a thread (`?thread=`) is the same page: nothing to load again. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

export default function ChannelPage({ loaderData }: Route.ComponentProps) {
  if (loaderData.unavailable) return <ChatUnavailable title={loaderData.title} />;
  return <ChannelView key={loaderData.channel.id} data={loaderData} />;
}
