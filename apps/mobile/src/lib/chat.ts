import type { Channel, ChatLiveEvent, ChatMessage, ChatSidebar, MemberProfile, MessagePage } from "@g1t/contracts";
import { type InfiniteData, type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Client } from "./client";
import { openSocket } from "./live";
import { useSignedIn } from "./session";

/**
 * Chat, through the site's routes, as the site's own Chat pages use them
 * (apps/web/app/routes/workspace/chat/api.ts):
 *
 * - `GET /<workspace>/-/chat/api`: the sidebar.
 * - `GET /<workspace>/-/chat/api?channel=<id>[&thread=<id>]&before=<id>`: a page of messages.
 * - `POST /<workspace>/-/chat/api` with `{ intent, … }`: everything sent.
 * - `wss://<site>/<workspace>/-/chat/live?channel=<id>`: what happens in a
 *   conversation, live, and the one thing a client says there: typing.
 *
 * The app signs in with `chat:read` and `chat:write`, which the site takes
 * on these routes alone.
 */

const chatPath = (workspace: string) => `/${encodeURIComponent(workspace)}/-/chat/api`;

export const chatKeys = {
  all: (workspace: string) => ["chat", workspace] as const,
  sidebar: (workspace: string) => ["chat", workspace, "sidebar"] as const,
  browse: (workspace: string) => ["chat", workspace, "browse"] as const,
  messages: (workspace: string, channel: string, thread: string | null) => ["chat", workspace, "messages", channel, thread] as const,
};

/** A message as the app keeps it: a sent one may still be on its way, or have failed. */
export type Shown = ChatMessage & { local?: "sending" | "failed" };

type Pages = InfiniteData<MessagePage & { messages: Shown[] }, string | null>;

/** Posts an intent to the chat route and returns its value. */
export function sendIntent<T>(client: Client, workspace: string, intent: string, body: Record<string, unknown>): Promise<T> {
  return client.site<T>(chatPath(workspace), { method: "POST", body: JSON.stringify({ intent, ...body }) });
}

// ── Reading ────────────────────────────────────────────────────────────────

export function useChatSidebar() {
  const { client, workspace } = useSignedIn();
  const slug = workspace?.slug ?? "";
  return useQuery({
    queryKey: chatKeys.sidebar(slug),
    queryFn: () => client.site<ChatSidebar>(chatPath(slug)),
    enabled: !!slug,
  });
}

/** The workspace's channels, to find and join (`GET …/chat/api?browse=1`). */
export function useBrowseChannels() {
  const { client, workspace } = useSignedIn();
  const slug = workspace?.slug ?? "";
  return useQuery({
    queryKey: chatKeys.browse(slug),
    queryFn: () => client.site<Channel[]>(`${chatPath(slug)}?browse=1`),
    enabled: !!slug,
  });
}

export function useMessages(channelId: string, thread: string | null = null) {
  const { client, workspace } = useSignedIn();
  const slug = workspace?.slug ?? "";
  return useInfiniteQuery({
    queryKey: chatKeys.messages(slug, channelId, thread),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ channel: channelId, limit: "50" });
      if (thread) query.set("thread", thread);
      if (pageParam) query.set("before", pageParam);
      return client.site<MessagePage>(`${chatPath(slug)}?${query}`);
    },
    getNextPageParam: (page) => page.older,
    enabled: !!slug && !!channelId,
  });
}

// ── The cache, as messages arrive ───────────────────────────────────────────

function updatePages(queries: QueryClient, key: readonly unknown[], change: (messages: Shown[], index: number) => Shown[]) {
  queries.setQueryData<Pages>(key, (data) => (data ? { ...data, pages: data.pages.map((page, index) => ({ ...page, messages: change(page.messages, index) })) } : data));
}

/** A message, put where it belongs: replacing itself, or its local copy, or added as the newest. */
export function upsertMessage(queries: QueryClient, workspace: string, message: Shown, localId?: string) {
  const key = chatKeys.messages(workspace, message.channel_id, message.thread_root ?? null);
  const data = queries.getQueryData<Pages>(key);
  const had = !!data?.pages.some((page) => page.messages.some((one) => one.id === message.id));
  const hadLocal = !!localId && !!data?.pages.some((page) => page.messages.some((one) => one.id === localId));
  if (data) {
    if (had || hadLocal) {
      updatePages(queries, key, (messages) => {
        const replaced = messages.map((one) => (one.id === message.id || (localId && one.id === localId) ? message : one));
        // A local copy and the real one may both have arrived: keep one.
        return replaced.filter((one, index) => replaced.findIndex((other) => other.id === one.id) === index);
      });
    } else {
      updatePages(queries, key, (messages, index) => (index === 0 ? [...messages, message] : messages));
    }
  }
  // A reply new to the app also counts on its root, in the conversation.
  if (message.thread_root && !message.local && !had) {
    updatePages(queries, chatKeys.messages(workspace, message.channel_id, null), (messages) =>
      messages.map((one) => (one.id === message.thread_root ? { ...one, reply_count: one.reply_count + 1, last_reply_at: message.created_at } : one)),
    );
  }
}

function removeMessage(queries: QueryClient, workspace: string, channelId: string, id: string) {
  for (const [key] of queries.getQueriesData<Pages>({ queryKey: ["chat", workspace, "messages", channelId] })) {
    updatePages(queries, key, (messages) => messages.filter((one) => one.id !== id));
  }
}

function patchMessage(queries: QueryClient, workspace: string, channelId: string, id: string, change: (message: Shown) => Shown) {
  for (const [key] of queries.getQueriesData<Pages>({ queryKey: ["chat", workspace, "messages", channelId] })) {
    updatePages(queries, key, (messages) => messages.map((one) => (one.id === id ? change(one) : one)));
  }
}

/** A reaction added or taken away, by the viewer (`mine`) or someone else, on a message in the cache. */
function applyReaction(queries: QueryClient, workspace: string, channelId: string, messageId: string, emoji: string, member: MemberProfile | null, added: boolean, mine: boolean) {
  patchMessage(queries, workspace, channelId, messageId, (message) => {
    const reactions = [...(message.reactions ?? [])];
    const at = reactions.findIndex((one) => one.emoji === emoji);
    if (at === -1) {
      if (!added) return message;
      reactions.push({ emoji, count: 1, me: mine, by: member ? [member] : [] });
    } else {
      const one = reactions[at];
      if (mine && one.me === added) return message;
      const count = one.count + (added ? 1 : -1);
      if (count <= 0) reactions.splice(at, 1);
      else
        reactions[at] = {
          ...one,
          count,
          me: mine ? added : one.me,
          by: member ? (added ? [...one.by, member] : one.by.filter((m) => m.id !== member.id)) : one.by,
        };
    }
    return { ...message, reactions };
  });
}

/**
 * Live events carry every reaction's `me` as false, since the whole room
 * gets them: keep the viewer's own from the copy the app has.
 */
function keepMine(queries: QueryClient, workspace: string, message: ChatMessage): ChatMessage {
  for (const [, data] of queries.getQueriesData<Pages>({ queryKey: ["chat", workspace, "messages", message.channel_id] })) {
    const had = data?.pages.flatMap((page) => page.messages).find((one) => one.id === message.id);
    if (had) {
      const mine = new Set((had.reactions ?? []).filter((one) => one.me).map((one) => one.emoji));
      return { ...message, reactions: (message.reactions ?? []).map((one) => ({ ...one, me: mine.has(one.emoji) })) };
    }
  }
  return message;
}

// ── Sending ────────────────────────────────────────────────────────────────

let localCounter = 0;

/**
 * Sends a message. It shows at once, marked as sending, and becomes the
 * real one when the site answers (or when the live socket brings it,
 * whichever is first); a failed one stays, marked, to send again.
 */
export function useSend(channelId: string, thread: string | null = null) {
  const { client, workspace, me } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";

  return useCallback(
    (body: string, retryOf?: Shown) => {
      const localId = retryOf?.id ?? `local-${Date.now()}-${localCounter++}`;
      const local: Shown = {
        id: localId,
        channel_id: channelId,
        author: {
          kind: "user",
          id: me.id,
          name: me.username,
          display_username: me.display_username ?? null,
          display_name: me.display_username ?? me.username,
          avatar: me.avatar ?? null,
          role: null,
        } as MemberProfile,
        kind: "text",
        body,
        card: null,
        thread_root: thread,
        reply_count: 0,
        last_reply_at: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
        reactions: [],
        local: "sending",
      };
      upsertMessage(queries, slug, local, localId);
      sendIntent<ChatMessage>(client, slug, "post", { channel_id: channelId, body, thread_root: thread })
        .then((message) => {
          upsertMessage(queries, slug, message, localId);
          void queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) });
        })
        .catch(() => upsertMessage(queries, slug, { ...local, local: "failed" }, localId));
    },
    [client, queries, slug, channelId, thread, me],
  );
}

/** Everything else a person does to messages and conversations. */
export function useChatActions(channelId: string) {
  const { client, workspace } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";

  const react = useMutation({
    mutationFn: ({ message, emoji, add }: { message: ChatMessage; emoji: string; add: boolean }) =>
      sendIntent(client, slug, add ? "react" : "unreact", { channel_id: channelId, message_id: message.id, emoji }),
    onMutate: ({ message, emoji, add }) => applyReaction(queries, slug, channelId, message.id, emoji, null, add, true),
    onError: (_error, { message, emoji, add }) => applyReaction(queries, slug, channelId, message.id, emoji, null, !add, true),
  });

  const edit = useMutation({
    mutationFn: ({ message, body }: { message: ChatMessage; body: string }) => sendIntent<ChatMessage>(client, slug, "edit", { channel_id: channelId, id: message.id, body }),
    onSuccess: (message) => upsertMessage(queries, slug, message),
  });

  const remove = useMutation({
    mutationFn: (message: ChatMessage) => sendIntent(client, slug, "remove", { channel_id: channelId, id: message.id }),
    onMutate: (message) => removeMessage(queries, slug, channelId, message.id),
    onError: () => queries.invalidateQueries({ queryKey: ["chat", slug, "messages", channelId] }),
  });

  const preferences = useMutation({
    mutationFn: (change: { starred?: boolean; muted?: boolean }) => sendIntent(client, slug, "preferences", { channel_id: channelId, ...change }),
    onSettled: () => queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) }),
  });

  const leave = useMutation({
    mutationFn: () => sendIntent(client, slug, "leave", { channel_id: channelId }),
    onSettled: () => queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) }),
  });

  return { react, edit, remove, preferences, leave };
}

/** Marks a conversation read up to a message; the sidebar's counts follow. */
export function markRead(client: Client, queries: QueryClient, workspace: string, channelId: string, messageId: string) {
  queries.setQueryData<ChatSidebar>(chatKeys.sidebar(workspace), (data) =>
    data ? { ...data, entries: data.entries.map((entry) => (entry.channel.id === channelId ? { ...entry, unread: 0, mentions: 0 } : entry)) } : data,
  );
  return sendIntent(client, workspace, "read", { channel_id: channelId, id: messageId }).catch(() => undefined);
}

export function useStartConversation() {
  const { client, workspace } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";
  return {
    /** Opens (or finds) a direct message with these people: `user:<username>`. */
    dm: useMutation({
      mutationFn: (members: string[]) => sendIntent<{ channel: Channel }>(client, slug, "dm", { members }),
      onSuccess: () => queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) }),
    }),
    join: useMutation({
      mutationFn: (channelId: string) => sendIntent(client, slug, "join", { channel_id: channelId }),
      onSuccess: () => {
        void queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) });
        void queries.invalidateQueries({ queryKey: chatKeys.browse(slug) });
      },
    }),
    create: useMutation({
      mutationFn: (channel: { name: string; topic?: string; private?: boolean }) => sendIntent<{ channel: Channel }>(client, slug, "create_channel", channel),
      onSuccess: () => queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) }),
    }),
  };
}

// ── Live ───────────────────────────────────────────────────────────────────

export type LiveStatus = "connecting" | "live" | "offline";

/** Who is typing, until when. */
type Typing = { member: MemberProfile; until: number };

/**
 * Keeps a conversation live while its screen is open: applies what its
 * socket says to the cache, says who is typing, and lets the composer say
 * the viewer is (at most every 3 s, as the room takes it).
 */
export function useChannelLive(channelId: string) {
  const { client, workspace, me } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [typing, setTyping] = useState<Typing[]>([]);
  const send = useRef<((frame: unknown) => void) | null>(null);
  const typedAt = useRef(0);

  useEffect(() => {
    if (!slug || !channelId) return;
    const socket = openSocket(client, `/${encodeURIComponent(slug)}/-/chat/live`, { channel: channelId }, {
      onStatus: setStatus,
      onReconnect: () => void queries.invalidateQueries({ queryKey: ["chat", slug, "messages", channelId] }),
      onMessage: (data) => {
        const live = data as ChatLiveEvent;
        switch (live.type) {
          case "message.created":
          case "message.updated":
            upsertMessage(queries, slug, keepMine(queries, slug, live.message));
            setTyping((now) => now.filter((one) => one.member.id !== live.message.author.id));
            break;
          case "message.deleted":
            removeMessage(queries, slug, live.channel_id, live.id);
            break;
          case "message.streaming":
            // @g1t's answer as it is written: the text so far, in place.
            updatePages(queries, chatKeys.messages(slug, live.channel_id, null), (messages) =>
              messages.map((one) => (one.id === live.id ? { ...one, body: live.body, answer: live.answer } : one)),
            );
            break;
          case "reaction.added":
          case "reaction.removed":
            if (live.member.id !== me.id) applyReaction(queries, slug, live.channel_id, live.message_id, live.emoji, live.member, live.type === "reaction.added", false);
            break;
          case "typing":
            if (live.member.id === me.id) break;
            setTyping((now) => [...now.filter((one) => one.member.id !== live.member.id), { member: live.member, until: Date.parse(live.until) }]);
            break;
          case "channel.updated":
            void queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) });
            break;
        }
      },
    });
    send.current = socket.send;
    return () => {
      send.current = null;
      socket.close();
    };
  }, [client, queries, slug, channelId, me.id]);

  // Typing lapses on its own.
  useEffect(() => {
    if (typing.length === 0) return;
    const next = Math.min(...typing.map((one) => one.until)) - Date.now();
    const timer = setTimeout(() => setTyping((now) => now.filter((one) => one.until > Date.now())), Math.max(250, next));
    return () => clearTimeout(timer);
  }, [typing]);

  const sayTyping = useCallback(() => {
    const now = Date.now();
    if (now - typedAt.current < 3000) return;
    typedAt.current = now;
    send.current?.({ type: "typing", channel_id: channelId });
  }, [channelId]);

  return { status, typing: typing.map((one) => one.member), sayTyping };
}
