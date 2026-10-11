import type { ChatLiveEvent, ChatMessage, ChatSidebar, MessagePage } from "@g1t/contracts";
import { type InfiniteData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Client } from "./client";
import { socketUrl } from "./server";
import { useSignedIn } from "./session";

/**
 * Chat, through the site's routes, as the site's own Chat pages use them
 * (apps/web/app/routes/workspace/chat/api.ts):
 *
 * - `GET /<workspace>/-/chat/api`: the sidebar.
 * - `GET /<workspace>/-/chat/api?channel=<id>&before=<id>`: a page of messages.
 * - `POST /<workspace>/-/chat/api` with `{ intent, … }`: post, read, react.
 * - `wss://<site>/<workspace>/-/chat/live?channel=<id>`: what happens, live.
 *   A socket cannot carry a header, so it asks `GET /-/live/ticket` for a
 *   ticket first (apps/web/app/lib/socket-ticket.ts).
 */

const chatPath = (workspace: string) => `/${encodeURIComponent(workspace)}/-/chat/api`;

export function useChatSidebar() {
  const { client, workspace } = useSignedIn();
  const slug = workspace?.slug ?? "";
  return useQuery({
    queryKey: ["chat", slug, "sidebar"],
    queryFn: () => client.site<ChatSidebar>(chatPath(slug)),
    enabled: !!slug,
  });
}

export function useMessages(channelId: string, thread?: string | null) {
  const { client, workspace } = useSignedIn();
  const slug = workspace?.slug ?? "";
  return useInfiniteQuery({
    queryKey: ["chat", slug, "messages", channelId, thread ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ channel: channelId, limit: "60" });
      if (thread) query.set("thread", thread);
      if (pageParam) query.set("before", pageParam);
      return client.site<MessagePage>(`${chatPath(slug)}?${query}`);
    },
    getNextPageParam: (page) => page.older,
    enabled: !!slug && !!channelId,
  });
}

/** Sends a message; it appears through the live socket, or on the next read. */
export function usePostMessage(channelId: string, thread?: string | null) {
  const { client, workspace } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";
  return useMutation({
    mutationFn: (body: string) =>
      client.site<ChatMessage>(chatPath(slug), {
        method: "POST",
        body: JSON.stringify({ intent: "post", channel_id: channelId, body, thread_root: thread ?? null }),
      }),
    onSuccess: (message) => addMessage(queries, slug, message),
  });
}

/** Marks a channel read up to a message. */
export function markRead(client: Client, workspace: string, channelId: string, messageId: string) {
  return client
    .site(chatPath(workspace), { method: "POST", body: JSON.stringify({ intent: "read", channel_id: channelId, id: messageId }) })
    .catch(() => undefined);
}

type Pages = InfiniteData<MessagePage, string | null>;

/** Puts a message into the newest page of its channel's cache, once. */
function addMessage(queries: ReturnType<typeof useQueryClient>, workspace: string, message: ChatMessage) {
  queries.setQueryData<Pages>(["chat", workspace, "messages", message.channel_id, message.thread_root ?? null], (data) => {
    if (!data) return data;
    if (data.pages.some((page) => page.messages.some((one) => one.id === message.id))) return data;
    const [newest, ...rest] = data.pages;
    return { ...data, pages: [{ ...newest, messages: [...newest.messages, message] }, ...rest] };
  });
  void queries.invalidateQueries({ queryKey: ["chat", workspace, "sidebar"] });
}

function replaceMessage(queries: ReturnType<typeof useQueryClient>, workspace: string, message: ChatMessage) {
  queries.setQueryData<Pages>(["chat", workspace, "messages", message.channel_id, message.thread_root ?? null], (data) =>
    data
      ? { ...data, pages: data.pages.map((page) => ({ ...page, messages: page.messages.map((one) => (one.id === message.id ? message : one)) })) }
      : data,
  );
}

export type LiveStatus = "connecting" | "live" | "offline";

/**
 * Keeps a channel's messages live while its screen is open: opens the
 * channel's socket with a ticket, applies what it says to the cache, and
 * opens it again (with a new ticket) when it drops.
 */
export function useChannelLive(channelId: string): LiveStatus {
  const { client, workspace } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    if (!slug || !channelId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const open = async () => {
      setStatus("connecting");
      const path = `/${encodeURIComponent(slug)}/-/chat/live`;
      try {
        const token = await client.token();
        const response = await fetch(`${client.server.site}/-/live/ticket?path=${encodeURIComponent(path)}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        if (!response.ok) throw new Error(`ticket ${response.status}`);
        const { ticket } = (await response.json()) as { ticket: string };
        if (closed) return;
        const query = new URLSearchParams({ channel: channelId, ticket });
        socket = new WebSocket(`${socketUrl(client.server, path)}?${query}`);
      } catch {
        return again();
      }
      socket.onopen = () => {
        attempts = 0;
        setStatus("live");
      };
      socket.onmessage = (event) => {
        let live: ChatLiveEvent;
        try {
          live = JSON.parse(String(event.data)) as ChatLiveEvent;
        } catch {
          return;
        }
        if (live.type === "message.created") addMessage(queries, slug, live.message);
        else if (live.type === "message.updated") replaceMessage(queries, slug, live.message);
        else if (live.type === "message.deleted" || live.type.startsWith("reaction.")) {
          void queries.invalidateQueries({ queryKey: ["chat", slug, "messages", channelId] });
        }
      };
      socket.onclose = () => {
        if (!closed) again();
      };
    };

    const again = () => {
      setStatus("offline");
      if (closed) return;
      attempts += 1;
      retry = setTimeout(open, Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5)));
    };

    void open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [client, queries, slug, channelId]);

  return status;
}
