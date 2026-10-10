import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Copy,
  Ellipsis,
  FileText,
  Link2,
  Pencil,
  Trash2,
  BellOff,
  Hash,
  Lock,
  MessageSquareText,
  PanelRight,
  Star,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";

import {
  type Channel,
  type ChannelChange,
  type ChannelMember,
  type ChatLiveEvent,
  type ChatMessage,
  type MemberProfile,
  type Result,
  hasCodeAccess,
  shownUsername,
} from "@g1t/contracts";

import { useChatData, useChatSend, useChatSidebar } from "./actions";
import { CardBox, CardToasts, showToast } from "./card";
import { Composer } from "./composer";
import { type LiveState, useChatLive } from "./live";
import { AgentPill, MemberAvatar } from "./marks";
import { PersonStatusEmoji, PersonStatusLine, PresenceSummary, WithPresence } from "../presence";
import { CardContext, MemberCard, type PersonCard, personCard } from "./profile-card";
import { Avatar } from "../ui";
import { localTime } from "../../lib/time-zone";
import { BottomSheet, SheetRow, useBack, useSwipeBack } from "../mobile";
import { MessageText, type TextContext } from "./text";
import { WriteUpDialog } from "./write-up";
import { FolioUnfurls } from "../folios/unfurl";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { threadLink, writeUpAgents } from "../../lib/write-up";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Hint } from "../ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { type Mentionable, type ShownMessage, channelPath, mentionNames, mergeMessages, shownHandle, shownName, timeline } from "../../lib/chat";
import { codeAccessPath } from "../../lib/workspace-nav";
import { conversationCache } from "./conversation-cache";
// Reactions and the workspace's own emoji (components/emoji).
import { EmojiProvider, useCustomEmoji } from "../emoji/context";
import { AddReaction, QuickReactions, ReactionBar } from "../emoji/reaction-bar";
import { useAddresses } from "../../lib/addresses";
import { applyReactionEvent, keepMine, toggleReaction } from "../../lib/emoji";
import type { ChannelData } from "../../routes/workspace/chat/channel";

type Loaded = Extract<ChannelData, { unavailable: false }>;

/** True once the page has hydrated: times and days are the reader's own from then on. */
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

function clock(at: string, zone: string | undefined): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
}

/** Whether the viewer uses Code in this workspace. */
export function useCodeAccess(slug: string): boolean {
  const root = useRouteLoaderData("root") as { user?: { workspaces?: { slug: string; code_access?: boolean }[] } | null } | undefined;
  return hasCodeAccess(root?.user?.workspaces?.find((m) => m.slug === slug) ?? null);
}

/** The project a channel of the same name is about, for a bare `#123`. */
function useProjectNamed(name: string | null): string | null {
  const root = useRouteLoaderData("root") as { shell?: { repos?: { name: string }[] } } | undefined;
  if (!name) return null;
  return root?.shell?.repos?.some((repo) => repo.name === name) ? name : null;
}

function newClientId(): string {
  return `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A conversation: its header, its messages, the box to write in, and its thread and details beside it. */
export function ChannelView({ data }: { data: Loaded }) {
  const chatData = useChatData();
  const slug = chatData?.slug ?? "";
  const me = chatData?.me ?? null;
  const send = useChatSend(slug);
  const { sidebar, refresh } = useChatSidebar();
  const hydrated = useHydrated();
  const zone = hydrated ? undefined : "UTC";
  const code = useCodeAccess(slug);
  const project = useProjectNamed(data.channel.kind === "channel" ? data.channel.name : null);
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");

  const [messages, setMessages] = useState<ShownMessage[]>(() => mergeMessages([], data.messages));
  const [older, setOlder] = useState<string | null>(data.older);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [thread, setThread] = useState<ShownMessage[] | null>(null);
  // The message the open thread is under, as its page says, for when it is
  // further back than the conversation has loaded (a long-running session's card).
  const [threadRoot, setThreadRoot] = useState<ShownMessage | null>(null);
  const [typing, setTyping] = useState<Map<string, { member: MemberProfile; until: number }>>(new Map());
  const [joined, setJoined] = useState(data.joined);
  const [members, setMembers] = useState<ChannelMember[]>(data.members);
  // The channel as it is now: renamed, its topic changed, archived, live.
  const [channel, setChannel] = useState<Channel>(data.channel);
  const [canManage, setCanManage] = useState(data.can_manage === true);
  const view = useMemo<Loaded>(() => ({ ...data, channel, title: channel.kind === "channel" ? `#${channel.name}` : data.title }), [data, channel]);
  // The server's answer behind a cached draw: merged in by id.
  useEffect(() => {
    const onFresh = (event: Event) => {
      const { key, value } = (event as CustomEvent<{ key: string; value: ChannelData }>).detail;
      if (key !== window.location.pathname || value.unavailable || value.channel.id !== data.channel.id) return;
      setMessages((now) => mergeMessages(now, value.messages));
      setMembers(value.members);
      setJoined(value.joined);
      setChannel(value.channel);
      setCanManage(value.can_manage === true);
    };
    window.addEventListener("g1t:chat-fresh", onFresh);
    return () => window.removeEventListener("g1t:chat-fresh", onFresh);
  }, [data.channel.id]);
  // The cache follows what is on screen, so coming back shows the latest.
  useEffect(() => {
    const path = window.location.pathname;
    const timer = setTimeout(
      () => conversationCache.set(path, { ...view, messages: messages.filter((m) => !m.pending).slice(-80), members, joined, can_manage: canManage }),
      400,
    );
    return () => clearTimeout(timer);
  }, [view, messages, members, joined, canManage]);
  // Renamed while open, here or by someone else: the address follows the name.
  const navigate = useNavigate();
  const nameShown = useRef(data.channel.name);
  useEffect(() => {
    if (channel.kind !== "channel" || channel.name === nameShown.current || !slug) return;
    nameShown.current = channel.name;
    navigate(`${channelPath(slug, channel)}${window.location.search}`, { replace: true, preventScrollReset: true });
  }, [channel, slug, navigate]);
  const [info, setInfo] = useState(false);
  // A phone: back to the list, by the chevron or a swipe from the edge;
  // and a long-pressed message's actions.
  const back = useBack(`/${chatData?.slug ?? ""}/-/chat`);
  const swipe = useSwipeBack(back);
  const [actions, setActions] = useState<ShownMessage | null>(null);
  // Someone's profile, opened from their card, beside the conversation.
  const [profile, setProfile] = useState<string | null>(null);
  // A message being edited: in its place on a computer (`inline`), in a sheet on a phone.
  const [editing, setEditing] = useState<{ id: string; body: string; inline?: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const entry = sidebar?.entries.find((e) => e.channel.id === data.channel.id);
  const starred = entry?.starred ?? members.find((m) => m.member.kind === "user" && m.member.id === me?.id)?.starred ?? false;
  const muted = entry?.muted ?? false;
  const others = members.filter((m) => !(m.member.kind === "user" && m.member.id === me?.id)).map((m) => m.member);
  const isDm = data.channel.kind === "dm";

  // The details panel: open by default on a wide screen, as last left.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chat-info");
      setInfo(saved ? saved === "1" : window.matchMedia("(min-width: 1280px)").matches && !isDm);
    } catch {
      setInfo(false);
    }
  }, [isDm]);
  const toggleInfo = () =>
    setInfo((now) => {
      try {
        localStorage.setItem("chat-info", now ? "0" : "1");
      } catch {
        // Not kept: fine.
      }
      return !now;
    });

  const people = useMemo<Mentionable[]>(
    () => [
      // A personal agent is never mentioned: it answers only in its own DM.
      ...(chatData?.agents ?? [])
        .filter((agent) => agent.scope !== "personal")
        .map((agent) => ({ kind: "agent" as const, name: agent.handle, display_name: agent.display_name, avatar: agent.avatar, role: agent.role })),
      ...(chatData?.people ?? []).filter((p) => p.name !== me?.username),
    ],
    [chatData, me?.username],
  );
  const context = useMemo<TextContext>(
    () => ({
      slug,
      me: me?.username ?? null,
      agents: new Set((chatData?.agents ?? []).map((a) => a.handle.toLowerCase())),
      // `@ana` reads as the name people know: everyone in the workspace, the viewer too.
      names: mentionNames([...people, ...(me ? [{ kind: "user" as const, name: me.username, display_username: me.display_username, display_name: me.display_name, avatar: me.avatar }] : [])]),
      channels: new Set((sidebar?.entries ?? []).filter((e) => e.channel.kind === "channel").map((e) => e.channel.name ?? "")),
      project,
      codeLink: code ? undefined : (href: string) => (/^\/[^/]+\/(?!-\/)[^/]+/.test(href) ? codeAccessPath(slug, href) : href),
    }),
    [slug, me, people, chatData?.agents, sidebar?.entries, project, code],
  );

  // Keeps the newest message in view while the reader is at the bottom.
  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useEffect(() => toBottom(), [toBottom]);
  useEffect(() => {
    if (stick.current) toBottom(true);
  }, [messages.length, typing.size, toBottom]);

  // Read up to the newest message whenever it is in view.
  const lastRead = useRef<string | null>(null);
  const markRead = useCallback(() => {
    if (!joined || document.visibilityState !== "visible") return;
    const newest = [...messages].reverse().find((m) => !m.pending);
    if (!newest || newest.id === lastRead.current) return;
    lastRead.current = newest.id;
    void send({ intent: "read", channel_id: data.channel.id, id: newest.id });
    window.dispatchEvent(new CustomEvent("g1t:chat-read", { detail: data.channel.id }));
  }, [messages, joined, send, data.channel.id]);
  useEffect(() => {
    const timer = setTimeout(markRead, 400);
    document.addEventListener("visibilitychange", markRead);
    window.addEventListener("focus", markRead);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", markRead);
      window.removeEventListener("focus", markRead);
    };
  }, [markRead]);

  // The thread open beside the conversation, from `?thread=`.
  const loadThread = useCallback(async () => {
    if (!threadId) return setThread(null);
    try {
      const response = await fetch(`/${slug}/-/chat/api?channel=${encodeURIComponent(data.channel.id)}&thread=${encodeURIComponent(threadId)}`);
      const result = (await response.json()) as Result<{ messages: ChatMessage[]; root?: ChatMessage | null }>;
      // The page reaches back to the message the thread is under: shown above it, not among the replies.
      setThread(result.ok ? mergeMessages([], result.value.messages.filter((m) => m.id !== threadId && !m.deleted_at)) : []);
      const root = result.ok ? (result.value.root ?? result.value.messages.find((m) => m.id === threadId) ?? null) : null;
      setThreadRoot(root);
    } catch {
      setThread([]);
    }
  }, [threadId, slug, data.channel.id]);
  useEffect(() => {
    setThread(null);
    setThreadRoot(null);
    void loadThread();
  }, [loadThread]);

  // Reply counts: counted here only until the service's own count for that
  // message arrives (a `message.updated` of it), which can come before or
  // after the reply itself; never twice for one reply.
  const serverCounted = useRef(new Set<string>());
  const countedReplies = useRef(new Set<string>());
  const countReply = useCallback((root: string, reply: string, at: string) => {
    if (serverCounted.current.has(root) || countedReplies.current.has(reply)) return;
    countedReplies.current.add(reply);
    setMessages((now) => now.map((m) => (m.id === root ? { ...m, reply_count: m.reply_count + 1, last_reply_at: at } : m)));
  }, []);
  const latest = useRef(messages);
  latest.current = messages;

  // Everything that happens while the page is open.
  const onEvent = useCallback(
    (event: ChatLiveEvent) => {
      if (event.type === "message.created" || event.type === "message.updated") {
        const message = event.message;
        if (message.channel_id !== data.channel.id) return;
        if (message.thread_root) {
          if (message.thread_root === threadId) setThread((now) => (now ? mergeMessages(now, [keepMine(now, message)]) : now));
          if (event.type === "message.created") countReply(message.thread_root, message.id, message.created_at);
        } else {
          if (event.type === "message.updated") serverCounted.current.add(message.id);
          setMessages((now) => mergeMessages(now, [keepMine(now, message)]));
          // The open thread's root, a session's card say, changes in place at its top too.
          if (message.id === threadId) setThreadRoot((now) => (now ? keepMine([now], message) : now));
        }
        // Whoever just spoke is no longer typing.
        setTyping((now) => {
          const key = `${message.author.kind}:${message.author.id}`;
          if (!now.has(key)) return now;
          const next = new Map(now);
          next.delete(key);
          return next;
        });
      } else if (event.type === "message.deleted") {
        if (event.channel_id !== data.channel.id) return;
        const gone = (m: ShownMessage) => (m.id === event.id ? { ...m, deleted_at: new Date().toISOString() } : m);
        setMessages((now) => now.map(gone));
        setThread((now) => now?.map(gone) ?? now);
        setThreadRoot((now) => (now ? gone(now) : now));
      } else if (event.type === "reaction.added" || event.type === "reaction.removed") {
        if (event.channel_id !== data.channel.id) return;
        setMessages((now) => applyReactionEvent(now, event, me?.id ?? null));
        setThread((now) => (now ? applyReactionEvent(now, event, me?.id ?? null) : now));
      } else if (event.type === "typing") {
        if (event.channel_id !== data.channel.id) return;
        if (event.member.kind === "user" && event.member.id === me?.id) return;
        setTyping((now) => new Map(now).set(`${event.member.kind}:${event.member.id}`, { member: event.member, until: new Date(event.until).getTime() }));
      } else if (event.type === "channel.updated") {
        // Renamed, a new topic, archived or back: everyone looking sees it at once.
        if (event.channel.id !== data.channel.id) return;
        setChannel(event.channel);
        refresh();
      }
    },
    [data.channel.id, threadId, me?.id, countReply, refresh],
  );
  // Back after a drop: what was missed.
  const onReconnect = useCallback(async () => {
    const base = `/${slug}/-/chat/api?channel=${encodeURIComponent(data.channel.id)}`;
    try {
      // Everything after the newest message held, page by page, oldest first;
      // what was deleted meanwhile comes back empty and is dropped.
      let after = [...latest.current].reverse().find((m) => !m.pending)?.id ?? null;
      for (let pages = 0; after && pages < 20; pages++) {
        const response = await fetch(`${base}&after=${encodeURIComponent(after)}`);
        const result = (await response.json()) as Result<{ messages: ChatMessage[]; newer?: string | null }>;
        if (!result.ok) break;
        const gone = new Set(result.value.messages.filter((m) => m.deleted_at).map((m) => m.id));
        const kept = result.value.messages.filter((m) => !m.deleted_at && !m.thread_root);
        setMessages((now) => mergeMessages(now.filter((m) => !gone.has(m.id)), kept));
        after = result.value.newer ?? null;
      }
      // Edits and deletions to what was already on screen: the latest page again.
      const response = await fetch(base);
      const result = (await response.json()) as Result<{ messages: ChatMessage[] }>;
      if (result.ok) {
        const gone = new Set(result.value.messages.filter((m) => m.deleted_at).map((m) => m.id));
        setMessages((now) => mergeMessages(now.filter((m) => !gone.has(m.id)), result.value.messages.filter((m) => !m.deleted_at)));
      }
    } catch {
      // The next event, or the next return, catches up.
    }
    void loadThread();
    refresh();
  }, [slug, data.channel.id, loadThread, refresh]);
  const live = useChatLive(slug, data.channel.id, onEvent, onReconnect);

  // Typing shows until its time runs out.
  useEffect(() => {
    if (typing.size === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((current) => {
        const next = new Map([...current].filter(([, value]) => value.until > now));
        return next.size === current.size ? current : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [typing.size]);

  // Says "is typing" to the others, at most every few seconds.
  const lastTyping = useRef(0);
  const onTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTyping.current < 3000) return;
    lastTyping.current = now;
    live.send({ type: "typing", channel_id: data.channel.id });
  }, [live, data.channel.id]);

  const post = useCallback(
    async (body: string, root: string | null) => {
      if (!me) return;
      const clientId = newClientId();
      const author: MemberProfile = { kind: "user", id: me.id, name: me.username, display_username: me.display_username, display_name: me.display_name, avatar: me.avatar, role: null };
      const pending: ShownMessage = {
        id: clientId,
        client_id: clientId,
        pending: true,
        channel_id: data.channel.id,
        author,
        kind: "text",
        body,
        card: null,
        thread_root: root,
        reply_count: 0,
        last_reply_at: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
      };
      const put = (list: ShownMessage[]) => mergeMessages(list, [pending]);
      if (root) setThread((now) => put(now ?? []));
      else {
        stick.current = true;
        setMessages(put);
      }
      const saved = await send<ChatMessage>({ intent: "post", channel_id: data.channel.id, body, thread_root: root });
      const settle = (list: ShownMessage[]) =>
        saved.ok
          ? mergeMessages(list, [{ ...saved.value, client_id: clientId }])
          : list.map((m) => (m.client_id === clientId ? { ...m, failed: true, pending: true } : m));
      if (root) {
        setThread((now) => (now ? settle(now) : now));
        if (saved.ok) countReply(root, saved.value.id, saved.value.created_at);
      } else setMessages(settle);
    },
    [me, send, data.channel.id, countReply],
  );
  // ── Reactions (components/emoji): shown at once, then as the service counts them.
  const customs = useCustomEmoji(slug);
  const { usercontent } = useAddresses();
  const meProfile = useMemo<MemberProfile | null>(
    () => (me ? { kind: "user", id: me.id, name: me.username, display_username: me.display_username, display_name: me.display_name, avatar: me.avatar, role: null } : null),
    [me],
  );
  const react = useCallback(
    async (messageId: string, emoji: string, on: boolean) => {
      if (!meProfile) return;
      const change = (to: boolean) => (list: ShownMessage[]) =>
        list.map((m) => (m.id === messageId ? { ...m, reactions: toggleReaction(m.reactions ?? [], emoji, to, meProfile) } : m));
      setMessages(change(on));
      setThread((now) => (now ? change(on)(now) : now));
      try {
        const response = await fetch(`/${slug}/-/chat/api`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: on ? "react" : "unreact", channel_id: data.channel.id, message_id: messageId, emoji }),
        });
        const result = (await response.json()) as Result<ChatMessage["reactions"]>;
        if (!result.ok) throw new Error(result.error.message);
        const settle = (list: ShownMessage[]) => list.map((m) => (m.id === messageId ? { ...m, reactions: result.value } : m));
        setMessages(settle);
        setThread((now) => (now ? settle(now) : now));
      } catch {
        // Not saved: back as it was.
        setMessages(change(!on));
        setThread((now) => (now ? change(!on)(now) : now));
      }
    },
    [meProfile, slug, data.channel.id],
  );
  const emojiContext = useMemo(
    () => ({ customs, usercontent, me: meProfile, react: (id: string, emoji: string, on: boolean) => void react(id, emoji, on), manageHref: `/${slug}/-/emoji` }),
    [customs, usercontent, meProfile, react, slug],
  );

  const retry = (message: ShownMessage) => {
    const drop = (list: ShownMessage[]) => list.filter((m) => m.client_id !== message.client_id);
    if (message.thread_root) setThread((now) => (now ? drop(now) : now));
    else setMessages(drop);
    void post(message.body, message.thread_root);
  };

  const loadOlder = async () => {
    if (!older || loadingOlder) return;
    setLoadingOlder(true);
    const element = scroller.current;
    const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;
    try {
      const response = await fetch(`/${slug}/-/chat/api?channel=${encodeURIComponent(data.channel.id)}&before=${encodeURIComponent(older)}`);
      const result = (await response.json()) as Result<{ messages: ChatMessage[]; older: string | null }>;
      if (result.ok) {
        stick.current = false;
        setMessages((now) => mergeMessages(now, result.value.messages));
        setOlder(result.value.older);
        requestAnimationFrame(() => {
          if (element) element.scrollTop = element.scrollHeight - fromBottom;
        });
      }
    } finally {
      setLoadingOlder(false);
    }
  };

  const openThread = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("thread", id);
    else next.delete("thread");
    setParams(next, { preventScrollReset: true, replace: !!threadId && !!id });
  };

  // A thread's link, to copy and to cite; and "Write this up as an artifact",
  // which asks an agent, in the thread and as the person, for a doc about it.
  const [writeUp, setWriteUp] = useState<string | null>(null);
  const linkToThread = (root: string) => threadLink(window.location.origin, channelPath(slug, channel), root);
  const copyThreadLink = (root: string) => {
    const done = navigator.clipboard?.writeText(linkToThread(root));
    if (!done) return showToast(false, "Couldn't copy the link here.");
    done.then(
      () => showToast(true, "Link to the thread copied."),
      () => showToast(false, "Couldn't copy the link here."),
    );
  };
  const writers = useMemo(() => writeUpAgents(members.map((m) => m.member)), [members]);
  const askForWriteUp = async (body: string): Promise<string | null> => {
    const root = writeUp;
    if (!root) return null;
    // The thread open already: posted as any reply is, shown at once.
    if (root === threadId) {
      void post(body, root);
      return null;
    }
    const saved = await send<ChatMessage>({ intent: "post", channel_id: data.channel.id, body, thread_root: root });
    if (!saved.ok) return saved.error.message;
    openThread(root);
    return null;
  };

  const updateChannel = useCallback(
    async (change: ChannelChange): Promise<Result<unknown>> => {
      const done = await send<{ channel: Channel }>({ intent: "update_channel", channel_id: data.channel.id, ...change });
      if (done.ok) setChannel(done.value.channel);
      return done;
    },
    [send, data.channel.id],
  );

  const toggleStar = async () => {
    await send({ intent: "preferences", channel_id: data.channel.id, starred: !starred });
    refresh();
  };

  const join = async () => {
    const done = await send({ intent: "join", channel_id: data.channel.id });
    if (done.ok) {
      setJoined(true);
      if (me) {
        setMembers((now) => [
          ...now,
          {
            channel_id: data.channel.id,
            member: { kind: "user", id: me.id, name: me.username, display_username: me.display_username, display_name: me.display_name, avatar: me.avatar, role: null },
            role: "member",
            starred: false,
            muted: false,
            last_read_id: null,
            joined_at: new Date().toISOString(),
          },
        ]);
      }
    }
  };

  const rows = useMemo(() => timeline(messages, new Date(), zone), [messages, zone]);
  const mine = (message: ShownMessage) => message.author.kind === "user" && message.author.id === me?.id && !message.pending && !message.deleted_at;
  // Editing uses the composer, started from the message's Markdown.
  const editor = (target: { id: string; body: string }) => (
    <Composer
      initial={target.body}
      placeholder="Edit message"
      people={people}
      autoFocus
      compact
      onCancel={() => setEditing(null)}
      onSend={async (body) => {
        setEditing(null);
        if (body === target.body) return;
        // Shown edited at once; put back if the service refuses.
        const before = messages.find((m) => m.id === target.id);
        setMessages((now) => now.map((m) => (m.id === target.id ? { ...m, body, edited_at: new Date().toISOString() } : m)));
        const saved = await send<ChatMessage>({ intent: "edit", channel_id: data.channel.id, id: target.id, body });
        if (saved.ok) setMessages((now) => mergeMessages(now, [saved.value]));
        else if (before) setMessages((now) => now.map((m) => (m.id === before.id ? before : m)));
      }}
    />
  );
  const typers = [...typing.values()].map((t) => t.member);
  const name = channel.name ?? "";
  const archived = channel.kind === "channel" && !!channel.archived_at;
  const placeholder = isDm
    ? `Message ${others.map(shownName).join(", ") || "yourself"}`
    : `Message #${name}. @ a teammate or an agent`;
  const rootMessage = threadId ? (messages.find((m) => m.id === threadId) ?? (threadRoot?.id === threadId ? threadRoot : null)) : null;
  const cardContext = useMemo(
    () => ({
      slug,
      agents: chatData?.agents ?? [],
      onViewProfile: (username: string) => {
        if (threadId) openThread(null);
        setProfile(username);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, chatData?.agents, threadId],
  );

  return (
    // On a phone the conversation is the whole screen, as tall as what the
    // keyboard leaves (components/mobile.tsx), so the composer sits on it.
    <EmojiProvider value={emojiContext}>
    <CardContext.Provider value={cardContext}>
    <div
      {...swipe}
      className="flex h-(--page-h) min-h-0 max-md:fixed max-md:inset-x-0 max-md:top-(--vv-top,0px) max-md:z-30 max-md:h-(--vv-height,100dvh) max-md:bg-bg"
    >
      {/* What pressing a card's action did (components/chat/card.tsx). */}
      <CardToasts />
      <section aria-label={data.title} className="flex min-w-0 grow flex-col">
        <ChannelHeader
          onBack={back}
          data={view}
          others={others}
          starred={starred}
          muted={muted}
          memberCount={members.length}
          live={live.state}
          info={info}
          onStar={() => void toggleStar()}
          onInfo={toggleInfo}
        />
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          }}
          className="min-h-0 grow overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
          <div className="mx-auto flex min-h-full max-w-[56rem] flex-col justify-end px-2 pt-6 pb-3 sm:px-4">
            {older ? (
              <div className="flex justify-center pb-4">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  className="rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            ) : (
              <ConversationStart data={view} others={others} />
            )}
            {rows.map((row) =>
              row.kind === "day" ? (
                <DayRule key={row.key} label={row.label} />
              ) : (
                <MessageRow
                  key={row.key}
                  message={row.message}
                  head={row.head}
                  zone={zone}
                  context={context}
                  code={code}
                  slug={slug}
                  onThread={() => openThread(row.message.id)}
                  onRetry={() => retry(row.message)}
                  onLongPress={() => setActions(row.message)}
                  onCopyLink={() => copyThreadLink(row.message.id)}
                  onEdit={mine(row.message) ? () => setEditing({ id: row.message.id, body: row.message.body, inline: true }) : undefined}
                  editor={editing?.inline && editing.id === row.message.id ? editor(editing) : undefined}
                  onWriteUp={joined && !archived ? () => setWriteUp(row.message.id) : undefined}
                  threadOpen={row.message.id === threadId}
                />
              ),
            )}
          </div>
        </div>
        <div className="shrink-0 px-2 pb-3 sm:px-4 sm:pb-4 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] in-data-[keyboard=open]:pb-2">
          <div className="mx-auto max-w-[56rem]">
            <TypingLine members={typers} />
            {archived ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Archive size={15} className="shrink-0 text-faint" />
                  <span>
                    <span className="font-medium text-fg">#{name}</span> is archived. Its history stays here to read; nobody can post in it.
                  </span>
                </p>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => void updateChannel({ archived: false })}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-raised"
                  >
                    <ArchiveRestore size={15} />
                    Unarchive
                  </button>
                )}
              </div>
            ) : joined ? (
              <Composer draftKey={data.channel.id} placeholder={placeholder} people={people} onSend={(body) => void post(body, null)} onTyping={onTyping} autoFocus />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                <p className="text-sm text-muted">
                  You're reading <span className="font-medium text-fg">#{name}</span>. Join to post and get its notifications.
                </p>
                <button
                  type="button"
                  onClick={() => void join()}
                  className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-bg hover:bg-accent-hover"
                >
                  Join channel
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
      {threadId ? (
        <SidePanel
          title="Thread"
          subtitle={isDm ? undefined : `#${name}`}
          onClose={() => openThread(null)}
          menu={<ThreadMenu onCopyLink={() => copyThreadLink(threadId)} onWriteUp={joined && !archived ? () => setWriteUp(threadId) : undefined} />}
        >
          <ThreadPanel
            root={rootMessage}
            replies={thread}
            zone={zone}
            context={context}
            code={code}
            slug={slug}
            people={people}
            joined={joined && !archived}
            onSend={(body) => void post(body, threadId)}
            onRetry={retry}
            onTyping={onTyping}
            draftKey={`${data.channel.id}:${threadId}`}
          />
        </SidePanel>
      ) : profile ? (
        <SidePanel title="Profile" onClose={() => setProfile(null)}>
          <ProfilePanel slug={slug} username={profile} messages={messages} zone={zone} context={context} />
        </SidePanel>
      ) : (
        info && (
          <SidePanel title={isDm ? "Details" : "About this channel"} onClose={toggleInfo}>
            <InfoPanel
              data={view}
              members={members}
              slug={slug}
              people={people}
              onAdded={(m) => setMembers((now) => [...now, m])}
              joined={joined}
              canManage={canManage}
              onUpdate={updateChannel}
            />
          </SidePanel>
        )
      )}
      <MessageActions
        message={actions}
        mine={actions != null && actions.author.kind === "user" && actions.author.id === me?.id}
        onClose={() => setActions(null)}
        onThread={(id) => openThread(id)}
        onCopyLink={(message) => copyThreadLink(message.thread_root ?? message.id)}
        onWriteUp={joined && !archived ? (message) => setWriteUp(message.thread_root ?? message.id) : undefined}
        onEdit={(message) => setEditing({ id: message.id, body: message.body })}
        onDelete={async (message) => {
          // Gone at once; back if the service refuses.
          setMessages((now) => now.map((m) => (m.id === message.id ? { ...m, deleted_at: new Date().toISOString() } : m)));
          const done = await send({ intent: "remove", channel_id: data.channel.id, id: message.id });
          if (!done.ok) setMessages((now) => now.map((m) => (m.id === message.id ? { ...m, deleted_at: null } : m)));
        }}
      />
      <WriteUpDialog
        open={writeUp != null}
        onOpenChange={(open) => !open && setWriteUp(null)}
        slug={slug}
        agents={writers}
        link={writeUp && typeof window !== "undefined" ? linkToThread(writeUp) : ""}
        shared={channel.kind === "dm" || channel.private}
        onSend={askForWriteUp}
      />
      <BottomSheet open={editing != null && !editing.inline} onOpenChange={(open) => !open && setEditing(null)} title="Edit message">
        {editing && !editing.inline && (
          <div className="space-y-3 px-1 pt-1">
            <h2 className="px-2 text-base font-semibold">Edit message</h2>
            {editor(editing)}
          </div>
        )}
      </BottomSheet>
    </div>
    </CardContext.Provider>
    </EmojiProvider>
  );
}

/** The top of a conversation: what it is, and its controls. */
function ChannelHeader({
  onBack,
  data,
  others,
  starred,
  muted,
  memberCount,
  live,
  info,
  onStar,
  onInfo,
}: {
  /** A phone: back to the list of conversations. */
  onBack: () => void;
  data: Loaded;
  others: MemberProfile[];
  starred: boolean;
  muted: boolean;
  memberCount: number;
  live: LiveState;
  info: boolean;
  onStar: () => void;
  onInfo: () => void;
}) {
  const channel = data.channel;
  const agentDm = channel.kind === "dm" && others.length === 1 && others[0]!.kind === "agent" ? others[0]! : null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-5 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:gap-2 max-md:pt-[env(safe-area-inset-top)] max-md:pl-1.5">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to conversations"
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-raised md:hidden"
      >
        <ChevronLeft size={22} />
      </button>
      <div className="flex min-w-0 grow items-center gap-2.5">
        {channel.kind === "channel" ? (
          <>
            <h1 className="flex min-w-0 shrink-0 items-center gap-1 text-[0.9375rem] font-semibold">
              {channel.private ? (
                <Hint label="Private channel: only its members can find and read it">
                  <span className="flex">
                    <Lock size={15} className="text-faint" aria-label="Private channel" />
                  </span>
                </Hint>
              ) : (
                <Hash size={16} className="text-faint" aria-label="Public channel" />
              )}
              <span className="truncate">{channel.name}</span>
            </h1>
            <StarButton starred={starred} onClick={onStar} />
            {muted && (
              <Hint label="Muted: no unread count or notifications">
                <span className="text-faint">
                  <BellOff size={14} aria-label="Muted" />
                </span>
              </Hint>
            )}
            {channel.archived_at && (
              <Badge tone="neutral" className="shrink-0">
                <Archive size={11} />
                Archived
              </Badge>
            )}
            {channel.topic && (
              <>
                <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-line sm:block" />
                <p className="hidden min-w-0 truncate text-sm text-muted sm:block">{channel.topic}</p>
              </>
            )}
          </>
        ) : (
          <>
            <span className="flex shrink-0 -space-x-1.5">
              {others.slice(0, 3).map((member) => (
                <span key={`${member.kind}:${member.id}`} className="rounded-full ring-2 ring-bg">
                  <MemberAvatar member={member} size={26} presence={others.length === 1} />
                </span>
              ))}
            </span>
            <div className="min-w-0">
              <h1 className="flex min-w-0 items-center gap-1.5 text-[0.9375rem] leading-tight font-semibold">
                <span className="truncate">{others.map(shownName).join(", ") || "Just you"}</span>
                {agentDm && <AgentPill />}
              </h1>
              {agentDm && (titleOf(agentDm) ?? agentDm.role) && (
                <p className="truncate text-xs leading-tight text-muted">{titleOf(agentDm) ?? agentDm.role}</p>
              )}
              {/* One person: their status under their name, as their card has it. */}
              {!agentDm && others.length === 1 && others[0]!.kind === "user" && <PersonStatusLine person={{ id: others[0]!.id, username: others[0]!.name }} className="truncate text-xs leading-tight text-muted" />}
            </div>
            <StarButton starred={starred} onClick={onStar} />
          </>
        )}
      </div>
      {live !== "open" && (
        <span role="status" className="hidden items-center gap-1.5 text-xs text-faint sm:flex">
          <span className="size-1.5 animate-pulse rounded-full bg-warn" />
          {live === "reconnecting" ? "Reconnecting…" : "Connecting…"}
        </span>
      )}
      {channel.kind === "channel" && (
        <Hint label={info ? "Hide details" : "Members and details"}>
          <button
            type="button"
            onClick={onInfo}
            aria-pressed={info}
            aria-label="Members and details"
            className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs tabular-nums transition-colors ${
              info ? "border-line-strong bg-raised text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            <UsersStack count={memberCount} />
          </button>
        </Hint>
      )}
      {channel.kind === "dm" && (
        <Hint label={info ? "Hide details" : "Details"}>
          <button
            type="button"
            onClick={onInfo}
            aria-pressed={info}
            aria-label="Details"
            className={`flex size-8 items-center justify-center rounded-md transition-colors ${info ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
          >
            <PanelRight size={16} />
          </button>
        </Hint>
      )}
    </header>
  );
}

function UsersStack({ count }: { count: number }) {
  return (
    <>
      <Users size={14} />
      {count}
    </>
  );
}

function StarButton({ starred, onClick }: { starred: boolean; onClick: () => void }) {
  return (
    <Hint label={starred ? "Unstar" : "Star: keep it at the top of the sidebar"}>
      <button
        type="button"
        aria-label={starred ? "Unstar" : "Star"}
        aria-pressed={starred}
        onClick={onClick}
        className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-raised ${starred ? "text-warn" : "text-faint hover:text-fg"}`}
      >
        <Star size={15} fill={starred ? "currentColor" : "none"} />
      </button>
    </Hint>
  );
}

/** How a conversation begins, above its first message. */
function ConversationStart({ data, others }: { data: Loaded; others: MemberProfile[] }) {
  const channel = data.channel;
  if (channel.kind === "dm") {
    const agent = others.length === 1 && others[0]!.kind === "agent" ? others[0]! : null;
    return (
      <div className="px-2 pb-6 sm:px-3">
        <div className="flex -space-x-2">
          {others.slice(0, 4).map((m) => (
            <span key={m.id} className="rounded-full ring-4 ring-bg">
              <MemberAvatar member={m} size={56} />
            </span>
          ))}
        </div>
        <h2 className="mt-3 flex items-center gap-2 text-xl font-semibold tracking-tight">
          {others.map(shownName).join(", ") || "Just you"}
          {agent && <AgentPill />}
        </h2>
        <p className="mt-1 max-w-xl text-sm text-muted">
          {agent
            ? `${agent.role ? `${agent.role}. ` : ""}Ask a question or give it a job: it answers here, and opens a task when the work needs one.`
            : "This is the start of your conversation."}
        </p>
      </div>
    );
  }
  return (
    <div className="px-2 pb-6 sm:px-3">
      <span className="flex size-12 items-center justify-center rounded-xl bg-raised text-muted">
        {channel.private ? <Lock size={22} /> : <Hash size={24} />}
      </span>
      <h2 className="mt-3 text-xl font-semibold tracking-tight">Welcome to #{channel.name}</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">{channel.topic ?? "This is the very beginning of the channel."}</p>
    </div>
  );
}

function DayRule({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="relative my-3 flex items-center justify-center">
      <span aria-hidden="true" className="absolute inset-x-2 top-1/2 h-px bg-line" />
      <span className="relative rounded-full border border-line bg-bg px-3 py-0.5 text-[0.6875rem] font-medium text-muted" suppressHydrationWarning>
        {label}
      </span>
    </div>
  );
}

/** One message: with its author's name and avatar when it starts a group. */
/**
 * Someone's profile beside the conversation, opened from their card: who
 * they are, their teams and local time, and what they said here lately.
 * The conversation stays where it was.
 */
function ProfilePanel({
  slug,
  username,
  messages,
  zone,
  context,
}: {
  slug: string;
  username: string;
  messages: ShownMessage[];
  zone: string | undefined;
  context: TextContext;
}) {
  const [card, setCard] = useState<PersonCard | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setCard(undefined);
    void personCard(slug, username).then((value) => {
      if (live) setCard(value);
    });
    return () => {
      live = false;
    };
  }, [slug, username]);
  const theirs = messages
    .filter((m) => m.author.kind === "user" && m.author.name === username && !m.deleted_at && m.body)
    .slice(-5)
    .reverse();
  const time = card ? localTime(card.timezone, Date.now()) : null;
  return (
    <div className="min-h-0 grow overflow-y-auto p-5 [scrollbar-width:thin]">
      <WithPresence person={{ username }} size={88}>
        <Avatar name={username} image={card?.avatar ?? null} size={88} />
      </WithPresence>
      <h3 className="mt-3 text-xl font-semibold tracking-tight">{card?.name?.trim() || (card ? shownUsername(card) : username)}</h3>
      <p className="font-mono text-sm text-muted">
        @{card ? shownUsername(card) : username}
        {card?.pronouns ? <span className="font-sans"> · {card.pronouns}</span> : null}
      </p>
      <PresenceSummary person={{ username }} className="mt-3 text-sm text-muted" />
      {card?.bio && <p className="mt-3 text-sm leading-relaxed text-fg-soft">{card.bio}</p>}
      <dl className="mt-4 space-y-2 text-sm">
        {card && card.teams.length > 0 && (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-faint">Teams</dt>
            <dd className="text-fg-soft">{card.teams.map((team) => team.name).join(", ")}</dd>
          </div>
        )}
        {time && (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-faint">Local time</dt>
            <dd className="text-fg-soft" suppressHydrationWarning>
              {time}
            </dd>
          </div>
        )}
        {card?.location && (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-faint">Location</dt>
            <dd className="text-fg-soft">{card.location}</dd>
          </div>
        )}
        {card && card.workspaces.length > 0 && (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-faint">Workspaces</dt>
            <dd className="text-fg-soft">{card.workspaces.map((w) => w.name).join(", ")}</dd>
          </div>
        )}
      </dl>
      <h4 className="mt-6 mb-2 text-xs font-medium text-faint">Lately in this conversation</h4>
      {theirs.length === 0 ? (
        <p className="text-sm text-muted">Nothing here yet.</p>
      ) : (
        <ul className="space-y-3">
          {theirs.map((m) => (
            <li key={m.id} className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <p className="mb-1 text-[0.6875rem] text-faint" suppressHydrationWarning>
                {clock(m.created_at, zone)}
              </p>
              <div className="line-clamp-4 text-sm">
                <MessageText body={m.body} context={context} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/u/${username}`} className="mt-6 inline-block text-sm text-accent hover:underline">
        Open their full profile
      </Link>
    </div>
  );
}

/** An agent's title ("QA Engineer"), when the chat service sends it with the member. */
function titleOf(member: MemberProfile): string | null {
  return (member as MemberProfile & { title?: string | null }).title ?? null;
}

/** A long press (half a second, without moving) on a touch screen. */
function useLongPress(onLongPress?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  if (!onLongPress) return {};
  return {
    onTouchStart: () => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(8);
        onLongPress();
      }, 480);
    },
    onTouchMove: cancel,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      // A phone's own long-press menu (copy, look up) would cover ours.
      if (window.matchMedia("(pointer: coarse)").matches) event.preventDefault();
    },
  };
}

/** A long-pressed message's actions, in a sheet from the bottom: reply, copy, and for your own, edit and delete. */
function MessageActions({
  message,
  mine,
  onClose,
  onThread,
  onCopyLink,
  onWriteUp,
  onEdit,
  onDelete,
}: {
  message: ShownMessage | null;
  mine: boolean;
  onClose: () => void;
  onThread: (id: string) => void;
  onCopyLink: (message: ShownMessage) => void;
  /** Absent where the person cannot post (not joined, archived). */
  onWriteUp?: (message: ShownMessage) => void;
  onEdit: (message: ShownMessage) => void;
  onDelete: (message: ShownMessage) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [message]);
  const act = (run: () => void) => () => {
    run();
    onClose();
  };
  return (
    <BottomSheet open={message != null} onOpenChange={(open) => !open && onClose()} title="Message actions">
      {message && (
        <>
          <p className="mt-1 mb-2 line-clamp-2 px-3 text-sm text-muted">
            <span className="font-medium text-fg-soft">{shownName(message.author)}:</span> {message.body || message.card?.title}
          </p>
          {!message.pending && <QuickReactions messageId={message.id} onDone={onClose} />}
          {!message.thread_root && (
            <SheetRow icon={<MessageSquareText />} onClick={act(() => onThread(message.id))}>
              Reply in thread
            </SheetRow>
          )}
          <SheetRow icon={<Copy />} onClick={act(() => void navigator.clipboard?.writeText(message.body || message.card?.title || ""))}>
            Copy text
          </SheetRow>
          {!message.pending && (
            <SheetRow icon={<Link2 />} onClick={act(() => onCopyLink(message))}>
              Copy link to thread
            </SheetRow>
          )}
          {!message.pending && onWriteUp && (
            <SheetRow icon={<FileText />} onClick={act(() => onWriteUp(message))}>
              Write this up as an artifact
            </SheetRow>
          )}
          {mine && message.kind === "text" && (
            <SheetRow icon={<Pencil />} onClick={act(() => onEdit(message))}>
              Edit
            </SheetRow>
          )}
          {mine &&
            (confirm ? (
              <SheetRow icon={<Trash2 className="text-danger" />} onClick={act(() => onDelete(message))}>
                <span className="text-danger">Delete for everyone</span>
              </SheetRow>
            ) : (
              <SheetRow icon={<Trash2 />} onClick={() => setConfirm(true)}>
                Delete
              </SheetRow>
            ))}
        </>
      )}
    </BottomSheet>
  );
}

function MessageRow({
  message,
  head,
  zone,
  context,
  code,
  slug,
  onThread,
  onRetry,
  onLongPress,
  onCopyLink,
  onWriteUp,
  threadOpen,
  inThread,
  onEdit,
  editor,
}: {
  /** Your own message: "Edit message" in the "⋯", and the composer in its place while editing. */
  onEdit?: () => void;
  editor?: ReactNode;
  /** A phone: a long press opens the message's actions. */
  onLongPress?: () => void;
  /** The hover toolbar's "⋯": copy the link to its thread, write it up in Docs. */
  onCopyLink?: () => void;
  onWriteUp?: () => void;
  message: ShownMessage;
  head: boolean;
  zone: string | undefined;
  context: TextContext;
  code: boolean;
  slug: string;
  onThread?: () => void;
  onRetry: () => void;
  threadOpen?: boolean;
  inThread?: boolean;
}) {
  const author = message.author;
  const time = clock(message.created_at, zone);
  const press = useLongPress(onLongPress);
  return (
    <article
      {...press}
      aria-label={`${shownName(author)}, ${time}`}
      className={`group/message relative flex gap-3 rounded-lg px-2 transition-colors hover:bg-surface/70 sm:px-3 max-md:min-h-11 max-md:[-webkit-touch-callout:none] max-md:active:bg-surface/70 ${head ? "mt-3 pt-1 pb-1" : "py-0.5"} ${
        threadOpen ? "bg-accent/[0.06] hover:bg-accent/[0.08]" : ""
      }`}
    >
      <div className="w-9 shrink-0">
        {head ? (
          <MemberCard member={author} className="mt-0.5 block rounded-full" label={`${shownName(author)}'s card`}>
            <MemberAvatar member={author} size={36} />
          </MemberCard>
        ) : (
          <time
            dateTime={message.created_at}
            suppressHydrationWarning
            className="mt-1 block text-right text-[0.625rem] leading-5 text-faint tabular-nums opacity-0 group-hover/message:opacity-100"
          >
            {time.replace(/\s?[AP]M$/, "")}
          </time>
        )}
      </div>
      <div className="min-w-0 grow">
        {head && (
          <div className="flex items-baseline gap-2">
            <MemberCard member={author} className="truncate text-[0.9375rem] font-semibold text-fg hover:underline">
              {shownName(author)}
            </MemberCard>
            {author.kind === "user" && <PersonStatusEmoji person={{ id: author.id, username: author.name }} size={14} className="self-center" />}
            {author.kind === "agent" && <AgentPill className="self-center" />}
            <time dateTime={message.created_at} suppressHydrationWarning className="shrink-0 text-xs text-faint tabular-nums">
              {time}
            </time>
          </div>
        )}
        <div className={message.pending && !message.failed ? "opacity-60" : undefined}>
          {editor ? <div className="py-1">{editor}</div> : message.body && <MessageText body={message.body} context={context} />}
          {!editor && message.body && !message.pending && <FolioUnfurls slug={slug} body={message.body} />}
          {message.card && (
            <CardBox
              card={message.card}
              slug={slug}
              code={code}
              channelId={message.channel_id}
              messageId={message.id}
              inert={!!message.pending || !!message.deleted_at}
            />
          )}
          {message.edited_at && <span className="text-[0.6875rem] text-faint"> (edited)</span>}
        </div>
        {!message.pending && !message.deleted_at && <ReactionBar messageId={message.id} reactions={message.reactions} />}
        {message.failed && (
          <p className="mt-0.5 text-xs text-danger">
            Not sent.{" "}
            <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2 hover:text-fg">
              Try again
            </button>
          </p>
        )}
        {!inThread && message.reply_count > 0 && onThread && (
          <button
            type="button"
            onClick={onThread}
            className="mt-1 -ml-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-raised"
          >
            <MessageSquareText size={14} />
            {message.reply_count} {message.reply_count === 1 ? "reply" : "replies"}
            {message.last_reply_at && (
              <span className="font-normal text-faint" suppressHydrationWarning>
                Last reply {clock(message.last_reply_at, zone)}
              </span>
            )}
          </button>
        )}
      </div>
      {!inThread && onThread && !message.pending && (
        <div className="absolute -top-3 right-3 hidden rounded-lg border border-line bg-surface p-0.5 shadow-lg shadow-black/30 group-hover/message:flex group-focus-within/message:flex has-[[data-state=open]]:flex">
          <AddReaction messageId={message.id} />
          <Hint label="Reply in thread">
            <button
              type="button"
              aria-label="Reply in thread"
              onClick={onThread}
              className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
            >
              <MessageSquareText size={15} />
            </button>
          </Hint>
          {onCopyLink && <MoreActions onCopyLink={onCopyLink} onWriteUp={onWriteUp} onEdit={onEdit} />}
        </div>
      )}
    </article>
  );
}

/** A message's "⋯" in its hover toolbar. */
function MoreActions({ onCopyLink, onWriteUp, onEdit }: { onCopyLink: () => void; onWriteUp?: () => void; onEdit?: () => void }) {
  return (
    <DropdownMenu>
      <Hint label="More actions">
        <DropdownMenuTrigger
          aria-label="More actions"
          className="flex size-7 items-center justify-center rounded-md text-muted outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Ellipsis size={15} />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end">
        {onEdit && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            Edit message
          </DropdownMenuItem>
        )}
        <ThreadMenuItems onCopyLink={onCopyLink} onWriteUp={onWriteUp} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThreadMenuItems({ onCopyLink, onWriteUp }: { onCopyLink: () => void; onWriteUp?: () => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={onCopyLink}>
        <Link2 />
        Copy link to thread
      </DropdownMenuItem>
      {onWriteUp && (
        <DropdownMenuItem onSelect={onWriteUp}>
          <FileText />
          Write this up as an artifact
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The thread panel's "⋯", in its header. */
function ThreadMenu({ onCopyLink, onWriteUp }: { onCopyLink: () => void; onWriteUp?: () => void }) {
  return (
    <DropdownMenu>
      <Hint label="Thread actions">
        <DropdownMenuTrigger
          aria-label="Thread actions"
          className="flex size-10 items-center justify-center rounded-full text-muted outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 active:bg-raised lg:size-7 lg:rounded-md"
        >
          <Ellipsis size={16} />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end">
        <ThreadMenuItems onCopyLink={onCopyLink} onWriteUp={onWriteUp} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "reviewer is typing…", for whoever is. */
/** What an agent working on a reply says it is doing: one phrase per agent, so each sounds like itself. */
const AGENT_DOING = ["is reading the thread", "is thinking it through", "is looking into it", "is reading the diff", "is checking the details", "is drafting a reply"];

function agentDoing(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AGENT_DOING[Math.abs(hash) % AGENT_DOING.length]!;
}

function TypingLine({ members }: { members: MemberProfile[] }) {
  const names = members.map(shownName);
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : names.length > 2 ? "Several people" : "";
  return (
    <div aria-live="polite" className="flex h-6 items-center gap-1.5 px-1 text-xs text-muted">
      {who && (
        <>
          <span aria-hidden="true" className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 140}ms` }} />
            ))}
          </span>
          <span>
            <span className="font-medium text-fg-soft">{who}</span>{" "}
            {names.length === 1 ? (members[0]!.kind === "agent" ? agentDoing(members[0]!.id) : "is typing") : "are typing"}…
          </span>
        </>
      )}
    </div>
  );
}

/**
 * A panel beside the conversation: a thread, or the details. On a phone it
 * is a screen of its own, pushed over the conversation, as tall as what
 * the keyboard leaves.
 */
function SidePanel({ title, subtitle, onClose, menu, children }: { title: string; subtitle?: string; onClose: () => void; menu?: ReactNode; children: ReactNode }) {
  const swipe = useSwipeBack(onClose);
  return (
    <aside
      {...swipe}
      aria-label={title}
      className="fixed inset-0 z-40 flex flex-col bg-bg lg:static lg:z-auto lg:w-[22rem] lg:shrink-0 lg:border-l lg:border-line xl:w-[24rem] max-md:top-(--vv-top,0px) max-md:bottom-auto max-md:h-(--vv-height,100dvh) max-md:pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)] max-md:pl-1.5">
        <button type="button" onClick={onClose} aria-label="Back" className="flex size-10 items-center justify-center rounded-full text-muted active:bg-raised lg:hidden">
          <ChevronLeft size={22} />
        </button>
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        {subtitle && <span className="truncate text-sm text-faint">{subtitle}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {menu}
          <button type="button" onClick={onClose} aria-label="Close" className="hidden rounded-md p-1 text-faint hover:bg-raised hover:text-fg lg:block">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 grow flex-col">{children}</div>
    </aside>
  );
}

function ThreadPanel({
  root,
  replies,
  zone,
  context,
  code,
  slug,
  people,
  joined,
  onSend,
  onRetry,
  onTyping,
  draftKey,
}: {
  root: ShownMessage | null;
  replies: ShownMessage[] | null;
  zone: string | undefined;
  context: TextContext;
  code: boolean;
  slug: string;
  people: Mentionable[];
  joined: boolean;
  onSend: (body: string) => void;
  onRetry: (message: ShownMessage) => void;
  /** Says "is typing" to the others in the channel, as the main composer does. */
  onTyping: () => void;
  draftKey: string;
}) {
  const rows = useMemo(() => timeline(replies ?? [], new Date(), zone).filter((row) => row.kind === "message"), [replies, zone]);
  return (
    <>
      <div className="min-h-0 grow overflow-y-auto px-1 py-3 [scrollbar-width:thin]">
        {root ? (
          <MessageRow message={root} head zone={zone} context={context} code={code} slug={slug} onRetry={() => onRetry(root)} inThread />
        ) : (
          replies != null && <p className="px-4 py-2 text-sm text-faint">The message this thread is under is further back.</p>
        )}
        <div className="my-2 flex items-center gap-3 px-4 text-xs text-faint">
          {replies == null ? "Loading replies…" : `${replies.filter((r) => !r.deleted_at).length} ${replies.length === 1 ? "reply" : "replies"}`}
          <span className="h-px grow bg-line" />
        </div>
        {rows.map((row) =>
          row.kind === "message" ? (
            <MessageRow
              key={row.key}
              message={row.message}
              head={row.head}
              zone={zone}
              context={context}
              code={code}
              slug={slug}
              onRetry={() => onRetry(row.message)}
              inThread
            />
          ) : null,
        )}
      </div>
      {joined && (
        <div className="shrink-0 p-3">
          <Composer draftKey={draftKey} placeholder="Reply…" people={people} onSend={onSend} onTyping={onTyping} compact autoFocus />
        </div>
      )}
    </>
  );
}

/**
 * A channel's name, topic and visibility, and changing them: any member
 * edits the topic; renaming and archiving are for whoever the workspace's
 * chat settings allow (`canManage`). #general keeps its name and stays.
 */
function ChannelAbout({
  channel,
  joined,
  canManage,
  onUpdate,
}: {
  channel: Channel;
  joined: boolean;
  canManage: boolean;
  onUpdate: (change: ChannelChange) => Promise<Result<unknown>>;
}) {
  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const general = channel.name === "general";
  const archived = !!channel.archived_at;
  const mayRename = canManage && !general && !archived;
  const mayTopic = joined && !archived;
  const save = async (change: ChannelChange) => {
    setBusy(true);
    setError(null);
    const done = await onUpdate(change);
    setBusy(false);
    if (!done.ok) return setError(done.error.message);
    setEditing(null);
    setConfirm(false);
  };
  const start = (field: "name" | "topic") => {
    setEditing(field);
    setValue(field === "name" ? (channel.name ?? "") : (channel.topic ?? ""));
    setError(null);
  };
  const edit = (field: "name" | "topic") => (
    <form
      className="mt-1.5 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save(field === "name" ? { name: value } : { topic: value });
      }}
    >
      <span className="flex h-9 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 focus-within:border-accent-dim">
        {field === "name" && (channel.private ? <Lock size={13} className="text-faint" /> : <Hash size={13} className="text-faint" />)}
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
          maxLength={field === "name" ? 80 : 250}
          placeholder={field === "name" ? "channel-name" : "What this channel is for"}
          aria-label={field === "name" ? "Channel name" : "Topic"}
          autoComplete="off"
          data-1p-ignore
          className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </span>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => setEditing(null)} className="h-7 rounded-md px-2.5 text-xs text-muted hover:bg-raised hover:text-fg">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="h-7 rounded-md bg-accent px-2.5 text-xs font-medium text-bg hover:bg-accent-hover disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
  const editButton = (field: "name" | "topic", label: string) => (
    <button
      type="button"
      onClick={() => start(field)}
      aria-label={label}
      className="rounded px-1.5 py-0.5 text-xs text-muted opacity-0 transition-opacity group-hover/about:opacity-100 hover:bg-raised hover:text-fg focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
    >
      Edit
    </button>
  );
  return (
    <>
      <section className="group/about rounded-xl border border-line bg-surface p-3.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-faint">Name</h3>
          {mayRename && editing !== "name" && editButton("name", "Rename channel")}
        </div>
        {editing === "name" ? edit("name") : <p className="mt-1 text-sm text-fg-soft">#{channel.name}</p>}
        <div className="mt-3 flex items-center justify-between">
          <h3 className="text-xs font-medium text-faint">Topic</h3>
          {mayTopic && editing !== "topic" && editButton("topic", "Edit topic")}
        </div>
        {editing === "topic" ? edit("topic") : <p className="mt-1 text-sm text-fg-soft">{channel.topic || "No topic yet."}</p>}
        <h3 className="mt-3 text-xs font-medium text-faint">Visibility</h3>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-fg-soft">
          {channel.private ? <Lock size={13} /> : <Hash size={13} />}
          {channel.private ? "Private: only its members can find and read it" : "Public: anyone in the workspace can read and join"}
        </p>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </section>
      {canManage && !general && (
        <button
          type="button"
          onClick={() => (archived ? void save({ archived: false }) : setConfirm(true))}
          disabled={busy}
          className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-md text-[0.8125rem] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {archived ? "Unarchive channel" : "Archive channel"}
        </button>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive #{channel.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves everyone&apos;s sidebar and nobody can post in it. Its history stays readable, and it can be unarchived from Browse
              channels, Archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void save({ archived: true });
              }}
              disabled={busy}
            >
              {busy ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InfoPanel({
  data,
  members,
  slug,
  people,
  onAdded,
  joined,
  canManage,
  onUpdate,
}: {
  data: Loaded;
  members: ChannelMember[];
  slug: string;
  people: Mentionable[];
  onAdded: (member: ChannelMember) => void;
  joined: boolean;
  /** Whether the viewer may rename, archive and unarchive it. */
  canManage: boolean;
  onUpdate: (change: ChannelChange) => Promise<Result<unknown>>;
}) {
  const channel = data.channel;
  const agents = members.filter((m) => m.member.kind === "agent");
  const humans = members.filter((m) => m.member.kind === "user");
  return (
    <div className="min-h-0 grow overflow-y-auto p-4 [scrollbar-width:thin]">
      {channel.kind === "channel" && <ChannelAbout channel={channel} joined={joined} canManage={canManage} onUpdate={onUpdate} />}
      {agents.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 px-1 text-xs font-medium text-faint">Agents · {agents.length}</h3>
          <div className="flex flex-wrap gap-1.5">
            {agents.map(({ member }) => (
              <Hint key={member.id} label={member.role ?? undefined}>
                <MemberCard
                  member={member}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 pr-2.5 pl-1 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-accent/15"
                >
                  <MemberAvatar member={member} size={20} />
                  {shownName(member)}
                </MemberCard>
              </Hint>
            ))}
          </div>
        </section>
      )}
      <section className="mt-5">
        <div className="mb-1 flex items-center justify-between px-1">
          <h3 className="text-xs font-medium text-faint">People · {humans.length}</h3>
          {joined && channel.kind === "channel" && <AddMember slug={slug} channelId={channel.id} people={people} members={members} onAdded={onAdded} />}
        </div>
        <ul className="space-y-px">
          {humans.map(({ member, role }) => (
            <li key={member.id}>
              <MemberCard member={member} className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 transition-colors hover:bg-raised/60 max-md:min-h-11">
                <MemberAvatar member={member} size={26} presence />
                <span className="min-w-0 grow truncate text-sm">
                  {shownName(member)}
                  {shownName(member) !== shownHandle(member) && <span className="ml-1.5 text-faint">@{shownHandle(member)}</span>}
                  <PersonStatusEmoji person={{ id: member.id, username: member.name }} size={13} className="ml-1.5 align-[-2px]" inert />
                </span>
                {role === "owner" && <span className="text-[0.6875rem] text-faint">Owner</span>}
              </MemberCard>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Adding a person or an agent to the channel. An invite lets them read; it never grants write. */
function AddMember({
  slug,
  channelId,
  people,
  members,
  onAdded,
}: {
  slug: string;
  channelId: string;
  people: Mentionable[];
  members: ChannelMember[];
  onAdded: (member: ChannelMember) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useChatSend(slug);
  const chatData = useChatData();
  const inside = new Set(members.map((m) => `${m.member.kind}:${m.member.name.toLowerCase()}`));
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const options = people
    .filter((p) => !inside.has(`${p.kind}:${p.name.toLowerCase()}`))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q))
    .slice(0, 8);
  const add = async (person: Mentionable) => {
    const agent = person.kind === "agent" ? chatData?.agents.find((a) => a.handle === person.name) : null;
    const key = agent ? `agent:${agent.id}` : `user:${person.name}`;
    setError(null);
    const done = await send({ intent: "invite", channel_id: channelId, member: key });
    if (!done.ok) return setError(done.error.message);
    onAdded({
      channel_id: channelId,
      member: { kind: person.kind, id: agent?.id ?? person.name, name: person.name, display_username: person.display_username ?? null, display_name: person.display_name, avatar: person.avatar, role: person.role ?? null },
      role: "member",
      starred: false,
      muted: false,
      last_read_id: null,
      joined_at: new Date().toISOString(),
    });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-raised hover:text-fg">
          <UserPlus size={13} />
          Add
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Add a person or an agent"
          aria-label="Add a person or an agent"
          autoComplete="off"
          data-1p-ignore
          className="mb-1 h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm outline-none placeholder:text-faint focus:border-accent-dim"
        />
        {options.length === 0 && <p className="px-2 py-3 text-xs text-faint">Everyone who matches is already here.</p>}
        {options.map((person) => (
          <button
            key={`${person.kind}:${person.name}`}
            type="button"
            onClick={() => void add(person)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-line"
          >
            <MemberAvatar member={person} size={20} />
            <span className="min-w-0 grow truncate">{person.display_name}</span>
            {person.kind === "agent" && <AgentPill />}
          </button>
        ))}
        {error && <p className="px-2 pt-1 text-xs text-danger">{error}</p>}
        <p className="border-t border-line px-2 pt-1.5 pb-0.5 text-[0.6875rem] leading-snug text-faint">
          Adding an agent lets it read this channel. It never grants it write access.
        </p>
      </PopoverContent>
    </Popover>
  );
}
