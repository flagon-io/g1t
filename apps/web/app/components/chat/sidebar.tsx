import { BellOff, ChevronDown, Compass, Hash, Lock, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";

import type { ChatSidebarEntry } from "@g1t/contracts";

import { CreateChannelButton, NewMessageButton, useChatData, useChatSidebar } from "./actions";
import { MemberAvatar } from "./marks";
import { Skeleton } from "../ui/skeleton";
import { type ChatFilter, channelPath, filterEntries, sections } from "../../lib/chat";

/** How often the sidebar asks again while the tab is shown. */
const REFRESH_MS = 30_000;

/**
 * Chat mode's sidebar: the conversations, starred first, then channels and
 * direct messages, with what is unread in each. It refreshes itself while
 * the tab is shown, so unread counts move without a reload.
 */
export function ChatSidebar({ slug }: { slug: string }) {
  const data = useChatData();
  const { sidebar, refresh } = useChatSidebar();
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!data) return;
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [data, refresh]);
  const entries = sidebar?.entries ?? [];
  const shown = filterEntries(entries, filter, query);
  const { starred, channels, dms } = sections(shown);
  const loading = !data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-2.5 pl-4">
        <h2 className="text-[0.9375rem] font-semibold">Chat</h2>
        <NewMessageButton slug={slug} />
      </div>
      <div className="space-y-2.5 px-2.5 pt-3">
        <label className="flex h-8 items-center gap-2 rounded-md bg-surface px-2.5 text-[0.8125rem] ring-1 ring-line transition-shadow focus-within:ring-accent-dim/70">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = [...starred, ...channels, ...dms][0];
                if (first) {
                  navigate(channelPath(slug, first.channel));
                  setQuery("");
                }
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
      <nav aria-label="Conversations" className="min-h-0 grow overflow-y-auto px-2.5 pt-3 pb-4 [scrollbar-width:thin]">
        {loading ? (
          <SidebarSkeleton />
        ) : !sidebar ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-faint">Chat didn't answer. Your conversations will show here once it does.</p>
        ) : (
          <>
            {starred.length > 0 && (
              <Section title="Starred">
                {starred.map((entry) => (
                  <Row key={entry.channel.id} entry={entry} slug={slug} pathname={pathname} />
                ))}
              </Section>
            )}
            <Section title="Channels" action={<CreateChannelButton slug={slug} />}>
              {channels.map((entry) => (
                <Row key={entry.channel.id} entry={entry} slug={slug} pathname={pathname} />
              ))}
              {channels.length === 0 && filter === "all" && !query && <Empty>No channels yet.</Empty>}
            </Section>
            <Section title="Direct messages" action={<NewMessageButton slug={slug} />}>
              {dms.map((entry) => (
                <Row key={entry.channel.id} entry={entry} slug={slug} pathname={pathname} />
              ))}
              {dms.length === 0 && filter === "all" && !query && <Empty>Message a teammate or an agent.</Empty>}
            </Section>
            {shown.length === 0 && (filter !== "all" || query) && (
              <p className="px-2 py-2 text-xs text-faint">{query ? "No conversation matches." : filter === "unread" ? "You're all caught up." : "No mentions."}</p>
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

/** One conversation: its mark, its name, and its unread count. */
function Row({ entry, slug, pathname }: { entry: ChatSidebarEntry; slug: string; pathname: string }) {
  const to = channelPath(slug, entry.channel);
  const current = pathname === to || pathname.startsWith(`${to}/`);
  const unread = !entry.muted && (entry.unread > 0 || entry.mentions > 0);
  const count = entry.mentions > 0 ? entry.mentions : entry.unread;
  const other = entry.others[0];
  const icon =
    entry.channel.kind === "dm" && other ? (
      <MemberAvatar member={other} size={18} />
    ) : entry.channel.private ? (
      <Lock size={14} />
    ) : (
      <Hash size={15} />
    );
  return (
    <li>
      <NavLink
        to={to}
        prefetch="intent"
        aria-current={current ? "page" : undefined}
        className={`group flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current ? "bg-raised text-fg" : unread ? "text-fg hover:bg-raised/60" : entry.muted ? "text-faint hover:bg-raised/60 hover:text-muted" : "text-muted hover:bg-raised/60 hover:text-fg"
        }`}
      >
        <span className={`flex w-[18px] shrink-0 justify-center ${current || unread ? "text-muted" : "text-faint"}`}>{icon}</span>
        <span className={`min-w-0 grow truncate ${unread ? "font-semibold" : current ? "font-medium" : ""}`}>
          {entry.title}
        </span>
        {entry.muted && <BellOff size={12} className="shrink-0 text-faint" aria-label="Muted" />}
        {unread && count > 0 && (
          <span
            className={`min-w-5 shrink-0 rounded-full px-1.5 text-center text-[0.6875rem] leading-[1.125rem] font-semibold tabular-nums ${
              entry.mentions > 0 ? "bg-accent text-bg" : "bg-line-strong text-fg"
            }`}
          >
            {count}
          </span>
        )}
      </NavLink>
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
