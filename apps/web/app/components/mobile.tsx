import {
  Activity,
  BarChart3,
  BookOpen,
  Building2,
  Check,
  CircleUserRound,
  Code2,
  House,
  Inbox,
  LifeBuoy,
  LogOut,
  MessagesSquare,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Users,
  UsersRound,
} from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSubmit } from "react-router";

import { type Membership, type User, hasCodeAccess } from "@g1t/contracts";

import { Avatar } from "./ui";
import { STATUS_URL } from "../lib/status";
import { modeOf } from "../lib/workspace-nav";

/**
 * The phone's layout (below 768px): a tab bar along the bottom, the
 * workspace's avatar opening a sheet for everything else, and each tab a
 * list that pushes its detail full screen. Desktop keeps the rail.
 */

/** Whether a path is one conversation, which takes the whole screen on a phone. */
export function isConversation(pathname: string): boolean {
  return /^\/[^/]+\/-\/chat\/(?!browse\/?$)[^/]+/.test(pathname);
}

/**
 * Follows the visual viewport, which shrinks when the keyboard opens: its
 * height and top go on the page as `--vv-height` and `--vv-top`, and
 * `data-keyboard="open"` on <html> while the keyboard is up, so a
 * composer can sit just above it and the tab bar can step aside.
 */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--vv-height", `${viewport.height}px`);
      root.style.setProperty("--vv-top", `${viewport.offsetTop}px`);
      const keyboard = window.innerHeight - viewport.height > 140;
      if (keyboard) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}

/**
 * Swipe from the left edge to go back, as on a phone's own apps: a touch
 * that starts within 28px of the edge and travels 80px right, more across
 * than down. Going back is the browser's own back, so history stays true.
 */
export function useSwipeBack(onBack: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      start.current = touch && touch.clientX < 28 ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMove: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      if (!start.current || !touch) return;
      const dx = touch.clientX - start.current.x;
      const dy = Math.abs(touch.clientY - start.current.y);
      if (dx > 80 && dx > dy * 1.5) {
        start.current = null;
        onBack();
      }
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}

/** Back, as the browser would; to `fallback` when this page was the first one opened. */
export function useBack(fallback: string) {
  const navigate = useNavigate();
  return () => {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  };
}

type Tab = { key: string; label: string; to: string; icon: ReactNode; badge?: { count: number; loud: boolean } };

/**
 * The tab bar along the bottom of a phone: Home, Chat, Agents, Code (Docs,
 * for a member without Code) and the Inbox, each with what is unread. It
 * steps aside while the keyboard is up and inside a conversation.
 */
export function MobileTabBar({ workspace, unread }: { workspace: Membership; unread: { inbox: number; chat: number; mentions: number } }) {
  const { pathname } = useLocation();
  const slug = workspace.slug;
  const code = hasCodeAccess(workspace);
  const mode = modeOf(pathname, slug);
  const tabs: Tab[] = [
    { key: "home", label: "Home", to: `/${slug}/-/home`, icon: <House size={21} /> },
    {
      key: "chat",
      label: "Chat",
      to: `/${slug}/-/chat`,
      icon: <MessagesSquare size={21} />,
      badge: { count: unread.mentions > 0 ? unread.mentions : unread.chat, loud: unread.mentions > 0 },
    },
    { key: "agents", label: "Agents", to: `/${slug}/-/agents`, icon: <Sparkles size={21} /> },
    code
      ? { key: "code", label: "Code", to: `/${slug}/-/projects`, icon: <Code2 size={21} /> }
      : { key: "docs", label: "Docs", to: `/${slug}/-/docs`, icon: <BookOpen size={21} /> },
    { key: "inbox", label: "Inbox", to: "/inbox", icon: <Inbox size={21} />, badge: { count: unread.inbox, loud: true } },
  ];
  if (isConversation(pathname)) return null;
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[#0b0b0d]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden in-data-[keyboard=open]:hidden"
    >
      <ul className="grid h-14 grid-cols-5">
        {tabs.map((tab) => {
          const current = mode === tab.key;
          const count = tab.badge?.count ?? 0;
          return (
            <li key={tab.key}>
              <Link
                to={tab.to}
                prefetch="intent"
                aria-current={current ? "page" : undefined}
                aria-label={count > 0 ? `${tab.label}, ${count} unread` : tab.label}
                className="flex h-full flex-col items-center justify-center gap-0.5 transition-colors active:bg-raised/60"
              >
                <span className={`relative flex h-7 w-12 items-center justify-center rounded-full transition-colors ${current ? "bg-[#2c2c33] text-fg" : "text-muted"}`}>
                  {tab.icon}
                  {count > 0 && (
                    <span
                      className={`absolute -top-1 right-0.5 min-w-[1.125rem] rounded-full px-1 text-center text-[0.625rem] leading-[1.125rem] font-bold tabular-nums ring-2 ring-[#0b0b0d] ${
                        tab.badge?.loud ? "bg-accent text-bg" : "bg-[#3d3d45] text-fg"
                      }`}
                    >
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </span>
                <span className={`text-[0.6875rem] font-medium ${current ? "text-fg" : "text-faint"}`}>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A sheet that rises from the bottom of a phone, with a handle to drag it
 * back down. Escape, a tap outside or a drag of more than 90px closes it.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState(0);
  const from = useRef<number | null>(null);
  useEffect(() => {
    if (!open) setDrag(0);
  }, [open]);
  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      from.current = event.clientY;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (from.current == null) return;
      setDrag(Math.max(0, event.clientY - from.current));
    },
    onPointerUp: () => {
      if (drag > 90) onOpenChange(false);
      else setDrag(0);
      from.current = null;
    },
  };
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Primitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={{ transform: drag ? `translateY(${drag}px)` : undefined, transition: from.current == null ? "transform 0.2s ease-out" : "none" }}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-line-strong bg-surface pb-[env(safe-area-inset-bottom)] text-fg shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-[sheet-in-bottom_0.24s_cubic-bezier(0.16,1,0.3,1)]"
        >
          <div {...handlers} className="flex shrink-0 cursor-grab touch-none justify-center pt-2.5 pb-2" aria-hidden="true">
            <span className="h-1.5 w-10 rounded-full bg-line-strong" />
          </div>
          <Primitive.Title className="sr-only">{title}</Primitive.Title>
          <div className="min-h-0 grow overflow-y-auto overscroll-contain px-3 pb-3">{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/** A row in a bottom sheet: 48px tall, an icon, words, and what sits at its end. */
export function SheetRow({ to, href, icon, children, end, onClick }: { to?: string; href?: string; icon: ReactNode; children: ReactNode; end?: ReactNode; onClick?: () => void }) {
  const className = "flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[0.9375rem] text-fg-soft transition-colors active:bg-raised";
  const inner = (
    <>
      <span className="flex w-6 shrink-0 justify-center text-muted [&_svg]:size-5">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      {end}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={className} onClick={onClick}>
        {inner}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

function SheetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-2 border-t border-line pt-2">
      <h3 className="px-3 pt-1 pb-1 text-xs font-medium text-faint">{title}</h3>
      {children}
    </section>
  );
}

function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/**
 * The phone's everything-else: the workspace avatar at the top left opens
 * it. Your workspaces, Docs, the workspace's own pages, help, and your
 * account. It replaces the menu sheet below 768px.
 */
export function AvatarSheetButton({ user, workspace }: { user: User; workspace: Membership }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const submit = useSubmit();
  useEffect(() => setOpen(false), [pathname]);
  const slug = workspace.slug;
  const owner = workspace.role === "owner";
  return (
    <>
      <button
        type="button"
        aria-label={`${displayName(workspace)}: workspaces, settings and account`}
        onClick={() => setOpen(true)}
        className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-xl transition-transform active:scale-95 md:hidden"
      >
        <Avatar name={slug} image={workspace.avatar} size={32} square />
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title="Workspaces, settings and account">
        <div className="flex items-center gap-3 px-3 pt-1 pb-3">
          <Avatar name={slug} image={workspace.avatar} size={44} square />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{displayName(workspace)}</p>
            <p className="truncate font-mono text-xs text-muted">g1t.sh/{slug}</p>
          </div>
        </div>
        <SheetGroup title="Switch workspace">
          {(user.workspaces ?? []).map((membership) => (
            <SheetRow
              key={membership.slug}
              to={`/${membership.slug}/-/home`}
              icon={<Avatar name={membership.slug} image={membership.avatar} size={24} square />}
              end={membership.slug === slug ? <Check size={18} className="text-accent" /> : null}
            >
              {displayName(membership)}
            </SheetRow>
          ))}
          <SheetRow to="/workspaces/new" icon={<Plus />}>
            New workspace
          </SheetRow>
        </SheetGroup>
        <SheetGroup title="Workspace">
          <SheetRow to={`/${slug}/-/docs`} icon={<BookOpen />}>
            Docs
          </SheetRow>
          <SheetRow to={`/${slug}/-/workspace`} icon={<Building2 />}>
            Overview
          </SheetRow>
          <SheetRow to={`/${slug}/-/people`} icon={<Users />}>
            People
          </SheetRow>
          <SheetRow to={`/${slug}/-/teams`} icon={<UsersRound />}>
            Teams
          </SheetRow>
          <SheetRow to={`/${slug}/-/usage`} icon={<BarChart3 />}>
            Usage and billing
          </SheetRow>
          <SheetRow to={`/${slug}/-/integrations`} icon={<Plug />}>
            Integrations
          </SheetRow>
          <SheetRow to={owner ? `/${slug}/-/settings` : `/${slug}/-/repositories`} icon={<Settings />}>
            Settings
          </SheetRow>
        </SheetGroup>
        <SheetGroup title="Help">
          <SheetRow to="/support" icon={<LifeBuoy />}>
            Support
          </SheetRow>
          <SheetRow href="https://docs.g1t.sh/" icon={<BookOpen />}>
            Documentation
          </SheetRow>
          <SheetRow href={STATUS_URL} icon={<Activity />}>
            Status
          </SheetRow>
        </SheetGroup>
        <SheetGroup title={`@${user.username}`}>
          <SheetRow to={`/u/${user.username}`} icon={<CircleUserRound />}>
            Your profile
          </SheetRow>
          <SheetRow to="/settings" icon={<Settings />}>
            Your settings
          </SheetRow>
          <SheetRow icon={<LogOut />} onClick={() => submit(null, { method: "post", action: "/logout" })}>
            Sign out
          </SheetRow>
        </SheetGroup>
      </BottomSheet>
    </>
  );
}
