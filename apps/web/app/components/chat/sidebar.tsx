import { BellOff, ChevronDown, Compass, Hash, Lock, Pin, PinOff, Plus, Search } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useFetcher, useLocation, useNavigate } from "react-router";

import type { ChatSidebarEntry, WorkspaceAgent } from "@g1t/contracts";

import { conversationCache } from "./conversation-cache";
import { CreateChannelButton, NewMessageButton, useChatData, useChatSend, useChatSidebar } from "./actions";
import { MemberAvatar, StatusDot, statusLabel } from "./marks";
import { AgentAvatar } from "../agent-avatar";
import { PersonStatusEmoji } from "../presence";
import { isOrchestrator } from "../orchestrator";
import { Hint } from "../ui/hint";
import { Skeleton } from "../ui/skeleton";
import { type ChatFilter, agentDmOf, channelPath, filterEntries, sections } from "../../lib/chat";
import { feedConnected } from "../../lib/notify-client";
import { FALLBACK_REFRESH_MS } from "../../lib/notify-store";

/** How often the sidebar asks again while the tab is shown and the feed socket is down. */
const REFRESH_MS = FALLBACK_REFRESH_MS;

const ROW =
  "group/row flex h-8 items-center gap-2 rounded-md pr-1.5 pl-2 text-[0.8125rem] transition-colors max-md:h-11 max-md:text-[0.9375rem] max-md:active:bg-raised";

/** Unread on a row: lavender for a mention, quiet for the rest. */
function Count({ entry }: { entry: ChatSidebarEntry | undefined }) {
  if (!entry || entry.muted) return null;
  const count = entry.mentions > 0 ? entry.mentions : entry.unread;
  if (count <= 0) return null;
  return (
    <span
      className={`min-w-5 shrink-0 rounded-full group-hover/row:invisible px-1.5 text-center text-[0.6875rem] leading-[1.125rem] font-semibold tabular-nums ${
        entry.mentions > 0 ? "bg-accent text-bg" : "bg-line-strong text-fg"
      }`}
    >
      {count}
    </span>
  );
}

/**
 * Chat mode's sidebar: what you pinned, the channels, the workspace's
 * agents (g1t first, each opening your conversation with it), then direct
 * messages with people. All, Unread and Mentions filter every section. It
 * refreshes itself while the tab is shown, so unread counts move without
 * a reload.
 */
export function ChatSidebar({ slug, heading = true }: { slug: string; heading?: boolean }) {
  const data = useChatData();
  const { sidebar, refresh } = useChatSidebar();
  const send = useChatSend(slug);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!data) return;
    // Notify: counts arrive live over the feed socket; this asks again only while it is down.
    const tick = () => {
      if (document.visibilityState === "visible" && !feedConnected()) refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [data, refresh]);

  // Pins show at once and go back if the service refuses.
  const [pins, setPins] = useState<Map<string, boolean>>(new Map());
  useEffect(() => setPins(new Map()), [sidebar]);
  const entries = (sidebar?.entries ?? []).map((e) => (pins.has(e.channel.id) ? { ...e, starred: pins.get(e.channel.id)! } : e));
  const shown = filterEntries(entries, filter, query);
  const { pinned, channels, dms } = sections(shown);
  const { agentDms } = sections(entries);
  const loading = !data;
  const owner = data?.role === "owner";

  // Every agent, g1t first; filtered as the conversations are.
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const agents = [...(data?.agents ?? [])]
    .sort((a, b) => Number(isOrchestrator(b)) - Number(isOrchestrator(a)) || a.display_name.localeCompare(b.display_name))
    .filter((agent) => {
      const dm = agentDms.get(agent.id);
      if (filter === "unread" && !(dm && !dm.muted && (dm.unread > 0 || dm.mentions > 0))) return false;
      if (filter === "mentions" && !(dm && dm.mentions > 0)) return false;
      return !q || agent.handle.includes(q) || agent.display_name.toLowerCase().includes(q) || agent.role.toLowerCase().includes(q);
    });

  /** The direct message with an agent: opened, or made on first use. */
  const openAgent = async (agent: WorkspaceAgent, pin = false) => {
    const had = agentDms.get(agent.id);
    if (had && !pin) return navigate(channelPath(slug, had.channel));
    setOpening(agent.id);
    const opened = had ? { ok: true as const, value: { channel: had.channel, to: channelPath(slug, had.channel) } } : await send<{ channel: ChatSidebarEntry["channel"]; to: string }>({ intent: "dm", members: [`agent:${agent.id}`] });
    if (opened.ok && pin) await send({ intent: "preferences", channel_id: opened.value.channel.id, starred: !had?.starred });
    setOpening(null);
    if (opened.ok && !pin) navigate(opened.value.to);
    if (pin) refresh();
  };
  const togglePin = async (entry: ChatSidebarEntry) => {
    const next = !entry.starred;
    setPins((now) => new Map(now).set(entry.channel.id, next));
    const done = await send({ intent: "preferences", channel_id: entry.channel.id, starred: next });
    if (!done.ok)
      setPins((now) => {
        const back = new Map(now);
        back.delete(entry.channel.id);
        return back;
      });
  };

  const conversation = (entry: ChatSidebarEntry) => (
    <ConversationRow key={entry.channel.id} entry={entry} slug={slug} pathname={pathname} agents={data?.agents ?? []} onPin={() => void togglePin(entry)} />
  );

  return (
    // The colour behind it, for the dots cut out of people's avatars.
    <div className="flex h-full flex-col [--chat-sidebar-bg:color-mix(in_srgb,var(--color-surface)_70%,var(--color-bg))]">
      {heading && (
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-2.5 pl-4">
          <h2 className="text-[0.9375rem] font-semibold">Chat</h2>
          <NewMessageButton slug={slug} />
        </div>
      )}
      <div className="space-y-2.5 px-2.5 pt-3">
        <label className="flex h-8 items-center gap-2 rounded-md bg-surface px-2.5 text-[0.8125rem] ring-1 ring-line transition-shadow focus-within:ring-accent-dim/70">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = [...pinned, ...channels, ...dms][0];
                if (first) {
                  navigate(channelPath(slug, first.channel));
                  setQuery("");
                } else if (agents[0]) void openAgent(agents[0]);
              } else if (event.key === "Escape") setQuery("");
            }}
            placeholder="Jump to channel or person"
            aria-label="Jump to channel or person"
            autoComplete="off"
            data-1p-ignore
            className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint"
          />
        </label>
        <div role="radiogroup" aria-label="Show" className="grid grid-cols-3 rounded-md bg-surface p-0.5 ring-1 ring-line">
          {(["all", "unread", "mentions"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={filter === key}
              onClick={() => setFilter(key)}
              className={`h-6 rounded-[5px] text-xs font-medium capitalize transition-colors ${
                filter === key ? "bg-raised text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      </div>
      {/* A phone's list (no heading): room at the end so the compose button never covers the last row. */}
      <nav
        aria-label="Conversations"
        className={`min-h-0 grow overflow-y-auto px-2.5 pt-3 [scrollbar-width:thin] ${heading ? "pb-4" : "pb-[calc(5.5rem+env(safe-area-inset-bottom))]"}`}
      >
        {loading ? (
          <SidebarSkeleton />
        ) : !sidebar ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-faint">Chat didn&apos;t answer. Your conversations will show here once it does.</p>
        ) : (
          <>
            {pinned.length > 0 && <Section title="Pinned">{pinned.map(conversation)}</Section>}
            <Section title="Channels" action={<CreateChannelButton slug={slug} />}>
              {channels.map(conversation)}
              {channels.length === 0 && filter === "all" && !query && <Empty>No channels yet.</Empty>}
            </Section>
            <Section
              title="Agents"
              action={
                owner ? (
                  <Hint label="New agent">
                    <Link
                      to={`/${slug}/-/agents/new`}
                      aria-label="New agent"
                      className="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
                    >
                      <Plus size={14} />
                    </Link>
                  </Hint>
                ) : null
              }
            >
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  dm={agentDms.get(agent.id)}
                  current={(() => {
                    const dm = agentDms.get(agent.id);
                    return dm != null && pathname === channelPath(slug, dm.channel);
                  })()}
                  busy={opening === agent.id}
                  onOpen={() => void openAgent(agent)}
                  onPin={() => void openAgent(agent, true)}
                />
              ))}
              {agents.length === 0 && filter === "all" && !query && <Empty>No agents yet.</Empty>}
            </Section>
            <Section title="Direct messages" action={<NewMessageButton slug={slug} />}>
              {dms.map(conversation)}
              {dms.length === 0 && filter === "all" && !query && <Empty>Message a teammate.</Empty>}
            </Section>
            {shown.length === 0 && agents.length === 0 && (filter !== "all" || query) && (
              <p className="px-2 py-2 text-xs text-faint">{query ? "Nothing matches." : filter === "unread" ? "You're all caught up." : "No mentions."}</p>
            )}
            <NavLink
              to={`/${slug}/-/chat/browse`}
              className={({ isActive }) =>
                `mt-3 flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${isActive ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`
              }
            >
              <Compass size={15} className="text-faint" />
              Browse all channels
              <span className="ml-auto text-xs text-faint tabular-nums">{(sidebar.browsable ?? 0) + entries.filter((e) => e.channel.kind === "channel").length}</span>
            </NavLink>
          </>
        )}
      </nav>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-3">
      <div className="group/head flex h-7 items-center justify-between pr-0.5 pl-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded px-1 text-xs font-medium text-faint transition-colors hover:text-muted"
        >
          <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
          {title}
        </button>
        <span className="opacity-70 transition-opacity group-hover/head:opacity-100">{action}</span>
      </div>
      {open && <ul className="space-y-px">{children}</ul>}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <li className="px-2 py-1 text-xs text-faint">{children}</li>;
}

/** Pin or unpin, on hover or focus; the same as the context menu's first item. */
function PinButton({ pinned, onPin, label }: { pinned: boolean; onPin: () => void; label: string }) {
  return (
    <Hint label={pinned ? "Unpin" : "Pin to the top"}>
      <button
        type="button"
        aria-label={`${pinned ? "Unpin" : "Pin"} ${label}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPin();
        }}
        className="absolute top-1/2 right-1 hidden size-6 -translate-y-1/2 items-center justify-center rounded bg-raised text-faint group-hover/row:flex group-focus-within/row:flex hover:bg-line hover:text-fg [@media(hover:none)]:hidden"
      >
        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
    </Hint>
  );
}

/** Right-click on a row: pin it, or open it. */
function RowMenu({ pinned, onPin, to, children }: { pinned: boolean; onPin: () => void; to?: string; children: ReactNode }) {
  const navigate = useNavigate();
  const item =
    "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] text-fg/90 outline-none select-none data-highlighted:bg-line data-highlighted:text-fg [&_svg]:size-4 [&_svg]:text-muted";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-44 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40 data-[state=open]:animate-pop-in">
          <ContextMenu.Item className={item} onSelect={onPin}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? "Unpin" : "Pin to the top"}
          </ContextMenu.Item>
          {to && (
            <ContextMenu.Item className={item} onSelect={() => navigate(to)}>
              <Hash />
              Open
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * Reads a conversation ahead, on hover, focus or the start of a touch, so
 * opening it draws at once (its route's `clientLoader` keeps it).
 */
function usePrefetchConversation(to: string) {
  const fetcher = useFetcher();
  const load = () => {
    if (fetcher.state === "idle" && fetcher.data === undefined && !conversationCache.has(to)) fetcher.load(to);
  };
  return { onPointerEnter: load, onFocus: load, onTouchStart: load };
}

/** One channel or direct message: its mark, its name, its unread count, and a pin. */
function ConversationRow({
  entry,
  slug,
  pathname,
  agents,
  onPin,
}: {
  entry: ChatSidebarEntry;
  slug: string;
  pathname: string;
  agents: WorkspaceAgent[];
  onPin: () => void;
}) {
  const to = channelPath(slug, entry.channel);
  const current = pathname === to || pathname.startsWith(`${to}/`);
  const prefetch = usePrefetchConversation(to);
  const unread = !entry.muted && (entry.unread > 0 || entry.mentions > 0);
  const agentId = agentDmOf(entry);
  const agent = agentId ? agents.find((a) => a.id === agentId) : null;
  const other = entry.others[0];
  const icon = agent ? (
    <AgentAvatar agent={{ ...agent, builtin: isOrchestrator(agent) }} size={18} />
  ) : entry.channel.kind === "dm" && other ? (
    // One person: their dot, cut out of the sidebar behind it.
    <MemberAvatar member={other} size={18} presence={entry.others.length === 1} ring="var(--chat-sidebar-bg)" />
  ) : entry.channel.private ? (
    <Lock size={14} />
  ) : (
    <Hash size={15} />
  );
  return (
    <li className="group/row relative">
      <RowMenu pinned={entry.starred} onPin={onPin} to={to}>
        <NavLink
          to={to}
          {...prefetch}
          aria-current={current ? "page" : undefined}
          className={`${ROW} ${
            current ? "bg-raised text-fg" : unread ? "text-fg hover:bg-raised/60" : entry.muted ? "text-faint hover:bg-raised/60 hover:text-muted" : "text-muted hover:bg-raised/60 hover:text-fg"
          }`}
        >
          <span className={`flex w-[18px] shrink-0 justify-center ${current || unread ? "text-muted" : "text-faint"}`}>{icon}</span>
          <span className={`min-w-0 grow truncate ${unread ? "font-semibold" : current ? "font-medium" : ""}`}>
            {entry.title}
            {entry.channel.kind === "dm" && other?.kind === "user" && entry.others.length === 1 && (
              <PersonStatusEmoji person={{ id: other.id, username: other.name }} size={13} className="ml-1.5 align-[-2px]" inert />
            )}
          </span>
          {entry.muted && <BellOff size={12} className="shrink-0 text-faint" aria-label="Muted" />}
          <Count entry={entry} />
        </NavLink>
      </RowMenu>
      <PinButton pinned={entry.starred} onPin={onPin} label={entry.title} />
    </li>
  );
}

/** One agent: its face, its name and status, and unread from your conversation with it. */
function AgentRow({
  agent,
  dm,
  current,
  busy,
  onOpen,
  onPin,
}: {
  agent: WorkspaceAgent;
  dm: ChatSidebarEntry | undefined;
  current: boolean;
  busy: boolean;
  onOpen: () => void;
  onPin: () => void;
}) {
  const g1t = isOrchestrator(agent);
  const unread = dm != null && !dm.muted && (dm.unread > 0 || dm.mentions > 0);
  return (
    <li className="group/row relative">
      <RowMenu pinned={dm?.starred ?? false} onPin={onPin}>
        <button
          type="button"
          onClick={onOpen}
          aria-current={current ? "page" : undefined}
          aria-busy={busy || undefined}
          className={`${ROW} w-full text-left ${current ? "bg-raised text-fg" : unread ? "text-fg hover:bg-raised/60" : "text-muted hover:bg-raised/60 hover:text-fg"} ${busy ? "opacity-60" : ""}`}
        >
          <span className="relative flex w-[18px] shrink-0 justify-center">
            <AgentAvatar agent={{ ...agent, builtin: g1t }} size={18} />
          </span>
          <span className={`min-w-0 grow truncate ${unread ? "font-semibold" : current ? "font-medium" : ""}`}>
            {agent.display_name}
            <span className="ml-1.5 text-[0.6875rem] font-normal text-faint">{g1t ? "orchestrator" : agent.title}</span>
          </span>
          {!g1t && (
            <Hint label={statusLabel(agent.status)}>
              <span className="flex size-4 shrink-0 items-center justify-center">
                <StatusDot status={agent.status} />
              </span>
            </Hint>
          )}
          <Count entry={dm} />
        </button>
      </RowMenu>
      <PinButton pinned={dm?.starred ?? false} onPin={onPin} label={agent.display_name} />
    </li>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-2 pt-1" aria-busy="true">
      <Skeleton className="h-3 w-16" />
      {[70, 52, 84, 60].map((w) => (
        <div key={w} className="flex h-6 items-center gap-2">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
      <Skeleton className="mt-4 h-3 w-24" />
      {[64, 48, 72].map((w) => (
        <div key={w} className="flex h-6 items-center gap-2">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
