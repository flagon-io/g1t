import { BellOff, Bot, ChevronDown, Compass, Hash, Lock, Pin, PinOff, Plus, Search } from "lucide-react";
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
 * Chat mode's sidebar: what you pinned, the channels (and a way to browse
 * the rest), then direct messages, the latest first, with people and
 * agents alike. Last, the agents you have not talked to yet, g1t first:
 * one click opens a conversation with any of them. Sections fold, and
 * stay folded on this device. All, Unread and Mentions filter every
 * section. It refreshes itself while the tab is shown, so unread counts
 * move without a reload.
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

  // The agents you have not talked to yet, g1t first: one click opens a
  // conversation, which then lists under Direct messages like anyone's.
  // Nothing of theirs is unread, so Unread and Mentions leave them out.
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const agents =
    filter !== "all"
      ? []
      : [...(data?.agents ?? [])]
          .filter((agent) => !agentDms.has(agent.id))
          .sort((a, b) => Number(isOrchestrator(b)) - Number(isOrchestrator(a)) || a.display_name.localeCompare(b.display_name))
          .filter((agent) => !q || agent.handle.includes(q) || agent.display_name.toLowerCase().includes(q) || agent.role.toLowerCase().includes(q));

  // Folded sections, remembered per workspace on this device. A folded
  // section still shows what is unread and the conversation open now.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setFolded(readFolded(slug)), [slug]);
  const fold = (id: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      writeFolded(slug, next);
      return next;
    });
  const keepShown = (entry: ChatSidebarEntry) => {
    const to = channelPath(slug, entry.channel);
    return pathname === to || pathname.startsWith(`${to}/`) || (!entry.muted && (entry.unread > 0 || entry.mentions > 0));
  };

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
    <div className="flex h-full flex-col [--chat-sidebar-bg:var(--color-shell)]">
      {heading && (
        <div className="flex h-9 shrink-0 items-center justify-between pr-1 pl-3">
          <h2 className="text-xs font-medium text-faint">Chat</h2>
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
            {pinned.length > 0 && (
              <Section id="pinned" title="Pinned" folded={folded} onFold={fold} keep={pinned.filter(keepShown).map(conversation)}>
                {pinned.map(conversation)}
              </Section>
            )}
            <Section
              id="channels"
              title="Channels"
              folded={folded}
              onFold={fold}
              action={<CreateChannelButton slug={slug} />}
              keep={channels.filter(keepShown).map(conversation)}
            >
              {channels.map(conversation)}
              {channels.length === 0 && filter === "all" && !query && <Empty>No channels yet.</Empty>}
              {filter === "all" && !query && (
                <ExtraRow to={`/${slug}/-/chat/browse`} icon={<Compass size={15} />} count={sidebar.browsable > 0 ? sidebar.browsable : undefined} countLabel="to join">
                  Browse channels
                </ExtraRow>
              )}
            </Section>
            <Section
              id="dms"
              title="Direct messages"
              folded={folded}
              onFold={fold}
              action={<NewMessageButton slug={slug} />}
              keep={dms.filter(keepShown).map(conversation)}
            >
              {dms.map(conversation)}
              {dms.length === 0 && filter === "all" && !query && <Empty>Message a teammate or an agent.</Empty>}
            </Section>
            {(agents.length > 0 || (filter === "all" && !query)) && (
              <Section
                id="agents"
                title="Agents"
                folded={folded}
                onFold={fold}
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
                    busy={opening === agent.id}
                    onOpen={() => void openAgent(agent)}
                    onPin={() => void openAgent(agent, true)}
                  />
                ))}
                {filter === "all" && !query && (
                  <ExtraRow to={`/${slug}/-/agents`} icon={<Bot size={15} />}>
                    {(data?.agents ?? []).length === 0 ? (owner ? "Hire an agent" : "No agents yet") : "All agents"}
                  </ExtraRow>
                )}
              </Section>
            )}
            {shown.length === 0 && agents.length === 0 && (filter !== "all" || query) && (
              <p className="px-2 py-2 text-xs text-faint">{query ? "Nothing matches." : filter === "unread" ? "You're all caught up." : "No mentions."}</p>
            )}
          </>
        )}
      </nav>
    </div>
  );
}

const FOLDED_KEY = (slug: string) => `g1t:chat-folded:${slug}`;

/** The sections folded in this workspace, as last left; none if storage is not there. */
function readFolded(slug: string): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDED_KEY(slug)) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolded(slug: string, folded: ReadonlySet<string>) {
  try {
    if (folded.size === 0) localStorage.removeItem(FOLDED_KEY(slug));
    else localStorage.setItem(FOLDED_KEY(slug), JSON.stringify([...folded]));
  } catch {
    // Private windows and blocked storage: folding still works until a reload.
  }
}

/**
 * A titled part of the sidebar that folds away. Folded, it keeps `keep`
 * showing: the unread conversations and the open one.
 */
function Section({
  id,
  title,
  folded,
  onFold,
  action,
  keep,
  children,
}: {
  id: string;
  title: string;
  folded: ReadonlySet<string>;
  onFold: (id: string) => void;
  action?: ReactNode;
  keep?: ReactNode[];
  children: ReactNode;
}) {
  const open = !folded.has(id);
  const list = `chat-section-${id}`;
  return (
    <section className="mb-3">
      <div className="group/head flex h-7 items-center justify-between pr-0.5 pl-1">
        <button
          type="button"
          onClick={() => onFold(id)}
          aria-expanded={open}
          aria-controls={list}
          className="flex min-w-0 grow items-center gap-1 rounded px-1 py-1 text-left text-xs font-medium text-faint transition-colors hover:text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none max-md:text-[0.8125rem]"
        >
          <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          {title}
        </button>
        <span className="opacity-70 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">{action}</span>
      </div>
      {(open || (keep && keep.length > 0)) && (
        <ul id={list} className="space-y-px">
          {open ? children : keep}
        </ul>
      )}
    </section>
  );
}

/** A quieter row at the end of a section: somewhere to go rather than a conversation. */
function ExtraRow({ to, icon, count, countLabel, children }: { to: string; icon: ReactNode; count?: number; countLabel?: string; children: ReactNode }) {
  return (
    <li>
      <NavLink
        to={to}
        end
        className={({ isActive }) => `${ROW} ${isActive ? "bg-raised text-fg" : "text-faint hover:bg-raised/60 hover:text-muted"}`}
      >
        <span className="flex w-4.5 shrink-0 justify-center">{icon}</span>
        <span className="min-w-0 grow truncate">{children}</span>
        {count != null && (
          <span className="shrink-0 text-xs tabular-nums">
            {count}
            {countLabel && <span className="sr-only"> {countLabel}</span>}
          </span>
        )}
      </NavLink>
    </li>
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
  const g1t = agent ? isOrchestrator(agent) : false;
  const icon = agent ? (
    <AgentFace agent={agent} g1t={g1t} />
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
          <span className={`flex w-4.5 shrink-0 justify-center ${current || unread ? "text-muted" : "text-faint"}`}>{icon}</span>
          <span className={`min-w-0 grow truncate ${unread ? "font-semibold" : current ? "font-medium" : ""}`}>
            {agent ? agent.display_name : entry.title}
            {agent && <span className="ml-1.5 text-[0.6875rem] font-normal text-faint">{g1t ? "orchestrator" : agent.title}</span>}
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

/** An agent's face in a row; any but g1t carries its status, cut out of the sidebar behind it. */
function AgentFace({ agent, g1t }: { agent: WorkspaceAgent; g1t: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <AgentAvatar agent={{ ...agent, builtin: g1t }} size={18} />
      {!g1t && agent.status !== "idle" && (
        <span className="absolute -right-1 -bottom-1 flex rounded-full p-[2px]" style={{ background: "var(--chat-sidebar-bg)" }}>
          <StatusDot status={agent.status} className="size-[7px] shadow-none" />
        </span>
      )}
    </span>
  );
}

/** An agent you have not talked to yet: its face, name and title. Opening it starts your conversation. */
function AgentRow({ agent, busy, onOpen, onPin }: { agent: WorkspaceAgent; busy: boolean; onOpen: () => void; onPin: () => void }) {
  const g1t = isOrchestrator(agent);
  return (
    <li className="group/row relative">
      <RowMenu pinned={false} onPin={onPin}>
        <button
          type="button"
          onClick={onOpen}
          aria-busy={busy || undefined}
          aria-label={`Message ${agent.display_name}, ${g1t ? "orchestrator" : agent.title}${g1t ? "" : `, ${statusLabel(agent.status).toLowerCase()}`}`}
          className={`${ROW} w-full text-left text-muted hover:bg-raised/60 hover:text-fg ${busy ? "opacity-60" : ""}`}
        >
          <span className="flex w-4.5 shrink-0 justify-center">
            <AgentFace agent={agent} g1t={g1t} />
          </span>
          <span className="min-w-0 grow truncate">
            {agent.display_name}
            <span className="ml-1.5 text-[0.6875rem] text-faint">{g1t ? "orchestrator" : agent.title}</span>
          </span>
        </button>
      </RowMenu>
      <PinButton pinned={false} onPin={onPin} label={agent.display_name} />
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
