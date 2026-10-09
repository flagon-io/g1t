import {
  ArrowLeft,
  BellOff,
  CircleDot,
  GitPullRequest,
  Hash,
  ListChecks,
  Lock,
  MessageSquareText,
  PanelRight,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouteLoaderData, useSearchParams } from "react-router";

import { type ChannelMember, type ChatLiveEvent, type ChatMessage, type MemberProfile, type MessageCard, type Result, hasCodeAccess } from "@g1t/contracts";

import { useChatData, useChatSend, useChatSidebar } from "./actions";
import { Composer } from "./composer";
import { type LiveState, useChatLive } from "./live";
import { AgentPill, MemberAvatar } from "./marks";
import { MessageText, type TextContext } from "./text";
import { Badge, type BadgeTone } from "../ui/badge";
import { Hint } from "../ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { type Mentionable, type ShownMessage, mergeMessages, shownName, timeline } from "../../lib/chat";
import { codeAccessPath } from "../../lib/workspace-nav";
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

/** Whether the viewer uses Code in this workspace (docs/WORKSPACE.md, "Members without Code"). */
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
  const [typing, setTyping] = useState<Map<string, { member: MemberProfile; until: number }>>(new Map());
  const [joined, setJoined] = useState(data.joined);
  const [members, setMembers] = useState<ChannelMember[]>(data.members);
  const [info, setInfo] = useState(false);
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
      ...(chatData?.agents ?? []).map((agent) => ({ kind: "agent" as const, name: agent.handle, display_name: agent.display_name, avatar: agent.avatar, role: agent.role })),
      ...(chatData?.people ?? []).filter((p) => p.name !== me?.username),
    ],
    [chatData, me?.username],
  );
  const context = useMemo<TextContext>(
    () => ({
      slug,
      me: me?.username ?? null,
      agents: new Set((chatData?.agents ?? []).map((a) => a.handle.toLowerCase())),
      channels: new Set((sidebar?.entries ?? []).filter((e) => e.channel.kind === "channel").map((e) => e.channel.name ?? "")),
      project,
      codeLink: code ? undefined : (href: string) => (/^\/[^/]+\/(?!-\/)[^/]+/.test(href) ? codeAccessPath(slug, href) : href),
    }),
    [slug, me?.username, chatData?.agents, sidebar?.entries, project, code],
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
      const result = (await response.json()) as Result<{ messages: ChatMessage[] }>;
      // The page reaches back to the message the thread is under: shown above it, not among the replies.
      setThread(result.ok ? mergeMessages([], result.value.messages.filter((m) => m.id !== threadId && !m.deleted_at)) : []);
    } catch {
      setThread([]);
    }
  }, [threadId, slug, data.channel.id]);
  useEffect(() => {
    setThread(null);
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
          if (message.thread_root === threadId) setThread((now) => (now ? mergeMessages(now, [message]) : now));
          if (event.type === "message.created") countReply(message.thread_root, message.id, message.created_at);
        } else {
          if (event.type === "message.updated") serverCounted.current.add(message.id);
          setMessages((now) => mergeMessages(now, [message]));
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
      } else if (event.type === "typing") {
        if (event.channel_id !== data.channel.id) return;
        if (event.member.kind === "user" && event.member.id === me?.id) return;
        setTyping((now) => new Map(now).set(`${event.member.kind}:${event.member.id}`, { member: event.member, until: new Date(event.until).getTime() }));
      }
    },
    [data.channel.id, threadId, me?.id, countReply],
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
      const author: MemberProfile = { kind: "user", id: me.id, name: me.username, display_name: me.username, avatar: me.avatar, role: null };
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
            member: { kind: "user", id: me.id, name: me.username, display_name: me.username, avatar: me.avatar, role: null },
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
  const typers = [...typing.values()].map((t) => t.member);
  const name = data.channel.name ?? "";
  const placeholder = isDm
    ? `Message ${others.map(shownName).join(", ") || "yourself"}`
    : `Message #${name}. @ a teammate or an agent`;
  const rootMessage = threadId ? messages.find((m) => m.id === threadId) ?? null : null;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 lg:h-dvh">
      <section aria-label={data.title} className="flex min-w-0 grow flex-col">
        <ChannelHeader
          data={data}
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
              <ConversationStart data={data} others={others} />
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
                  threadOpen={row.message.id === threadId}
                />
              ),
            )}
          </div>
        </div>
        <div className="shrink-0 px-2 pb-3 sm:px-4 sm:pb-4">
          <div className="mx-auto max-w-[56rem]">
            <TypingLine members={typers} />
            {joined ? (
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
        <SidePanel title="Thread" subtitle={isDm ? undefined : `#${name}`} onClose={() => openThread(null)}>
          <ThreadPanel
            root={rootMessage}
            replies={thread}
            zone={zone}
            context={context}
            code={code}
            slug={slug}
            people={people}
            joined={joined}
            onSend={(body) => void post(body, threadId)}
            onRetry={retry}
            draftKey={`${data.channel.id}:${threadId}`}
          />
        </SidePanel>
      ) : (
        info && (
          <SidePanel title={isDm ? "Details" : "About this channel"} onClose={toggleInfo}>
            <InfoPanel data={data} members={members} slug={slug} people={people} onAdded={(m) => setMembers((now) => [...now, m])} joined={joined} />
          </SidePanel>
        )
      )}
    </div>
  );
}

/** The top of a conversation: what it is, and its controls. */
function ChannelHeader({
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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-5">
      <div className="flex min-w-0 grow items-center gap-2.5">
        {channel.kind === "channel" ? (
          <>
            <h1 className="flex min-w-0 shrink-0 items-center gap-1 text-[0.9375rem] font-semibold">
              {channel.private ? <Lock size={15} className="text-faint" /> : <Hash size={16} className="text-faint" />}
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
                  <MemberAvatar member={member} size={26} />
                </span>
              ))}
            </span>
            <div className="min-w-0">
              <h1 className="flex min-w-0 items-center gap-1.5 text-[0.9375rem] leading-tight font-semibold">
                <span className="truncate">{others.map(shownName).join(", ") || "Just you"}</span>
                {agentDm && <AgentPill />}
              </h1>
              {agentDm?.role && <p className="truncate text-xs leading-tight text-muted">{agentDm.role}</p>}
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

const CARD_ICONS: Record<string, ReactNode> = {
  pull: <GitPullRequest size={16} />,
  issue: <CircleDot size={16} />,
  task: <ListChecks size={16} />,
  deploy: <Rocket size={16} />,
  approval: <ShieldCheck size={16} />,
};

/** How loud a card's state reads, from what it says. */
function stateTone(state: string): BadgeTone {
  const s = state.toLowerCase();
  if (/merged/.test(s)) return "merged";
  if (/fail|error|blocked|over budget|rejected/.test(s)) return "danger";
  if (/approval|waiting|review|queued|needs/.test(s)) return "warn";
  if (/pass|done|deployed|ready|approved|live|success/.test(s)) return "success";
  if (/working|running|in progress|open/.test(s)) return "info";
  return "neutral";
}

/** A card g1t or an agent posted: what it is about, a line of detail, and its state. */
export function CardBox({ card, href }: { card: MessageCard; href: string | null }) {
  const inner = (
    <>
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted group-hover:text-fg">
        {CARD_ICONS[card.kind] ?? <Sparkles size={16} />}
      </span>
      <span className="min-w-0 grow">
        <span className="line-clamp-2 text-sm font-medium text-fg">{card.title}</span>
        {card.detail && <span className="mt-0.5 block truncate font-mono text-xs text-muted">{card.detail}</span>}
      </span>
      {card.state && (
        <Badge tone={stateTone(card.state)} className="mt-0.5">
          {card.state}
        </Badge>
      )}
    </>
  );
  const box = "group mt-1.5 flex max-w-xl items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 transition-colors";
  return href ? (
    <Link to={href} className={`${box} hover:border-line-strong hover:bg-raised/40`}>
      {inner}
    </Link>
  ) : (
    <div className={box}>{inner}</div>
  );
}

function cardHref(card: MessageCard, slug: string, code: boolean): string | null {
  if (!card.href) return null;
  if (code || !/^\/[^/]+\/(?!-\/)[^/]+/.test(card.href)) return card.href;
  return codeAccessPath(slug, card.href);
}

/** One message: with its author's name and avatar when it starts a group. */
function MessageRow({
  message,
  head,
  zone,
  context,
  code,
  slug,
  onThread,
  onRetry,
  threadOpen,
  inThread,
}: {
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
  const profile = author.kind === "agent" ? `/${slug}/-/agents/${author.name}` : `/u/${author.name}`;
  return (
    <article
      aria-label={`${shownName(author)}, ${time}`}
      className={`group/message relative flex gap-3 rounded-lg px-2 transition-colors hover:bg-surface/70 sm:px-3 ${head ? "mt-3 pt-1 pb-1" : "py-0.5"} ${
        threadOpen ? "bg-accent/[0.06] hover:bg-accent/[0.08]" : ""
      }`}
    >
      <div className="w-9 shrink-0">
        {head ? (
          <Link to={profile} tabIndex={-1} aria-hidden="true" className="mt-0.5 block">
            <MemberAvatar member={author} size={36} />
          </Link>
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
            <Link to={profile} className="truncate text-[0.9375rem] font-semibold text-fg hover:underline">
              {shownName(author)}
            </Link>
            {author.kind === "agent" && <AgentPill className="self-center" />}
            <time dateTime={message.created_at} suppressHydrationWarning className="shrink-0 text-xs text-faint tabular-nums">
              {time}
            </time>
          </div>
        )}
        <div className={message.pending && !message.failed ? "opacity-60" : undefined}>
          {message.body && <MessageText body={message.body} context={context} />}
          {message.card && <CardBox card={message.card} href={cardHref(message.card, slug, code)} />}
          {message.edited_at && <span className="text-[0.6875rem] text-faint"> (edited)</span>}
        </div>
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
        <div className="absolute -top-3 right-3 hidden rounded-lg border border-line bg-surface p-0.5 shadow-lg shadow-black/30 group-hover/message:flex group-focus-within/message:flex">
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
        </div>
      )}
    </article>
  );
}

/** "reviewer is typing…", for whoever is. */
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
            <span className="font-medium text-fg-soft">{who}</span> {names.length === 1 ? "is" : "are"} typing…
          </span>
        </>
      )}
    </div>
  );
}

/** A panel beside the conversation: a thread, or the details. Over everything on a phone. */
function SidePanel({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside
      aria-label={title}
      className="fixed inset-0 z-40 flex flex-col bg-bg lg:static lg:z-auto lg:w-[22rem] lg:shrink-0 lg:border-l lg:border-line xl:w-[24rem]"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={onClose} aria-label="Back" className="-ml-1 rounded-md p-1 text-muted hover:bg-raised hover:text-fg lg:hidden">
          <ArrowLeft size={16} />
        </button>
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        {subtitle && <span className="truncate text-sm text-faint">{subtitle}</span>}
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto hidden rounded-md p-1 text-faint hover:bg-raised hover:text-fg lg:block">
          <X size={16} />
        </button>
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
  draftKey: string;
}) {
  const rows = useMemo(() => timeline(replies ?? [], new Date(), zone).filter((row) => row.kind === "message"), [replies, zone]);
  return (
    <>
      <div className="min-h-0 grow overflow-y-auto px-1 py-3 [scrollbar-width:thin]">
        {root ? (
          <MessageRow message={root} head zone={zone} context={context} code={code} slug={slug} onRetry={() => onRetry(root)} inThread />
        ) : (
          <p className="px-4 py-2 text-sm text-faint">The message this thread is under is further back.</p>
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
          <Composer draftKey={draftKey} placeholder="Reply…" people={people} onSend={onSend} compact autoFocus />
        </div>
      )}
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
}: {
  data: Loaded;
  members: ChannelMember[];
  slug: string;
  people: Mentionable[];
  onAdded: (member: ChannelMember) => void;
  joined: boolean;
}) {
  const channel = data.channel;
  const agents = members.filter((m) => m.member.kind === "agent");
  const humans = members.filter((m) => m.member.kind === "user");
  return (
    <div className="min-h-0 grow overflow-y-auto p-4 [scrollbar-width:thin]">
      {channel.kind === "channel" && (
        <section className="rounded-xl border border-line bg-surface p-3.5">
          <h3 className="text-xs font-medium text-faint">Topic</h3>
          <p className="mt-1 text-sm text-fg-soft">{channel.topic || "No topic yet."}</p>
          <h3 className="mt-3 text-xs font-medium text-faint">Visibility</h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-fg-soft">
            {channel.private ? <Lock size={13} /> : <Hash size={13} />}
            {channel.private ? "Private: invited members only" : "Public to the workspace"}
          </p>
        </section>
      )}
      {agents.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 px-1 text-xs font-medium text-faint">Agents · {agents.length}</h3>
          <div className="flex flex-wrap gap-1.5">
            {agents.map(({ member }) => (
              <Hint key={member.id} label={member.role ?? undefined}>
                <Link
                  to={`/${slug}/-/agents/${member.name}`}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 pr-2.5 pl-1 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-accent/15"
                >
                  <MemberAvatar member={member} size={20} />
                  {shownName(member)}
                </Link>
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
              <Link to={`/u/${member.name}`} className="flex items-center gap-2.5 rounded-md px-1 py-1.5 transition-colors hover:bg-raised/60">
                <MemberAvatar member={member} size={26} />
                <span className="min-w-0 grow truncate text-sm">
                  {shownName(member)}
                  {member.display_name !== member.name && <span className="ml-1.5 text-faint">@{member.name}</span>}
                </span>
                {role === "owner" && <span className="text-[0.6875rem] text-faint">Owner</span>}
              </Link>
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
      member: { kind: person.kind, id: agent?.id ?? person.name, name: person.name, display_name: person.display_name, avatar: person.avatar, role: person.role ?? null },
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
