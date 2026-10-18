import {
  Activity,
  BellOff,
  BellRing,
  BookOpen,
  CircleUserRound,
  Compass,
  Ellipsis,
  Keyboard,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  Moon,
  Settings,
  Smile,
  Sun,
} from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSubmit } from "react-router";

import { type Abilities, type Membership, type User, hasCodeAccess, shownUsername } from "@g1t/contracts";

import { appIcon, pinnedApp } from "./apps";
import { CountBadge, ShortcutsDialog } from "./rail";
import { Mark } from "./logo";

import { Avatar } from "./ui/avatar";
import { NavTab, NavTabs } from "./ui/nav-tabs";
import { StatusDialog } from "./presence";
import { ThemeSwitch } from "./theme-switch";
import { type BuiltinApp, PHONE_TABS, type PinnableApp, appOf, phoneMoreApps } from "../lib/apps";
import { setPresence, useOwnPresence } from "../lib/notify-client";
import { dndOn, liveStatus, pauseUntil, untilLabel } from "../lib/presence";
import { STATUS_URL } from "../lib/status";
import { type ModeKey, modeHome, modeOf } from "../lib/workspace-nav";
import { PROJECT_PAGE_LINKS, type ProjectPage, projectPageAt, projectPages } from "../lib/chrome";
import { ROADMAP, type RoadmapItem } from "../lib/roadmap";
import { repoWorkPath } from "../lib/work-items";

/**
 * The phone's layout (below 768px): a bottom bar of apps with More for
 * the rest, the mode's sidebar as a drawer from the left, and each tab a
 * list that pushes its detail full screen. A computer has the rail.
 */

/** Whether a path is one conversation, which takes the whole screen on a phone. */
export function isConversation(pathname: string): boolean {
  return /^\/[^/]+\/-\/chat\/(?!browse\/?$)[^/]+/.test(pathname);
}

/**
 * Follows the visual viewport, which shrinks when the keyboard opens: its
 * height and top go on the page as `--vv-height` and `--vv-top`, what
 * the keyboard covers as `--keyboard-inset`, and
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
      // How much of the bottom the keyboard covers, for a sheet to sit on it.
      root.style.setProperty("--keyboard-inset", `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
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

type Tab = { key: ModeKey; label: string; badge?: { count: number; loud: boolean } };

/**
 * The bottom bar of a phone, flat along the bottom edge under a rule, as
 * the rail stands flat beside the page on a computer: Home, Work, Chat and
 * Notifications (lib/apps.ts `PHONE_TABS`), each with what is unread, and
 * More, whose sheet starts with Code: a phone triages and talks about work
 * far more than it browses code. The tab you are in has the rail's own
 * mark: its icon on the sidebar's accent. It steps aside while the keyboard is up
 * and inside a conversation. The tab you are in, tapped again, opens its
 * mode's menu (its sidebar: Work's saved views, labels and milestones).
 */
export function BottomBar({
  user,
  workspace,
  mode: shellMode,
  pins,
  unread,
  onReselect,
}: {
  user: User;
  workspace: Membership;
  /** The mode the shell is in, when it knows more than the address (`browse`, lib/workspace-nav.ts `shellMode`). */
  mode?: ModeKey;
  /** The apps pinned to this person's rail here, for the More sheet. */
  pins: PinnableApp[];
  unread: { notifications: number; chat: number; mentions: number };
  /** Tapping the tab you are already in: the shell opens that mode's menu (its sidebar). */
  onReselect?: () => void;
}) {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);
  const slug = workspace.slug;
  const mode = shellMode ?? modeOf(pathname, slug);
  const badges: Partial<Record<ModeKey, Tab["badge"]>> = {
    chat: { count: unread.mentions > 0 ? unread.mentions : unread.chat, loud: unread.mentions > 0 },
    notifications: { count: unread.notifications, loud: true },
  };
  const tabs: Tab[] = PHONE_TABS.map((key) => ({ key, label: appOf(key).name, badge: badges[key] }));
  const inTabs = tabs.some((tab) => tab.key === mode);
  if (isConversation(pathname)) return null;
  return (
    <>
      <nav
        aria-label="Apps"
        className="fixed inset-x-0 bottom-0 z-40 h-(--tabbar-h) border-t border-line bg-rail pb-[env(safe-area-inset-bottom)] md:hidden in-data-[keyboard=open]:hidden"
      >
        <ul className="grid h-full" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((tab) => {
            const current = mode === tab.key && !more;
            const count = tab.badge?.count ?? 0;
            const to = modeHome(tab.key, slug);
            return (
              <li key={tab.key} className="min-w-0">
                <Link
                  to={to}
                  prefetch="intent"
                  aria-current={current ? "page" : undefined}
                  aria-label={count > 0 ? `${tab.label}, ${count} unread` : tab.label}
                  onClick={(event) => {
                    // The tab you are in, tapped again: its menu, as a phone's own apps do.
                    // Chat's first page on a phone is its sidebar already.
                    if (!current || !onReselect || (tab.key === "chat" && pathname.replace(/\/$/, "") === to)) return;
                    event.preventDefault();
                    onReselect();
                  }}
                  className={BAR_ITEM}
                >
                  <BarIcon current={current}>
                    {appIcon(tab.key as BuiltinApp, 20)}
                    {tab.badge && <CountBadge count={count} loud={tab.badge.loud} />}
                  </BarIcon>
                  <BarLabel current={current}>{tab.label}</BarLabel>
                </Link>
              </li>
            );
          })}
          <li className="min-w-0">
            <button type="button" aria-expanded={more} aria-haspopup="dialog" onClick={() => setMore(true)} className={BAR_ITEM}>
              <BarIcon current={more || !inTabs}>
                <Ellipsis size={20} />
              </BarIcon>
              <BarLabel current={more || !inTabs}>More</BarLabel>
            </button>
          </li>
        </ul>
      </nav>
      <MoreSheet open={more} onOpenChange={setMore} user={user} workspace={workspace} pins={pins} onExplore={mode === "browse" ? onReselect : undefined} />
    </>
  );
}

const BAR_ITEM = "group relative flex h-full w-full flex-col items-center justify-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset";

/** A tab's icon, marked as the rail marks the app you are in (ui/sidebar.tsx, `size: icon`). */
function BarIcon({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span
      className={`relative flex h-7 w-11 items-center justify-center rounded-[10px] transition-colors group-active:bg-sidebar-accent/60 ${current ? "bg-sidebar-accent text-fg" : "text-muted"}`}
    >
      {children}
    </span>
  );
}

/** A tab's name, centred under its icon; a long one gives way rather than crowding its neighbours. */
function BarLabel({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span className={`block w-full truncate px-0.5 text-center text-[0.6875rem] leading-none font-medium max-[380px]:text-[0.625rem] ${current ? "text-fg" : "text-faint"}`}>
      {children}
    </span>
  );
}

/** A big tile in the More sheet. */
function MoreTile({ to, icon, label, onClick, disabled, note }: { to?: string; icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean; note?: string }) {
  const inner = (
    <>
      <span className={`flex size-11 items-center justify-center rounded-[10px] ${disabled ? "bg-raised/60 text-faint" : "bg-raised text-fg"}`}>{icon}</span>
      <span className={`line-clamp-2 w-full text-xs leading-tight max-[380px]:text-[0.6875rem] ${disabled ? "text-faint" : "text-fg-soft"}`}>{label}</span>
      {note && <span className="-mt-0.5 rounded-full bg-line px-1.5 text-[0.625rem] font-medium text-muted">{note}</span>}
    </>
  );
  const className = "flex min-w-0 flex-col items-center gap-1.5 rounded-md px-1 py-2.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent active:bg-raised/60";
  if (to) {
    return (
      <Link to={to} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-disabled={disabled} className={className}>
      {inner}
    </button>
  );
}

/**
 * More, from the bottom bar: a flat panel standing on it, with g1t's
 * mark at its top and a grid of big tiles: Code (for a member with Code
 * access), all apps, your pinned apps, Artifacts, Routines, People,
 * Workspace, Explore, and "You and
 * help", which opens your account's sheet. Browsing beyond your
 * workspaces, Explore opens Explore's menu (`onExplore`) rather than the
 * page.
 */
function MoreSheet({
  open,
  onOpenChange,
  user,
  workspace,
  pins,
  onExplore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User;
  workspace: Membership;
  pins: PinnableApp[];
  onExplore?: () => void;
}) {
  const slug = workspace.slug;
  const [account, setAccount] = useState(false);
  const shown = pins.map((key) => pinnedApp(key, slug)).filter((app) => app != null);
  const apps = phoneMoreApps(hasCodeAccess(workspace));
  return (
    <>
      <Primitive.Root open={open} onOpenChange={onOpenChange}>
        <Primitive.Portal>
          <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out md:hidden" />
          <Primitive.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="fixed inset-x-0 bottom-(--tabbar-h) z-50 max-h-[calc(100dvh-var(--tabbar-h)-3.5rem)] overflow-y-auto border-t border-line bg-rail px-3 pt-2 pb-3.5 text-fg shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out md:hidden"
          >
            <div aria-hidden="true" className="mx-auto mt-0.5 mb-2 h-1 w-9 rounded-full bg-line-strong" />
            <div className="mb-2 flex items-center gap-2 px-1">
              <Mark tight className="h-4 w-auto" />
              <Primitive.Title className="text-sm font-semibold">More</Primitive.Title>
              <span className="ml-auto truncate font-mono text-xs text-faint">{slug}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {/* Code first, for a member who has it: it left the bar for Work. */}
              {apps.includes("code") && <MoreTile to={appOf("code").path(slug)} icon={appIcon("code", 20)} label="Code" />}
              <MoreTile to={`/${slug}/-/apps`} icon={<LayoutGrid size={20} />} label="All apps" />
              {shown.map((app) => (
                <MoreTile key={app.key} to={app.to} icon={app.icon(26)} label={app.name} />
              ))}
              {apps
                .filter((key) => key !== "code")
                .map((key) => (
                  <MoreTile key={key} to={appOf(key).path(slug)} icon={appIcon(key, 20)} label={appOf(key).name} />
                ))}
              {onExplore ? (
                <MoreTile
                  icon={<Compass size={20} />}
                  label="Explore"
                  onClick={() => {
                    onOpenChange(false);
                    onExplore();
                  }}
                />
              ) : (
                <MoreTile to="/explore" icon={<Compass size={20} />} label="Explore" />
              )}
              <MoreTile
                icon={<Avatar name={user.username} image={user.avatar} size={24} />}
                label="You and help"
                onClick={() => {
                  onOpenChange(false);
                  setAccount(true);
                }}
              />
            </div>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
      <AccountSheet open={account} onOpenChange={setAccount} user={user} />
    </>
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
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] text-fg shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-[sheet-in-bottom_0.24s_cubic-bezier(0.16,1,0.3,1)]"
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
  const className = "flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-[0.9375rem] text-fg-soft transition-colors active:bg-raised";
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

/** Your status, away and pausing notifications, as the account menu has them on a computer. */
function OwnPresenceRows({ onEdit }: { onEdit: () => void }) {
  const me = useOwnPresence();
  const now = Date.now();
  const status = liveStatus(me?.status, now);
  const paused = dndOn(me, now);
  const away = me?.away_manual === true;
  return (
    <>
      <SheetRow icon={status?.emoji ? <span className="text-lg leading-none">{status.emoji}</span> : <Smile />} onClick={onEdit}>
        {status ? status.text || "Status set" : "Set a status"}
      </SheetRow>
      <SheetRow icon={away ? <Sun /> : <Moon />} onClick={() => void setPresence({ away: !away }, { away_manual: !away, presence: away ? "active" : "away" })}>
        {away ? "Set yourself active" : "Set yourself away"}
      </SheetRow>
      {paused ? (
        <SheetRow
          icon={<BellRing />}
          end={me?.dnd_until ? <span className="text-xs text-faint">{untilLabel(me.dnd_until, new Date(now))}</span> : null}
          onClick={() => void setPresence({ dnd_until: null }, { dnd_until: null })}
        >
          Resume notifications
        </SheetRow>
      ) : (
        <SheetRow
          icon={<BellOff />}
          onClick={() => {
            const until = pauseUntil("1h", new Date());
            void setPresence({ dnd_until: until }, { dnd_until: until });
          }}
        >
          Pause notifications for 1 hour
        </SheetRow>
      )}
    </>
  );
}

/**
 * You and help, on a phone: your status, your profile and settings, the
 * documentation, support, status and the keyboard's shortcuts, and signing
 * out, as the account menu has them on a computer.
 */
export function AccountSheet({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: User }) {
  const submit = useSubmit();
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState(false);
  return (
    <>
      <BottomSheet open={open} onOpenChange={onOpenChange} title="You and help">
        <div className="flex items-center gap-3 px-3 pt-1 pb-3">
          <Avatar name={user.username} image={user.avatar} size={44} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">@{shownUsername(user)}</p>
          </div>
        </div>
        <SheetGroup title="You">
          <OwnPresenceRows
            onEdit={() => {
              onOpenChange(false);
              setEditing(true);
            }}
          />
          <SheetRow to={`/u/${user.username}`} icon={<CircleUserRound />}>
            Your profile
          </SheetRow>
          <SheetRow to="/settings" icon={<Settings />}>
            Your settings
          </SheetRow>
        </SheetGroup>
        <SheetGroup title="Appearance">
          <ThemeSwitch size="large" className="mx-3 mt-1 mb-1.5" />
        </SheetGroup>
        <SheetGroup title="Help">
          <SheetRow href="https://docs.g1t.sh/" icon={<BookOpen />}>
            Documentation
          </SheetRow>
          <SheetRow to="/support" icon={<LifeBuoy />}>
            Support
          </SheetRow>
          <SheetRow href={STATUS_URL} icon={<Activity />}>
            Status
          </SheetRow>
          <SheetRow
            icon={<Keyboard />}
            onClick={() => {
              onOpenChange(false);
              setKeys(true);
            }}
          >
            Keyboard shortcuts
          </SheetRow>
        </SheetGroup>
        <SheetGroup title="Account">
          <SheetRow icon={<LogOut />} onClick={() => submit(null, { method: "post", action: "/logout" })}>
            Sign out
          </SheetRow>
        </SheetGroup>
      </BottomSheet>
      <StatusDialog open={editing} onOpenChange={setEditing} />
      <ShortcutsDialog open={keys} onOpenChange={setKeys} />
    </>
  );
}

/** Which project page a roadmap page (`soon/<key>`) sits under, by its section. */
const SOON_UNDER: Partial<Record<RoadmapItem["section"], ProjectPage>> = {
  Code: "code",
  Deployments: "deployments",
  Observability: "observability",
  Security: "security",
  Insights: "insights",
};
// Read from the roadmap on first use, not as the module loads: a bundle can
// load this before the roadmap's chunk (lib/project-nav.ts says more).
let soonPages: Record<string, ProjectPage> | null = null;
const soonPagesOf = (): Record<string, ProjectPage> =>
  (soonPages ??= Object.fromEntries(
    ROADMAP.flatMap((item) => (SOON_UNDER[item.section] ? [[item.key, SOON_UNDER[item.section]!] as const] : [])),
  ));

/**
 * A project's pages along the bottom of its header: the sidebar's own list
 * (lib/chrome.ts) as a row of tabs that scrolls sideways on a phone, the
 * current one underlined on the header's border and kept in view, so Work
 * and Pull requests are one tap away. Work is the workspace's Work list
 * filtered to the project (lib/work-items.ts `repoWorkPath`). From 768px a member's sidebar has
 * them; a visitor, who has none, always sees the row.
 */
export function ProjectStrip({
  base,
  member,
  can,
  settings,
  counts,
  always = false,
}: {
  /** `/<namespace>/<name>`. */
  base: string;
  member: boolean;
  can?: Partial<Abilities>;
  /** Whether they see its settings (lib/access.ts `seesSettings`), as the sidebar decides. */
  settings?: boolean;
  counts?: { items: number; pulls: number };
  /** On a computer too: for a visitor, who has no sidebar to list them. */
  always?: boolean;
}) {
  const { pathname } = useLocation();
  const rest = pathname.toLowerCase().startsWith(base.toLowerCase()) ? pathname.slice(base.length) : "";
  const at = projectPageAt(rest, soonPagesOf());
  const pages: (ProjectPage | "overview")[] = ["overview", ...projectPages(member, can).filter((page) => page !== "observability" && page !== "settings"),
    ...(settings ?? member ? (["settings"] as const) : []),
  ];
  return (
    <NavTabs label="Project" className={always ? undefined : "md:hidden"}>
      {pages.map((page) => {
        const link = page === "overview" ? { label: "Overview", path: "" } : PROJECT_PAGE_LINKS[page];
        const [namespace = "", name = ""] = base.split("/").filter(Boolean);
        const to = page === "work" ? repoWorkPath(namespace, name) : link.path ? `${base}/${link.path}` : base;
        return (
          <NavTab
            key={page}
            to={to}
            current={at === page}
            soon={page !== "overview" && PROJECT_PAGE_LINKS[page].soon}
            count={page === "work" ? counts?.items : page === "pulls" ? counts?.pulls : undefined}
          >
            {link.label}
          </NavTab>
        );
      })}
    </NavTabs>
  );
}
