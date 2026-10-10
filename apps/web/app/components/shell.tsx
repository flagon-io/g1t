import { Activity, BarChart3, Building2, MessagesSquare, Bell, BookMarked, BookOpen, Bookmark, Blocks, Bot, Box, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, GripVertical, CircleUserRound, Code2, Coins, Compass, CreditCard, Fingerprint, GanttChart, Gauge, GitBranch, GitPullRequest, Globe, History, KanbanSquare, Keyboard, KeyRound, Layers, LayoutDashboard, LayoutGrid, LifeBuoy, ListTree, Lock, LogOut, Mail, Network, Package, PanelLeft, PlayCircle, Plug, Plus, Rocket, Search, ServerCog, Settings, Shapes, ShieldCheck, Scale, Smile, Sparkles, Store, Sun, Ticket, TrendingUp, UserPlus, UserRoundKey, Users, UsersRound, Webhook, X, ArrowLeftRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useFetcher, useLocation, useNavigation, useRouteLoaderData, useSubmit } from "react-router";

import { type Abilities, type ChatSidebarEntry, type InboxCounts, type WorkspaceAgent, type Membership, type Spike, type User, hasCodeAccess, mayCreateTeams, shownUsername } from "@g1t/contracts";

import { InMain } from "./landmark";
import { CommandPalette, type PaletteCommand, PaletteKey, usePaletteShortcut } from "./command-palette";
import { NotificationsBell } from "./inbox";
import { SpendPill } from "./spend";
import { PinButton } from "./pin-button";
import { Hint } from "./ui/hint";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { StatusDot, useSiteStatus } from "./footer";
import { Logo } from "./logo";
import { Avatar, SoonPill } from "./ui";
import { Skeleton } from "./ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { type RoadmapItem, roadmapIn, roadmapItem } from "../lib/roadmap";
import { type ModeKey, SETTINGS_PAGES, modeOf, todayPath } from "../lib/workspace-nav";
import { AgentsSidebar } from "./agents-mode";
import { ChatSidebar } from "./chat/sidebar";
import { FoliosSidebar } from "./folios/sidebar";
import { Dock, ShortcutsDialog, WorkspaceSwitcher, sidebarKeyLabel } from "./dock";
import { G1tMark } from "./orchestrator";
import { BottomBar, isConversation, useVisualViewport } from "./mobile";
import { useChatSidebar } from "./chat/actions";
import { unreadTotals } from "../lib/chat";
import { SETTINGS_CAPABILITY, type ViewerAccess, seesSettings } from "../lib/access";
import { projectPages } from "../lib/chrome";
import { ACCOUNT_SETTINGS, type AccountSettingsPage, FIRST_SETTINGS_PAGE, accountSettingsPage } from "../lib/account-settings";
import { type PinnableApp, sidebarCookie } from "../lib/apps";
import { REASON_FILTERS, inboxReason, inboxView } from "../lib/inbox";
import { GithubMark } from "./github";
import { useInviteOnly } from "../lib/registration";
import { STATUS_URL, statusTitle } from "../lib/status";
import { type ShortcutProject, movedPin, recentWith } from "../lib/pins";
import type { AccountMenuData } from "../routes/settings-menu-json";
import { useLiveBadges } from "../lib/notify-client";
import { OwnPresenceDot, OwnPresenceItems, StatusDialog } from "./presence";
import { THEME_COMMANDS, ThemeMenuSwitch } from "./theme-switch";

/**
 * What the sidebar needs, worked out by the root loader. For a visitor who
 * is not signed in there is no workspace, no projects and no usage: only
 * the project being looked at, if they can see it.
 */
export type ShellData = {
  /** The workspace the sidebar is about: the one being looked at, or their first. */
  workspace: Membership | null;
  /** All its projects, by name, for the palette: `name` is the slug in their address. */
  repos: ShortcutProject[];
  /** The person's pinned projects in it, in their order (lib/pins.ts). */
  pinned?: ShortcutProject[];
  /** What they opened there last, latest first, leaving out the pinned. */
  recent?: ShortcutProject[];
  /** Repositories shared with them in workspaces they do not belong to. */
  shared?: { namespace: string; name: string; isPrivate: boolean }[];
  /** The project being looked at, if any, whoever owns it. */
  repo: {
    namespace: string;
    name: string;
    member: boolean;
    issues: number;
    pulls: number;
  } | null;
  /** Where the workspace stands against its usage limit, if billing is on. */
  limit: {
    exposureMicros: number;
    ceilingMicros: number | null;
    state: "ok" | "warning" | "stopped";
    comped: boolean;
  } | null;
  /** Whether g1t charges nothing for now, while it is being built out. */
  free?: boolean;
  /** What its agents have cost since the start of the month. */
  /** This month's usage: charged, or at cost while g1t is free. */
  monthUsageMicros: number | null;
  /** Whether new compute is paused (a spend spike or a hold), and whether the viewer can answer it. */
  compute?: { paused: string | null; spike: Spike | null; owner: boolean } | null;
  /** What is unread in their notifications, for the dock and the bell. Absent for a visitor. */
  inbox?: InboxCounts | null;
  /**
   * Chat, for the dock's badge: what is unread, and the
   * starred and latest conversations. Null when chat did not answer in time.
   */
  chat?: { unread: number; mentions: number; starred?: ChatSidebarEntry[]; recent?: ChatSidebarEntry[] } | null;
  /** The workspace's agents, g1t first, for the Agents sidebar; null when not known. */
  agents?: ShellAgent[] | null;
  /** The apps this person pinned to their dock in the workspace (lib/apps.ts). */
  pins?: PinnableApp[];
};

/** An agent as the shell lists it. */
export type ShellAgent = Pick<
  WorkspaceAgent,
  "id" | "handle" | "display_name" | "avatar" | "avatar_seed" | "role" | "status" | "title" | "team" | "department" | "builtin"
>;

function SidebarLink({
  to,
  icon,
  end,
  count,
  also,
  drill,
  current: lit,
  children,
}: {
  to: string;
  icon: ReactNode;
  end?: boolean;
  count?: number;
  /** Other path prefixes under which this link is the current one. */
  also?: string | string[];
  /** It opens a list of its own: a chevron says so, always or on hover. */
  drill?: boolean | "hover";
  /** Whether it is the current row, when the list works that out itself. */
  current?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  // NavLink's own pending state compares paths only, so a list whose rows
  // differ by query (Notifications' views and reasons) would light every
  // row while one loads. Where the list says which row is current, a row
  // is pending only when the page on its way is that row's, query and all.
  const loading = navigation.location;
  const pendingHere = loading != null && `${loading.pathname}${loading.search}` === to;
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive, isPending }) => {
        const current =
          lit ??
          (isActive || [also ?? []].flat().some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/")));
        const pending = lit === undefined ? isPending : pendingHere;
        return `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current
            ? "bg-raised font-medium text-fg"
            : pending
              ? "bg-raised/60 text-fg"
              : "text-muted hover:bg-raised/60 hover:text-fg"
        }`;
      }}
    >
      <span className="shrink-0 text-faint group-hover:text-muted">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      {count != null && count > 0 && (
        <span className="rounded bg-line px-1.5 text-[0.6875rem] tabular-nums text-muted">
          {count}
        </span>
      )}
      {drill && (
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`-mr-0.5 shrink-0 text-faint transition-opacity ${drill === "hover" ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : ""}`}
        />
      )}
    </NavLink>
  );
}

/**
 * Something a project will have, shown where it will live so people can
 * see where g1t is going. Not a link: nothing is behind it yet.
 */
function SidebarSoon({ icon, children, about }: { icon: ReactNode; children: ReactNode; about: string }) {
  return (
    <Hint label={about} side="right">
      <div aria-disabled="true" className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[0.8125rem] text-faint">
        <span className="shrink-0 opacity-70">{icon}</span>
        <span className="grow truncate">{children}</span>
        <span className="sr-only">{about}</span>
        <SoonPill />
      </div>
    </Hint>
  );
}

/**
 * A page that is coming, as a link to its roadmap page: faint, with Soon,
 * and marked current on any of its section's Soon pages.
 */
function SidebarSoonLink({
  to,
  also,
  icon,
  about,
  current: lit,
  children,
}: {
  to: string;
  also?: string[];
  icon: ReactNode;
  about: string;
  /** Whether it is the current row, when the list works that out itself. */
  current?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    // The hint wraps a plain box: Radix's asChild merges className as a
    // string, which would break NavLink's className function.
    <Hint label={about} side="right">
    <div>
    <NavLink
      to={to}
      prefetch="intent"
      className={({ isActive }) => {
        const current = lit ?? (isActive || (also ?? []).some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/")));
        return `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current ? "bg-raised font-medium text-fg" : "text-faint hover:bg-raised/60 hover:text-muted"
        }`;
      }}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      <SoonPill />
    </NavLink>
    </div>
    </Hint>
  );
}

/** Icons for what spans projects. */
const WORKSPACE_ICONS: Record<string, ReactNode> = {
  board: <KanbanSquare size={15} />,
  roadmap: <GanttChart size={15} />,
  teams: <UsersRound size={15} />,
  packages: <Package size={15} />,
  fleet: <Bot size={15} />,
};

/** The Soon pages of a section, as paths, so its link is current on them. */
function soonPaths(base: string, section: RoadmapItem["section"]): string[] {
  return roadmapIn(section).map((item) => `${base}/soon/${item.key}`);
}

function SidebarGroup({
  title,
  action,
  className = "",
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <h2 className="text-xs font-medium text-faint">{title}</h2>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

/** What a workspace is called where people read it: its display name, else its slug. */
function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/**
 * The fine print, as one quiet row at the foot of the account menu and the
 * visitor's panel: each link a full-height target, left-aligned. In the
 * menu each is a menu item, so the arrow keys reach it.
 */
const LEGAL_LINKS: [string, string][] = [
  ["Policies", "/policies"],
  ["Privacy", "/policies/privacy"],
  ["Security", "/security"],
];
const LEGAL_LINK = "flex h-7 items-center rounded px-1.5 text-xs text-faint outline-none transition-colors";

function MenuLegalRow() {
  return (
    <div role="group" aria-label="Legal" className="flex items-center gap-0.5 px-0.5 pt-0.5">
      {LEGAL_LINKS.map(([label, to], index) => (
        <span key={to} className="flex items-center gap-0.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-[0.625rem] text-line-strong">
              ·
            </span>
          )}
          <DropdownMenuItem asChild className={`${LEGAL_LINK} py-0 data-highlighted:bg-line data-highlighted:text-fg`}>
            <Link to={to}>{label}</Link>
          </DropdownMenuItem>
        </span>
      ))}
    </div>
  );
}

/** Status's row: the live dot and two or three words, fetched when the menu opens. */
function StatusSummary({ open }: { open: boolean }) {
  const status = useSiteStatus(open);
  const words = statusTitle(status);
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-xs text-faint">
      {/* The words say it; the dot's own words for screen readers would repeat them. */}
      <span aria-hidden="true" className="flex">
        <StatusDot state={status?.overall.state ?? null} />
      </span>
      {words ? <span className="truncate">{words}</span> : <Skeleton className="h-3 w-20" />}
    </span>
  );
}

/** A menu row: an icon, words, and whatever sits at its end. */
const MENU_ROW = "h-9 gap-2.5 px-2.5 text-[0.8125rem]";

/**
 * Your account, at the foot of the dock (or in the header, before you have
 * a workspace): who you are and your status, your profile and settings,
 * and help: the documentation, support, status and the keyboard's
 * shortcuts; then signing out and the fine print.
 */
function AccountMenu({ user, side = "right" }: { user: User; side?: "right" | "bottom" }) {
  const submit = useSubmit();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(false);
  // Your status's dialog: outside the menu, so the menu closes behind it.
  const [editing, setEditing] = useState(false);
  // Name, primary address and invites left: asked for once, as soon as the
  // pointer or focus reaches the button, so they are there when it opens.
  const details = useFetcher<AccountMenuData | null>({ key: "account-menu" });
  const prefetch = () => {
    if (details.state === "idle" && details.data === undefined) details.load("/settings/menu.json");
  };
  useEffect(() => {
    if (open) prefetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const me = details.data ?? null;
  // Still on its way: shapes where the words will be, the same size.
  const loading = details.data === undefined && details.state !== "idle";
  // While anyone can sign up, listed once the data says there are invites to look back on.
  const invitesListed = useInviteOnly() || me?.invites_page === true;
  const profile = `/u/${user.username}`;
  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* The avatar alone, with a dot that says how others see you (components/presence.tsx). */}
      <DropdownMenuTrigger
        aria-label={`Account menu for ${shownUsername(user)}`}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        className="relative flex rounded-full outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-line-strong"
      >
        <Avatar name={user.username} image={user.avatar} size={side === "right" ? 32 : 28} />
        <OwnPresenceDot ring={side === "right" ? "var(--color-dock)" : "var(--color-bg)"} className="absolute -right-0.5 -bottom-0.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} sideOffset={side === "right" ? 14 : 6} collisionPadding={8} className="w-[17.5rem] p-1.5">
        {/* Who is signed in, and a way to their profile. */}
        <DropdownMenuItem asChild className="gap-3 px-2 py-2">
          <Link to={profile} aria-label={`${me?.name ?? shownUsername(user)} (@${shownUsername(user)}), your profile`}>
            <Avatar name={user.username} image={user.avatar} size={36} />
            <span className="flex min-w-0 grow flex-col leading-tight" aria-busy={loading}>
              {loading ? (
                <Skeleton className="my-[0.1875rem] h-3.5 w-28" />
              ) : (
                <span className="truncate text-sm font-medium text-fg">{me?.name ?? shownUsername(user)}</span>
              )}
              <span className="truncate font-mono text-xs text-muted">@{shownUsername(user)}</span>
              {loading ? (
                <Skeleton className="mt-1 h-3 w-40" />
              ) : (
                me?.email && <span className="mt-0.5 truncate text-xs text-faint">{me.email}</span>
              )}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        {/* Your status, away, and pausing notifications. */}
        <DropdownMenuGroup>
          <OwnPresenceItems className="min-h-9 py-1.5 text-[0.8125rem]" onEdit={() => setEditing(true)} />
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild className={MENU_ROW}>
            <Link to={profile}>
              <CircleUserRound />
              Your profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={MENU_ROW}>
            <Link to={FIRST_SETTINGS_PAGE}>
              <Settings />
              Your settings
            </Link>
          </DropdownMenuItem>
          {invitesListed && (
          <DropdownMenuItem asChild className={MENU_ROW}>
            <Link to="/settings/invites">
              <Ticket />
              {ACCOUNT_SETTINGS.invites.title}
              {loading && <Skeleton className="ml-auto h-4 w-12 rounded-full" />}
              {me?.invites_left != null && (
                <span className="ml-auto rounded-full bg-line px-1.5 text-[0.6875rem] tabular-nums text-muted">
                  {me.invites_left} left
                </span>
              )}
            </Link>
          </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="my-1.5" />
        {/* Auto, Light or Dark, switched in place (lib/theme.ts). */}
        <ThemeMenuSwitch />
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild className={MENU_ROW}>
            <a href="https://docs.g1t.sh/">
              <BookOpen />
              Documentation
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={MENU_ROW}>
            <Link to="/support">
              <LifeBuoy />
              Support
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={MENU_ROW}>
            <a href={STATUS_URL}>
              <Activity />
              Status
              <StatusSummary open={open} />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ROW} onSelect={() => setKeys(true)}>
            <Keyboard />
            Keyboard shortcuts
            <PaletteKey className="ml-auto font-sans text-xs text-faint" />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="my-1.5" />
        {/* Submitted from here: the menu closes on select, and a button
            that has left the page cannot submit a form. */}
        <DropdownMenuItem className={MENU_ROW} onSelect={() => submit(null, { method: "post", action: "/logout" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <MenuLegalRow />
      </DropdownMenuContent>
    </DropdownMenu>
    <StatusDialog open={editing} onOpenChange={setEditing} />
    <ShortcutsDialog open={keys} onOpenChange={setKeys} />
    </>
  );
}

/**
 * A workspace's settings pages, which the sidebar drills into: how it is
 * set up and connected (guardrails, secrets, integrations,
 * webhooks), what it pays, its repositories, tokens and record. The main
 * list keeps the places work happens and who belongs; every member can
 * still open these.
 */
const SETTINGS_PAGE =
  new RegExp(`^/([^/]+)/-/(${SETTINGS_PAGES.join("|")})(/|$)`);
/** A project's settings pages, which the project's menu drills into. */
const REPO_SETTINGS_PAGE = /^\/([^/]+)\/([^/-][^/]*)\/settings(\/|$)/;

/**
 * The sidebar's lists are a stack, the way a phone pushes a screen: one
 * drilled into slides in from the right over the full width, while the one
 * it covers drifts a quarter of the way left and fades, both on one long
 * ease-out, the fade quicker than the move so the two never blur together.
 * Going back reverses it.
 */
const LAYER =
  "absolute inset-0 [transition:translate_380ms_cubic-bezier(0.32,0.72,0,1),opacity_220ms_ease-out] will-change-[translate,opacity] motion-reduce:transition-none";
/** One list, filling its layer. */
const PANEL = "h-full overflow-y-auto px-2 pb-4";

/** One list in the stack: what it is, and its rows. */
type Level = { key: string; node: ReactNode };

/** True once the page has hydrated, so what the server drew never animates in. */
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * Drilling in and out of the sidebar's lists. `trail` is the way from the
 * main list to the one shown, worked out from the address, so a link
 * straight to a settings page opens the sidebar already drilled in, and
 * leaving it comes back out. Lists deeper than the one shown stay in
 * place, off to the right, so going back slides them away rather than
 * dropping them. Moving to a list at the same depth (a workspace's settings
 * to a project) fades the new one in where it is.
 */
function Drill({ trail }: { trail: Level[] }) {
  const depth = trail.length - 1;
  const hydrated = useHydrated();
  const stack = useRef<Level[]>(trail);
  const before = stack.current;
  const within = trail.every((level, index) => before[index]?.key === level.key);
  stack.current = within ? [...trail, ...before.slice(trail.length)] : trail;
  const levels = stack.current;
  // What was showing last time, to tell drilling in from moving across.
  const shown = useRef({ depth, keys: levels.map((level) => level.key) });
  useEffect(() => {
    shown.current = { depth, keys: levels.map((level) => level.key) };
  });
  return (
    <div className="relative min-h-0 grow overflow-hidden">
      {levels.map((level, index) => {
        const current = index === depth;
        const place =
          index < depth
            ? "pointer-events-none -translate-x-1/4 opacity-0"
            : current
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-full opacity-0";
        // A list that was not there before arrives: from the right when
        // drilling in, in place when moving across.
        const arriving = hydrated && current && !shown.current.keys.includes(level.key);
        const enter = arriving
          ? depth > shown.current.depth
            ? "starting:translate-x-full starting:opacity-0"
            : "starting:opacity-0"
          : "";
        return (
          <div key={level.key} className={`${LAYER} ${place} ${enter}`} inert={!current} aria-hidden={!current || undefined}>
            {level.node}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The row at the top of a list drilled into: the list's name, which goes
 * back out, and what it belongs to, faint at the end.
 */
function BackRow({ to, label, context }: { to: string; label: ReactNode; context?: ReactNode }) {
  return (
    <Link
      to={to}
      prefetch="intent"
      className="group mt-3 flex h-8 items-center gap-1.5 rounded-md pr-2 pl-1 text-[0.8125rem] font-medium text-fg transition-colors hover:bg-raised/60"
    >
      <ChevronLeft size={16} className="shrink-0 text-faint transition-transform group-hover:-translate-x-0.5 group-hover:text-muted" />
      <span className="min-w-0 shrink-0 truncate">{label}</span>
      {context && (
        <span className="ml-auto min-w-0 truncate pl-2 font-mono text-[0.6875rem] font-normal text-faint">{context}</span>
      )}
    </Link>
  );
}

/** A thin rule between groups of a list. */
function Rule() {
  return <div role="separator" className="mx-2 my-2.5 h-px bg-line" />;
}

/** A quiet heading inside a group: Pinned, Recent. */
function SidebarSubhead({ children }: { children: ReactNode }) {
  return <h3 className="px-2 pt-1.5 pb-0.5 text-[0.6875rem] font-medium tracking-wide text-faint">{children}</h3>;
}

/**
 * The workspace's projects as the sidebar keeps them, however many there
 * are: the person's pins in their order, what they opened last, and the
 * way to all of them. Pins move by dragging, or with Alt and the arrow
 * keys; the projects service keeps the order.
 */
function SidebarProjects({ slug, shell, current }: { slug: string; shell: ShellData; current: boolean }) {
  const reorder = useFetcher({ key: `pins:${slug}` });
  const saved = shell.pinned ?? [];
  // While a new order is on its way, it shows as made.
  const asked = reorder.formData?.get("intent") === "reorder" ? reorder.formData.getAll("slug").map(String) : null;
  const pinned = asked
    ? asked.map((name) => saved.find((project) => project.name === name)).filter((project): project is ShortcutProject => project != null)
    : saved;
  const active = shell.repo ? { namespace: shell.repo.namespace, name: shell.repo.name, isPrivate: false } : null;
  const recent = recentWith(shell.recent ?? [], pinned, active, slug);
  const [dragging, setDragging] = useState<number | null>(null);
  const move = (from: number, by: number) => {
    const next = movedPin(pinned, from, by);
    if (!next) return;
    const form = new FormData();
    form.set("intent", "reorder");
    for (const project of next) form.append("slug", project.name);
    reorder.submit(form, { method: "post", action: `/${slug}/-/pins` });
  };
  // Each row pins or unpins in place: the pin shows on hover or focus, and
  // stays shown on a pinned row's hover so it reads as "unpin".
  const row = (project: ShortcutProject, isPinned: boolean) => (
    <div className="group/row relative">
      <SidebarLink to={`/${project.namespace}/${project.name}`} icon={project.isPrivate ? <Lock size={15} /> : <Box size={15} />} drill="hover">
        <span className="block truncate pr-6">{project.title ?? project.name}</span>
      </SidebarLink>
      <PinButton
        workspace={slug}
        slug={project.name}
        name={project.title ?? project.name}
        pinned={isPinned}
        small
        className="absolute top-1/2 right-6 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      />
    </div>
  );
  return (
    <SidebarGroup
      title="Projects"
      action={
        <Link to="/new" aria-label="New project" className="rounded p-0.5 text-faint hover:bg-raised hover:text-fg">
          <Plus size={13} />
        </Link>
      }
    >
      {/* Only there once something is pinned: each row below has its own pin. */}
      {pinned.length > 0 && (
        <>
        <SidebarSubhead>Pinned</SidebarSubhead>
        <ul aria-label="Pinned projects" className="space-y-px">
          {pinned.map((project, index) => (
            <li
              key={project.name}
              draggable={pinned.length > 1}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (dragging != null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging != null && dragging !== index) move(dragging, index - dragging);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                move(index, event.key === "ArrowUp" ? -1 : 1);
              }}
              className={`group/pin relative ${dragging === index ? "opacity-50" : ""}`}
            >
              {row(project, true)}
              {pinned.length > 1 && (
                <Hint label="Drag, or Alt and an arrow key, to reorder" side="right">
                  <span className="absolute top-1/2 -left-1.5 -translate-y-1/2 cursor-grab text-faint opacity-0 transition-opacity group-hover/pin:opacity-100">
                    <GripVertical size={12} aria-hidden="true" />
                  </span>
                </Hint>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
      {recent.length > 0 && (
        <>
          <SidebarSubhead>Recent</SidebarSubhead>
          {recent.map((project) => (
            <div key={`${project.namespace}/${project.name}`}>{row(project, false)}</div>
          ))}
        </>
      )}
      <div className="pt-1">
        <SidebarLink to={`/${slug}/-/projects`} icon={<LayoutGrid size={15} />} count={shell.repos.length} current={current}>
          All projects
        </SidebarLink>
      </div>
    </SidebarGroup>
  );
}

/** Insights, coming: the workspace's own page says what it will be. */
const INSIGHTS = roadmapItem("insights");

/**
 * What the repository menu needs. Known from the address before the page's
 * data arrives, so the menu is right from the first frame; the counts fill
 * in once it does.
 */
type MenuRepo = {
  namespace: string;
  name: string;
  member: boolean;
  /** Whether they see its settings; from the repository's page once it loads. */
  settings?: boolean;
  /** What they may do there, once the repository's page loads. */
  can?: Abilities;
  issues?: number;
  pulls?: number;
};

function sameRepo(a: { namespace: string; name: string } | null, b: { namespace: string; name: string } | null) {
  return (
    a != null &&
    b != null &&
    a.namespace.toLowerCase() === b.namespace.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

/**
 * A project's own list, drilled into while you are in it: everything about
 * the project, running and its code, and nothing else, with the way back
 * out to all of them.
 */
function RepoMenu({
  repo,
  isPrivate,
  back,
}: {
  repo: MenuRepo;
  isPrivate: boolean;
  /** Where the way back leads: the workspace's projects, mission control, or Explore. */
  back: { to: string; label: string };
}) {
  const base = `/${repo.namespace}/${repo.name}`;
  // What a member sees, and what everyone who can see the project does.
  const shows = new Set(projectPages(repo.member, repo.can));
  return (
    <nav aria-label={`${repo.namespace}/${repo.name}`} className={PANEL}>
      <BackRow to={back.to} label={back.label} />
      <Hint label="Overview" side="right">
      <div>
      <NavLink
        to={base}
        end
        prefetch="intent"
        className={({ isActive }) =>
          `mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${isActive ? "bg-raised" : "hover:bg-raised/60"}`
        }
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
          {isPrivate ? <Lock size={13} /> : <Box size={13} />}
        </span>
        <span className="min-w-0 truncate font-mono text-[0.8125rem]">
          <span className="text-faint">{repo.namespace}/</span>
          <span className="font-semibold text-fg">{repo.name}</span>
        </span>
      </NavLink>
      </div>
      </Hint>
      {/* A project's pages, in the order people use them. A page with more
          than one view shows them as tabs across its top. */}
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`${base}/code`} also={[`${base}/tree`, `${base}/blob`, `${base}/commits`, `${base}/commit`, `${base}/branches`, `${base}/tags`, `${base}/compare`, ...soonPaths(base, "Code")]} icon={<Code2 size={15} />}>
          Code
        </SidebarLink>
        <SidebarLink to={`${base}/issues`} also={[`${base}/plans`, `${base}/milestones`, `${base}/labels`, ...soonPaths(base, "Issues")]} icon={<CircleDot size={15} />} count={repo.issues}>
          Issues
        </SidebarLink>
        <SidebarLink to={`${base}/pulls`} also={[`${base}/pull`, `${base}/queue`]} icon={<GitPullRequest size={15} />} count={repo.pulls}>
          Pull requests
        </SidebarLink>
        <SidebarLink to={`${base}/agents`} also={[`${base}/sessions`, `${base}/memory`, ...soonPaths(base, "Agents")]} icon={<Bot size={15} />}>
          Agents
        </SidebarLink>
        <SidebarLink to={`${base}/actions`} icon={<PlayCircle size={15} />}>
          Workflows
        </SidebarLink>
      </div>
      <Rule />
      <div className="space-y-px">
        {shows.has("deployments") ? (
          <SidebarLink to={`${base}/deployments`} also={soonPaths(base, "Deployments")} icon={<Rocket size={15} />}>
            Deployments
          </SidebarLink>
        ) : null}
        <SidebarSoonLink to={`${base}/soon/logs`} also={soonPaths(base, "Observability")} icon={<Activity size={15} />} about="Logs, errors, uptime and analytics of the project's deployed apps.">
          Observability
        </SidebarSoonLink>
        {shows.has("security") ? (
          <SidebarLink to={`${base}/security`} also={soonPaths(base, "Security")} icon={<ShieldCheck size={15} />}>
            Security
          </SidebarLink>
        ) : null}
        <SidebarLink
          to={`${base}/contributors`}
          also={[`${base}/activity`, `${base}/stargazers`, ...soonPaths(base, "Insights")]}
          icon={<BarChart3 size={15} />}
        >
          Insights
        </SidebarLink>
      </div>
      {(repo.settings ?? shows.has("settings")) && (
        <>
          <Rule />
          <SidebarLink to={`${base}/settings`} icon={<Settings size={15} />} drill>
            Settings
          </SidebarLink>
        </>
      )}
    </nav>
  );
}

/**
 * A project's settings, drilled into from its list: what is about running
 * it, then its agents, then its code and who can reach it. The way back
 * leads to the project.
 */
function RepoSettingsMenu({ repo }: { repo: MenuRepo }) {
  const base = `/${repo.namespace}/${repo.name}`;
  // Each page shows to the roles that can use it, once the role is known.
  const shows = (page: string) => !repo.can || repo.can[SETTINGS_CAPABILITY[page] ?? "administer"];
  const running = shows("deployments");
  const agents = shows("agents") || shows("guardrails");
  return (
    <nav aria-label={`${repo.namespace}/${repo.name} settings`} className={PANEL}>
      <BackRow to={base} label="Settings" context={`${repo.namespace}/${repo.name}`} />
      {shows("") && (
        <div className="mt-2 space-y-px">
          <SidebarLink to={`${base}/settings`} end icon={<Settings size={15} />}>
            General
          </SidebarLink>
        </div>
      )}
      {running && (
        <>
          {shows("") && <Rule />}
          <div className={shows("") ? "space-y-px" : "mt-2 space-y-px"}>
            <SidebarLink to={`${base}/settings/deployments`} icon={<Rocket size={15} />}>
              Deployments
            </SidebarLink>
            <SidebarLink to={`${base}/settings/domains`} icon={<Globe size={15} />}>
              Domains
            </SidebarLink>
          </div>
        </>
      )}
      {agents && (
        <>
          <Rule />
          <div className="space-y-px">
            {shows("agents") && (
              <SidebarLink to={`${base}/settings/agents`} icon={<Bot size={15} />}>
                Agents
              </SidebarLink>
            )}
            {shows("guardrails") && (
              <SidebarLink to={`${base}/settings/guardrails`} icon={<ShieldCheck size={15} />}>
                Guardrails
              </SidebarLink>
            )}
          </div>
        </>
      )}
      <Rule />
      <div className="space-y-px">
        {shows("repository") && (
          <SidebarLink to={`${base}/settings/repository`} icon={<BookMarked size={15} />}>
            Repository
          </SidebarLink>
        )}
        {shows("mirroring") && (
          <SidebarLink to={`${base}/settings/mirroring`} icon={<ArrowLeftRight size={15} />}>
            Mirroring
          </SidebarLink>
        )}
        {shows("access") && (
          <SidebarLink to={`${base}/settings/access`} icon={<Users size={15} />}>
            Access
          </SidebarLink>
        )}
        {shows("keys") && (
          <SidebarLink to={`${base}/settings/keys`} icon={<KeyRound size={15} />}>
            Deploy keys
          </SidebarLink>
        )}
        {shows("branches") && (
          <SidebarLink to={`${base}/settings/branches`} icon={<GitBranch size={15} />}>
            Branches and merging
          </SidebarLink>
        )}
        {shows("rules") && (
          <SidebarLink to={`${base}/settings/rules`} icon={<Scale size={15} />}>
            Rules
          </SidebarLink>
        )}
        {shows("secrets") && (
          <SidebarLink to={`${base}/settings/secrets`} icon={<Lock size={15} />}>
            Secrets and variables
          </SidebarLink>
        )}
        {shows("actions") && (
          <SidebarLink to={`${base}/settings/actions`} icon={<PlayCircle size={15} />}>
            Actions
          </SidebarLink>
        )}
        {shows("environments") && (
          <SidebarLink to={`${base}/settings/environments`} icon={<Layers size={15} />}>
            Environments
          </SidebarLink>
        )}
        {shows("runners") && (
          <SidebarLink to={`${base}/settings/runners`} icon={<ServerCog size={15} />}>
            Runners
          </SidebarLink>
        )}
        {shows("webhooks") && (
          <SidebarLink to={`${base}/settings/webhooks`} icon={<Webhook size={15} />}>
            Webhooks
          </SidebarLink>
        )}
      </div>
    </nav>
  );
}

/**
 * Whether the menus list Settings → Invites (invites to g1t): always while
 * sign-up takes an invite; once anyone can sign up, only for someone with
 * invites already made to look back on, which the account menu's data says.
 */
function useInvitesListed(): boolean {
  const inviteOnly = useInviteOnly();
  const details = useFetcher<AccountMenuData | null>({ key: "account-menu" });
  useEffect(() => {
    if (!inviteOnly && details.state === "idle" && details.data === undefined) details.load("/settings/menu.json");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteOnly]);
  return inviteOnly || details.data?.invites_page === true;
}

/** Your own settings, drilled into from Your settings: one page each. */
function AccountSettingsMenu({ username }: { username: string }) {
  const invites = useInvitesListed();
  const link = (page: AccountSettingsPage, icon: ReactNode) => (
    <SidebarLink to={`/settings/${page}`} icon={icon}>
      {ACCOUNT_SETTINGS[page].title}
    </SidebarLink>
  );
  return (
    <nav aria-label="Your settings" className={PANEL}>
      <BackRow to="/" label="Your settings" context={username} />
      <div className="mt-2 space-y-px">
        {link("profile", <CircleUserRound size={15} />)}
        {link("emails", <Mail size={15} />)}
        {invites && link("invites", <Ticket size={15} />)}
      </div>
      <Rule />
      <div className="space-y-px">
        {link("keys", <Fingerprint size={15} />)}
        {link("tokens", <KeyRound size={15} />)}
      </div>
      <Rule />
      <div className="space-y-px">
        {link("integrations", <Blocks size={15} />)}
        {link("github", <GithubMark className="size-[15px]" />)}
        {link("applications", <Plug size={15} />)}
      </div>
      <Rule />
      <div className="space-y-px">
        {link("two-factor", <ShieldCheck size={15} />)}
        {link("security-log", <History size={15} />)}
      </div>
    </nav>
  );
}

/**
 * Code's sidebar: its Overview, the projects, what spans them and what is
 * coming; in a project, drilled into the project's own list, and its
 * settings one level further in. The address says which, so a link
 * straight to a project opens the sidebar already drilled in.
 */
function CodeSidebar({
  user,
  shell,
  missing = false,
}: {
  user: User;
  shell: ShellData;
  /** The page is a 404: the address names nothing the viewer can see. */
  missing?: boolean;
}) {
  const ws = shell.workspace;
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  // Where the sidebar is drilled to follows the page being gone to, so it
  // moves as the link is followed, not once the page arrives.
  const target = going ?? pathname;
  // On a 404, the address is not a place: no list is drilled into from it,
  // except the project's own when the project is real and visible and only
  // something inside it is missing (a file, a commit, an issue).
  const lost = missing && going == null;
  const active = shell.repo;
  // In a repository, or on the way into one, its own list.
  const repoPath = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(target);
  const reserved = new Set(["settings", "explore", "search", "new", "u", "pricing", "avatars", "workspaces", "login", "logout", "register", "verify", "forgot", "reset", "device", "oauth", "policies", "security", "support", "status", "invite", "notifications", "inbox", ".well-known"]);
  // An invitation to a repository is answered before its menu means anything.
  const inRepo =
    repoPath != null &&
    !reserved.has(repoPath[1]) &&
    repoPath[2] !== "-" &&
    !/^\/[^/]+\/[^/]+\/invitations\/?$/.test(target) &&
    (!lost || sameRepo(active, { namespace: repoPath[1]!, name: repoPath[2]! }));
  // A project's settings, one level further in.
  const inRepoSettings = inRepo && REPO_SETTINGS_PAGE.test(target);
  // The repository the menu is for: the one loaded if it is the one being
  // gone to, else what the address says, at once.
  const targetRepo = inRepo && repoPath ? { namespace: repoPath[1], name: repoPath[2] } : null;
  const guessed: MenuRepo | null = targetRepo
    ? sameRepo(active, targetRepo)
      ? active
      : {
          ...targetRepo,
          member: (user.workspaces ?? []).some((m) => m.slug === targetRepo.namespace.toLowerCase()),
        }
    : null;
  // The viewer's role there, from the repository's page once it has loaded.
  const page = useRouteLoaderData("routes/repo/layout") as
    | { repo?: { namespace: string; name: string }; access?: ViewerAccess }
    | undefined;
  const menuRepo: MenuRepo | null =
    guessed && page?.access && page.repo && sameRepo(page.repo, guessed)
      ? { ...guessed, member: page.access.insider, settings: seesSettings(page.access), can: page.access.can }
      : guessed;

  // The way from Code's list to the one shown.
  const trail: Level[] = [{ key: "main", node: ws ? <CodeMenu shell={shell} slug={ws.slug} /> : null }];
  if (menuRepo) {
    const key = `repo:${menuRepo.namespace}/${menuRepo.name}`.toLowerCase();
    // Out of a project: to its workspace's projects when they are yours.
    const home = (user.workspaces ?? []).find((m) => m.slug === menuRepo.namespace.toLowerCase());
    const back = home ? { to: `/${home.slug}/-/projects`, label: "All projects" } : { to: ws ? `/${ws.slug}/-/overview` : "/explore", label: "Code" };
    trail.push({
      key,
      node: (
        <RepoMenu
          repo={menuRepo}
          isPrivate={[...shell.repos, ...(shell.shared ?? [])].some((repo) => sameRepo(repo, menuRepo) && repo.isPrivate)}
          back={back}
        />
      ),
    });
    if (inRepoSettings) trail.push({ key: `${key}:settings`, node: <RepoSettingsMenu repo={menuRepo} /> });
  }

  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Code" />
      <Drill trail={trail} />
    </div>
  );
}

/**
 * A mode's sidebar heading: its name, quiet, under the workspace's
 * switcher, with what it makes at the end.
 */
export function ModeHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-3">
      <h2 className="min-w-0 grow truncate text-xs font-medium text-faint">{title}</h2>
      {action}
    </div>
  );
}

/**
 * Code's own list (beside the dock): only code. Its Overview (Mission
 * control's code panels), the projects, what spans them, and what is
 * coming. The workspace's people, money and settings are elsewhere;
 * agents, context and memory are Agents'.
 */
function CodeMenu({ shell, slug }: { shell: ShellData; slug: string }) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const path = going ?? pathname;
  const at = (page: string) => path === `/${slug}/-/${page}` || path.startsWith(`/${slug}/-/${page}/`);
  const shared = shell.shared ?? [];
  return (
    <nav aria-label="Code" className={PANEL}>
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/overview`} icon={<LayoutDashboard size={15} />} current={at("overview")}>
          Overview
        </SidebarLink>
      </div>
      <div className="mt-3">
        <SidebarProjects slug={slug} shell={shell} current={at("projects")} />
      </div>
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/security`} icon={<ShieldCheck size={15} />} current={at("security") && !at("security/settings")}>
          Security
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/packages`} icon={<Package size={15} />} current={at("packages")}>
          Packages
        </SidebarLink>
        {INSIGHTS && (
          <SidebarSoonLink to={`/${slug}/-/insights`} icon={<TrendingUp size={15} />} about={INSIGHTS.summary} current={at("insights")}>
            {INSIGHTS.title}
          </SidebarSoonLink>
        )}
        {roadmapIn("Workspace")
          .filter((item) => item.key !== "insights" && item.key !== "teams" && item.key !== "fleet")
          .map((item) => (
            <SidebarSoonLink key={item.key} to={`/${slug}/-/soon/${item.key}`} icon={WORKSPACE_ICONS[item.key] ?? <Sparkles size={15} />} about={item.summary}>
              {item.title === "Board" ? "Boards" : item.title}
            </SidebarSoonLink>
          ))}
      </div>
      {shared.length > 0 && (
        <>
          <Rule />
          <SidebarGroup title="Shared with you">
            {shared.map((repo) => (
              <SidebarLink
                key={`${repo.namespace}/${repo.name}`}
                to={`/${repo.namespace}/${repo.name}`}
                icon={repo.isPrivate ? <Lock size={15} /> : <Box size={15} />}
                drill="hover"
              >
                <span className="font-mono text-faint">{repo.namespace}/</span>
                {repo.name}
              </SidebarLink>
            ))}
          </SidebarGroup>
        </>
      )}
    </nav>
  );
}

/** Workspace pages that sit in its Settings list, drilled into from the Workspace sidebar. */
const WORKSPACE_SETTINGS = ["settings", "repositories", "tokens", "personal-access-tokens", "secrets", "actions", "webhooks", "emoji"];

/**
 * The Workspace mode's sidebar: the workspace itself, for every member.
 * Its overview, money, machines, connections, policies and record, then its
 * settings as a list of their own. Owner-only pages stay owner-only.
 */
export function WorkspaceSidebar({ slug, owner }: { slug: string; owner: boolean }) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const path = going ?? pathname;
  const page = path.startsWith(`/${slug}/-/`) ? path.slice(`/${slug}/-/`.length) : "";
  const top = page.split("/")[0] ?? "";
  const at = (...pages: string[]) => pages.some((p) => page === p || page.startsWith(`${p}/`));
  const inSettings = WORKSPACE_SETTINGS.includes(top);
  const main = (
    <nav aria-label="Workspace" className={PANEL}>
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/workspace`} icon={<LayoutGrid size={15} />} current={at("workspace")}>
          Overview
        </SidebarLink>
      </div>
      <SidebarGroup title="Money" className="mt-3">
        <SidebarLink to={`/${slug}/-/spend`} icon={<Coins size={15} />} current={at("spend")}>
          Spend
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/usage`} icon={<BarChart3 size={15} />} current={at("usage")}>
          Usage
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/gateway`} icon={<Network size={15} />} current={at("gateway")}>
          AI Gateway
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/billing`} icon={<CreditCard size={15} />} current={at("billing")}>
          Billing and plans
        </SidebarLink>
      </SidebarGroup>
      {owner && (
        <SidebarGroup title="Compute" className="mt-3">
          <SidebarLink to={`/${slug}/-/runners`} icon={<ServerCog size={15} />} current={at("runners")}>
            Runners
          </SidebarLink>
        </SidebarGroup>
      )}
      <SidebarGroup title="Connections" className="mt-3">
        <SidebarLink to={`/${slug}/-/integrations`} icon={<Plug size={15} />} current={at("integrations")}>
          Integrations
        </SidebarLink>
      </SidebarGroup>
      <SidebarGroup title="Security policies" className="mt-3">
        <SidebarLink to={`/${slug}/-/security/settings`} icon={<ShieldCheck size={15} />} current={at("security/settings")}>
          Security settings
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/guardrails`} icon={<Gauge size={15} />} current={at("guardrails")}>
          Guardrails
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/rules`} icon={<Scale size={15} />} current={at("rules")}>
          Rules
        </SidebarLink>
      </SidebarGroup>
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/audit`} icon={<History size={15} />} current={at("audit")}>
          Audit log
        </SidebarLink>
        <SidebarLink to={owner ? `/${slug}/-/settings` : `/${slug}/-/repositories`} icon={<Settings size={15} />} drill current={inSettings}>
          Settings
        </SidebarLink>
      </div>
    </nav>
  );
  const settings = (
    <nav aria-label="Workspace settings" className={PANEL}>
      <BackRow to={`/${slug}/-/workspace`} label="Settings" context={slug} />
      <div className="mt-2 space-y-px">
        {owner && (
          <SidebarLink to={`/${slug}/-/settings`} icon={<Settings size={15} />} end>
            General
          </SidebarLink>
        )}
        <SidebarLink to={`/${slug}/-/settings/chat`} icon={<MessagesSquare size={15} />}>
          Chat
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/repositories`} icon={<BookMarked size={15} />}>
          Repositories
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/tokens`} icon={<KeyRound size={15} />}>
          Access tokens
        </SidebarLink>
        {owner && (
          <SidebarLink to={`/${slug}/-/personal-access-tokens`} icon={<UserRoundKey size={15} />}>
            Personal access tokens
          </SidebarLink>
        )}
        <SidebarLink to={`/${slug}/-/webhooks`} icon={<Webhook size={15} />}>
          Webhooks
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/emoji`} icon={<Smile size={15} />}>
          Emoji
        </SidebarLink>
      </div>
      <SidebarGroup title="Runs" className="mt-3">
        <SidebarLink to={`/${slug}/-/secrets`} icon={<Lock size={15} />}>
          Secrets and variables
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/actions`} icon={<PlayCircle size={15} />}>
          Actions
        </SidebarLink>
      </SidebarGroup>
    </nav>
  );
  const trail: Level[] = [{ key: "workspace", node: main }];
  if (inSettings) trail.push({ key: "workspace:settings", node: settings });
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Workspace" />
      <Drill trail={trail} />
    </div>
  );
}

/**
 * People's sidebar: everyone in the workspace, people and agents; its
 * teams; the org chart; and, to manage who belongs, members and invites.
 */
function PeopleSidebar({ slug }: { slug: string }) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const path = going ?? pathname;
  const at = (page: string) => path === `/${slug}/-/${page}` || path.startsWith(`/${slug}/-/${page}/`);
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="People" />
      <nav aria-label="People" className={PANEL}>
        <div className="space-y-px">
          <SidebarLink to={`/${slug}/-/people`} icon={<Users size={15} />} current={at("people")}>
            Everyone
          </SidebarLink>
          <SidebarLink to={`/${slug}/-/teams`} icon={<UsersRound size={15} />} current={at("teams")}>
            Teams
          </SidebarLink>
          <SidebarLink to={`/${slug}/-/org-chart`} icon={<Network size={15} />} current={at("org-chart")}>
            Org chart
          </SidebarLink>
        </div>
        <SidebarGroup title="Membership" className="mt-3">
          <SidebarLink to={`/${slug}/-/members`} icon={<UserPlus size={15} />} current={at("members")}>
            Members and invites
          </SidebarLink>
        </SidebarGroup>
      </nav>
    </div>
  );
}

/**
 * Notifications' sidebar: what you have not finished with, what you saved
 * and what is done; then why you were told, which narrows any of them.
 */
function NotificationsSidebar({ counts }: { counts: InboxCounts | null }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const view = inboxView(params.get("view"));
  const reason = inboxReason(params.get("reason"));
  const tab = params.get("tab");
  const address = (changes: Record<string, string | null>) => {
    const merged: Record<string, string | null> = { tab, view: view === "inbox" ? null : view, reason, ...changes };
    const next = new URLSearchParams();
    for (const [name, value] of Object.entries(merged)) if (value) next.set(name, value);
    const query = next.toString();
    return query ? `/notifications?${query}` : "/notifications";
  };
  const views = [
    { view: "inbox", label: "Everything", icon: <Bell size={15} />, count: counts?.unread },
    { view: "saved", label: "Saved", icon: <Bookmark size={15} /> },
    { view: "done", label: "Done", icon: <Check size={15} /> },
  ] as const;
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Notifications" />
      <nav aria-label="Notifications" className={PANEL}>
        <div className="space-y-px">
          {views.map((entry) => (
            <SidebarLink
              key={entry.view}
              to={address({ view: entry.view === "inbox" ? null : entry.view, before: null })}
              icon={entry.icon}
              count={"count" in entry ? (entry.count ?? undefined) : undefined}
              current={view === entry.view}
            >
              {entry.label}
            </SidebarLink>
          ))}
        </div>
        <SidebarGroup title="Why you were told" className="mt-4">
          {REASON_FILTERS.map((entry) => (
            <SidebarLink
              key={entry.reason ?? "any"}
              to={address({ reason: entry.reason, before: null })}
              icon={<span className="block size-[15px]" />}
              current={reason === entry.reason}
            >
              {entry.reason == null ? "Any reason" : entry.label}
            </SidebarLink>
          ))}
        </SidebarGroup>
      </nav>
    </div>
  );
}

/** Your own settings, beside the page: under the account menu, not any workspace's. */
export function AccountSidebar({ username }: { username: string }) {
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Your account" />
      <div className="min-h-0 grow">
        <AccountSettingsMenu username={username} />
      </div>
    </div>
  );
}

/** Words for the sections a path can end in. */
const SECTIONS: Record<string, string> = {
  issues: "Issues",
  milestones: "Milestones",
  labels: "Labels",
  pulls: "Pull requests",
  queue: "Merge queue",
  commits: "Commits",
  plans: "Outcomes",
  actions: "Workflows",
  soon: "Soon",
  deployments: "Deployments",
  repository: "Repository",
  access: "Access",
  invitations: "Invitation",
  repositories: "Repositories",
  branches: "Branches",
  tags: "Tags",
  compare: "Compare",
  code: "Files",
  secrets: "Secrets and variables",
  settings: "Settings",
  people: "People",
  "org-chart": "Org chart",
  members: "Members and invites",
  projects: "Projects",
  teams: "Teams",
  tokens: "Access tokens",
  "personal-access-tokens": "Personal access tokens",
  spend: "Spend",
  receipts: "Receipts",
  usage: "Usage",
  gateway: "AI Gateway",
  billing: "Billing and plans",
  integrations: "Integrations",
  webhooks: "Webhooks",
  emoji: "Emoji",
  domains: "Domains",
  guardrails: "Guardrails",
  rules: "Rules",
  audit: "Audit log",
  tree: "Files",
  blob: "Files",
  agents: "Agents",
  context: "Context",
  memory: "Memory",
  security: "Security",
  packages: "Packages",
  runners: "Runners",
  environments: "Environments",
  workflows: "Workflows",
  observability: "Observability",
  insights: "Insights",
  sessions: "Sessions",
  chat: "Chat",
  artifacts: "Artifacts",
  today: "Today",
  apps: "Apps",
  marketplace: "Marketplace",
  "code-access": "Code access",
  overview: "Overview",
  workspace: "Workspace",
};

/** Settings pages whose name differs from the section's of the same word. */
const SETTINGS_SECTIONS: Record<string, string> = { branches: "Branches and merging", actions: "Actions" };

/** Where the page is, as a trail of links: workspace / repository / section. */
function Breadcrumbs({
  pathname,
  missing,
  repo,
  workspace,
}: {
  pathname: string;
  missing?: boolean;
  repo?: ShellData["repo"];
  /** The workspace you are in: the switcher names it, so the trail starts after it. */
  workspace: string | null;
}) {
  // A 404 names nothing from the address, unless the project is real and
  // visible and only something inside it is missing.
  const visibleRepo = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(pathname);
  if (missing && !(visibleRepo && sameRepo(repo ?? null, { namespace: visibleRepo[1]!, name: visibleRepo[2]! }))) {
    return <span className="text-sm font-medium">Not found</span>;
  }
  const parts = pathname.split("/").filter(Boolean);
  const reserved = ["settings", "explore", "new", "search", "workspaces", "policies", "security", "support", "status", "invite", "notifications"];
  if (parts.length === 0) return <span className="text-sm font-medium">Today</span>;
  // Your settings: Settings / Emails.
  if (parts[0] === "settings") {
    const page = accountSettingsPage(pathname);
    return <Trail trail={[{ label: "Settings", to: FIRST_SETTINGS_PAGE }, ...(page ? [{ label: ACCOUNT_SETTINGS[page].title, to: `/settings/${page}` }] : [])]} />;
  }
  if (reserved.includes(parts[0]!)) {
    const words: Record<string, string> = {
      settings: "Account",
      explore: "Explore",
      new: "New project",
      search: "Search",
      workspaces: "New workspace",
      policies: "Policies",
      security: "Security",
      support: "Support",
      status: "Status",
      invite: "Invite",
      notifications: "Notifications",
    };
    return <span className="text-sm font-medium">{words[parts[0]!]}</span>;
  }
  // A person's profile, by their handle.
  if (parts[0] === "u" && parts[1]) return <ProfileCrumb username={parts[1]} />;
  const [owner, second, third, fourth] = parts;
  const ours = workspace != null && owner!.toLowerCase() === workspace.toLowerCase();
  const trail: Crumb[] = ours ? [] : [{ label: owner!, to: `/${owner}`, mono: true }];
  if (second === "-") {
    const page = `/${owner}/-/${third}`;
    if (third && SETTINGS_PAGE.test(page)) {
      trail.push({ label: "Settings", to: `/${owner}/-/settings` });
      trail.push({ label: third === "settings" ? "General" : (SECTIONS[third] ?? third), to: page });
    } else if (third) {
      trail.push({ label: SECTIONS[third] ?? third, to: page });
      // The Marketplace names its tab (Marketplace / Extensions), and Agents its templates.
      const tabs: Record<string, string> =
        third === "marketplace" ? { integrations: "Integrations", extensions: "Extensions", requests: "Requests" } : third === "agents" ? { templates: "Templates" } : {};
      const tab = fourth ? tabs[fourth] : undefined;
      if (tab) trail.push({ label: tab, to: `${page}/${fourth}` });
    }
  } else if (second) {
    const repo = `/${owner}/${second}`;
    trail.push({ label: second, to: repo, mono: true });
    if (third === "pull" && fourth) trail.push({ label: `Pull request #${fourth}`, short: `#${fourth}`, to: `${repo}/pull/${fourth}` });
    else if (third === "issues" && fourth && fourth !== "new") trail.push({ label: `Issue #${fourth}`, short: `#${fourth}`, to: `${repo}/issues/${fourth}` });
    else if (third === "commit" && fourth) trail.push({ label: fourth.slice(0, 7), to: `${repo}/commit/${fourth}`, mono: true });
    else if (third && SECTIONS[third]) {
      trail.push({ label: SECTIONS[third]!, to: `${repo}/${third}` });
      // A settings page names which one: Settings / Secrets and variables.
      if (third === "settings" && fourth && SECTIONS[fourth]) {
        trail.push({ label: SETTINGS_SECTIONS[fourth] ?? SECTIONS[fourth]!, to: `${repo}/settings/${fourth}` });
      }
    }
  }
  if (trail.length === 0) trail.push({ label: "Overview", to: `/${owner}` });
  return <Trail trail={trail} />;
}

/** A profile's place in the top bar: the person's avatar and @handle, from the page once it has loaded. */
function ProfileCrumb({ username }: { username: string }) {
  const page = useRouteLoaderData("routes/user") as { profile?: { username: string; displayUsername?: string | null; avatar: string | null } } | undefined;
  const profile = page?.profile?.username.toLowerCase() === username.toLowerCase() ? page.profile : null;
  return (
    <Link to={`/u/${profile?.username ?? username}`} aria-current="page" className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-raised">
      <Avatar name={profile?.username ?? username} image={profile?.avatar ?? null} size={20} />
      <span className="truncate font-mono text-[0.8125rem] font-medium">@{profile ? shownUsername(profile) : username}</span>
    </Link>
  );
}

/** One link of the trail; `short` is what a phone shows when it is the page itself. */
type Crumb = { label: string; to: string; mono?: boolean; short?: string };

/**
 * The trail of links. On a phone there is room for one: the page itself,
 * with a way back to where it sits; the whole trail from a wider screen up.
 */
function Trail({ trail }: { trail: Crumb[] }) {
  // Up on a phone, unless up is the workspace itself: its pages are the tabs.
  const up = trail.length > 1 && !/^\/[^/]+$/.test(trail[trail.length - 2]!.to) ? trail[trail.length - 2]! : null;
  return (
    <nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-sm">
      {up && (
        <Link
          to={up.to}
          prefetch="intent"
          aria-label={`Back to ${up.label}`}
          className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg sm:hidden"
        >
          <ChevronLeft size={16} />
        </Link>
      )}
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        return (
          <span key={index} className={`min-w-0 items-center gap-1.5 ${last ? "flex" : "hidden sm:flex"}`}>
            {index > 0 && <span className="hidden text-line-strong sm:inline">/</span>}
            <Link
              to={crumb.to}
              prefetch="intent"
              aria-current={last ? "page" : undefined}
              className={`truncate rounded px-1 py-0.5 transition-colors hover:bg-raised ${
                last ? "font-medium text-fg" : "text-muted hover:text-fg"
              } ${crumb.mono ? "font-mono text-[0.8125rem]" : ""}`}
            >
              {last && crumb.short ? (
                <>
                  <span className="sm:hidden">{crumb.short}</span>
                  <span className="hidden sm:inline">{crumb.label}</span>
                </>
              ) : (
                crumb.label
              )}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}

type Command = PaletteCommand;

/** Everything the palette can jump to, from what the sidebar already knows. */
function commandsFor(user: User, shell: ShellData): Command[] {
  const ws = shell.workspace;
  const commands: Command[] = [
    ...(ws
      ? [
          { label: "Today", to: todayPath(ws.slug), icon: <Sun size={15} /> },
          { label: "Chat", to: `/${ws.slug}/-/chat`, icon: <MessagesSquare size={15} /> },
          { label: "Agents", to: `/${ws.slug}/-/agents`, icon: <Sparkles size={15} /> },
          ...(hasCodeAccess(ws) ? [{ label: "Code overview", to: `/${ws.slug}/-/overview`, icon: <Code2 size={15} /> }] : []),
          { label: "Artifacts", to: `/${ws.slug}/-/artifacts`, icon: <Shapes size={15} /> },
          { label: "Apps", hint: "Everything installed that you can use", to: `/${ws.slug}/-/apps`, icon: <LayoutGrid size={15} /> },
          { label: "Marketplace", hint: "Extensions and integrations to add", to: `/${ws.slug}/-/marketplace`, icon: <Store size={15} /> },
          { label: "Agent templates", hint: "Starting points for a new agent", to: `/${ws.slug}/-/agents/templates`, icon: <Bot size={15} /> },
          { label: "Workspace", hint: "Billing, policies, settings", to: `/${ws.slug}/-/workspace`, icon: <Building2 size={15} /> },
        ]
      : []),
    ...(shell.repos.length > 0
      ? [{ label: "Put an agent on it", hint: "Open an issue and assign g1t", to: "/?agent=new", icon: <Sparkles size={15} /> }]
      : []),
    { label: "Explore repositories", to: "/explore", icon: <Compass size={15} /> },
    { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
    { label: "Notifications", hint: "What needs you", to: "/notifications", icon: <Bell size={15} /> },
    { label: "New project", to: "/new", icon: <Plus size={15} /> },
    { label: "New workspace", to: "/workspaces/new", icon: <Plus size={15} /> },
    { label: "Your settings", to: FIRST_SETTINGS_PAGE, icon: <Settings size={15} /> },
    ...(Object.keys(ACCOUNT_SETTINGS) as AccountSettingsPage[])
      .filter((page) => page !== "profile")
      .map((page) => ({ label: ACCOUNT_SETTINGS[page].title, hint: "Your settings", to: `/settings/${page}`, icon: <Settings size={15} /> })),
    ...THEME_COMMANDS,
  ];
  const repo = shell.repo;
  if (repo) {
    const base = `/${repo.namespace}/${repo.name}`;
    const name = `${repo.namespace}/${repo.name}`;
    commands.unshift(
      { label: "Overview", hint: name, to: base, icon: <LayoutGrid size={15} /> },
      { label: "Code", hint: name, to: `${base}/code`, icon: <Code2 size={15} /> },
      { label: "Issues", hint: name, to: `${base}/issues`, icon: <CircleDot size={15} /> },
      { label: "New issue", hint: name, to: `${base}/issues/new`, icon: <Plus size={15} /> },
      ...(repo.member
        ? [{ label: `Put an agent on ${repo.name}`, hint: name, to: `${base}/issues/new?agent=1`, icon: <Sparkles size={15} /> }]
        : []),
      { label: "Pull requests", hint: name, to: `${base}/pulls`, icon: <GitPullRequest size={15} /> },
      { label: "Commits", hint: name, to: `${base}/commits`, icon: <History size={15} /> },
      ...(repo.member
        ? [
            { label: "Plan work", hint: name, to: `${base}/plans`, icon: <ListTree size={15} /> },
            { label: "Deployments", hint: name, to: `${base}/deployments`, icon: <Rocket size={15} /> },
            { label: "Secrets and variables", hint: name, to: `${base}/settings/secrets`, icon: <Lock size={15} /> },
            { label: "Project settings", hint: name, to: `${base}/settings`, icon: <Settings size={15} /> },
            { label: "Repository settings", hint: name, to: `${base}/settings/repository`, icon: <Settings size={15} /> },
          ]
        : []),
    );
  }
  for (const membership of user.workspaces ?? []) {
    commands.push(
      { label: displayName(membership), hint: `Workspace · ${membership.slug}`, to: `/${membership.slug}`, icon: <Avatar name={membership.slug} image={membership.avatar} size={15} square /> },
      { label: "All projects", hint: membership.slug, to: `/${membership.slug}/-/projects`, icon: <LayoutGrid size={15} /> },
      { label: "People", hint: membership.slug, to: `/${membership.slug}/-/people`, icon: <Users size={15} /> },
      { label: "Spend", hint: `${membership.slug} · Budgets and receipts`, to: `/${membership.slug}/-/spend`, icon: <Coins size={15} /> },
      { label: "Usage", hint: membership.slug, to: `/${membership.slug}/-/usage`, icon: <BarChart3 size={15} /> },
      { label: "AI Gateway", hint: `${membership.slug} Â· Usage`, to: `/${membership.slug}/-/gateway`, icon: <Network size={15} /> },
      { label: "Billing and plans", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/billing`, icon: <CreditCard size={15} /> },
      { label: "Access tokens", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/tokens`, icon: <KeyRound size={15} /> },
      { label: "Integrations", hint: membership.slug, to: `/${membership.slug}/-/integrations`, icon: <Plug size={15} /> },
    );
  }
  for (const listed of shell.repos) {
    commands.push({
      label: listed.title ?? listed.name,
      hint: `${listed.namespace} · Project`,
      to: `/${listed.namespace}/${listed.name}`,
      icon: <Box size={15} />,
    });
  }
  // "Put an agent on …": one per project, after the projects themselves.
  for (const listed of shell.repos) {
    if (repo && listed.namespace === repo.namespace && listed.name === repo.name) continue;
    commands.push({
      label: `Put an agent on ${listed.title ?? listed.name}`,
      hint: `${listed.namespace}/${listed.name}`,
      to: `/${listed.namespace}/${listed.name}/issues/new?agent=1`,
      icon: <Sparkles size={15} />,
    });
  }
  return commands;
}

/**
 * The page while the next one loads: after a moment it dims, under the
 * bar below, so it is plainly on its way out rather than frozen, and the
 * next page fades up from there. Sending a form does not dim it: the
 * form's button says it is working. Spread on the element holding the page.
 */
export function useLeaving() {
  const navigation = useNavigation();
  const method = navigation.formMethod?.toUpperCase();
  const leaving = navigation.state === "loading" && (method == null || method === "GET");
  return {
    "aria-busy": leaving || undefined,
    className: `transition-opacity motion-reduce:transition-none ${leaving ? "opacity-60 delay-200 duration-300" : "duration-150"}`,
  };
}

/**
 * A bar across the top of the page while the next one loads, as GitHub
 * has: it appears at once, creeps towards the end while waiting, then fills
 * and fades when the page arrives.
 */
export function Progress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (busy) {
      setVisible(true);
      setWidth(12);
      // Slows as it goes, never quite arriving until the page does.
      const timer = setInterval(() => setWidth((now) => now + (90 - now) * 0.12), 200);
      return () => clearInterval(timer);
    }
    setWidth((now) => (now > 0 ? 100 : 0));
    const fade = setTimeout(() => setVisible(false), 250);
    const reset = setTimeout(() => setWidth(0), 550);
    return () => {
      clearTimeout(fade);
      clearTimeout(reset);
    };
  }, [busy]);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className="h-full bg-accent shadow-[0_0_10px_var(--color-accent)] transition-[width] duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/** The top bar's way to g1t: the direct message with the workspace's orchestrator, opened or made. */
function AskG1tButton({ slug }: { slug: string }) {
  return (
    <Hint label="Ask g1t">
      <Link
        to={`/${slug}/-/chat?agent=g1t`}
        aria-label="Ask g1t"
        className="flex h-8 items-center gap-1.5 rounded-md border border-line px-1.5 text-sm text-fg/90 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg sm:px-2.5"
      >
        <G1tMark size={18} />
        <span className="hidden lg:inline">Ask g1t</span>
      </Link>
    </Hint>
  );
}

/**
 * Which sidebar sits beside the page: each mode's own, or none. Today and
 * Apps are pages at full width, and so are g1t's public pages, such as a
 * profile, which are no workspace's. Without a workspace, only your own
 * settings and Notifications have one.
 */
function sidebarFor(mode: ModeKey, workspace: boolean): Panel | null {
  if (!workspace) return mode === "account" || mode === "notifications" ? mode : null;
  if (mode === "today" || mode === "apps" || mode === "site") return null;
  return mode;
}

/** The sidebars that sit beside the page, one per mode that has one. */
type Panel = "chat" | "artifacts" | "agents" | "code" | "notifications" | "people" | "workspace" | "account";

/** Each sidebar's name, for the button that opens it on a phone. */
const MODE_MENU: Record<Panel, string> = {
  chat: "Chat",
  artifacts: "Artifacts",
  agents: "Agents",
  code: "Code",
  notifications: "Notifications",
  people: "People",
  workspace: "Workspace",
  account: "Your account",
};

/** Whether a key press happened in something you type into, where Ctrl B is the editor's. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']") != null;
}

/** Ctrl B (⌘B on a Mac) shows or hides the sidebar, except while typing. */
function useSidebarShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.defaultPrevented || typing(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** The button that shows or hides the sidebar. */
function SidebarToggle({ onClick, open, className = "" }: { onClick: () => void; open: boolean; className?: string }) {
  const key = sidebarKeyLabel(typeof navigator === "undefined" ? null : navigator.platform);
  return (
    <Hint label={`Toggle sidebar (${key})`}>
      <button
        type="button"
        aria-label={open ? "Hide the sidebar" : "Show the sidebar"}
        aria-expanded={open}
        onClick={onClick}
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent ${className}`}
      >
        <PanelLeft size={17} />
      </button>
    </Hint>
  );
}

/**
 * The app: three surfaces that never blur
 * together. The dock, a floating bar of apps down the left; the mode's
 * sidebar, flat on the background beside it, which folds away with Ctrl B
 * and is a drawer below 1024px; and the page, a rounded panel inset from
 * the window, with its header across the top: the sidebar's toggle, where
 * you are, search, Ask g1t and Create new. On a phone the dock is a bar
 * along the bottom. Only for someone signed in; without a workspace yet,
 * there is no dock.
 */
export function AppShell({
  user,
  shell,
  missing = false,
  banner,
  sidebarClosed = false,
  children,
}: {
  user: User;
  shell: ShellData;
  /** The page is a 404 (see CodeSidebar). */
  missing?: boolean;
  banner?: ReactNode;
  /** Whether the person folded the sidebar away, as their cookie says. */
  sidebarClosed?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [closed, setClosed] = useState(sidebarClosed);
  const [palette, setPalette] = useState(false);
  const commands = useMemo(() => commandsFor(user, shell), [user, shell]);

  // A new page closes the drawer.
  useEffect(() => setDrawer(false), [pathname]);
  usePaletteShortcut(() => setPalette((open) => !open));
  const leaving = useLeaving();
  useVisualViewport();

  const going = useNavigation().location?.pathname;
  const ws = shell.workspace;
  const mode = modeOf(going ?? pathname, ws?.slug ?? null);
  const panel = sidebarFor(mode, ws != null);
  const code = ws ? hasCodeAccess(ws) : false;
  const { sidebar: chatSidebar } = useChatSidebar();
  // Notify: the feed socket's live counts (lib/notify-client.ts) once it has them; the page's until then.
  const live = useLiveBadges(ws?.slug);
  const chatUnread = chatSidebar
    ? unreadTotals(chatSidebar.entries)
    : live?.chat != null
      ? { unread: live.chat, mentions: live.mentions ?? 0 }
      : (shell.chat ?? { unread: 0, mentions: 0 });
  const notificationsUnread = live?.inbox ?? shell.inbox?.unread ?? 0;
  const unread = { notifications: notificationsUnread, chat: chatUnread.unread, mentions: chatUnread.mentions };

  // Folding the sidebar away on a computer is remembered, so the next page is drawn the same from the server.
  const toggleSidebar = useCallback(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      setDrawer((open) => !open);
      return;
    }
    setClosed((was) => {
      document.cookie = sidebarCookie(!was, window.location.protocol === "https:");
      return !was;
    });
  }, []);
  useSidebarShortcut(useCallback(() => {
    if (panel) toggleSidebar();
  }, [panel, toggleSidebar]));

  const inline = panel != null && !closed;
  const sidebarNode = () => {
    if (!panel) return null;
    if (!ws) return panel === "notifications" ? <NotificationsSidebar counts={shell.inbox ?? null} /> : <AccountSidebar username={user.username} />;
    switch (panel) {
      case "code":
        return <CodeSidebar user={user} shell={shell} missing={missing} />;
      case "chat":
        return <ChatSidebar slug={ws.slug} />;
      case "artifacts":
        return <FoliosSidebar slug={ws.slug} />;
      case "agents":
        return <AgentsSidebar slug={ws.slug} shellAgents={shell.agents ?? null} code={code} owner={ws.role === "owner"} />;
      case "notifications":
        return <NotificationsSidebar counts={shell.inbox ?? null} />;
      case "people":
        return <PeopleSidebar slug={ws.slug} />;
      case "workspace":
        return <WorkspaceSidebar slug={ws.slug} owner={ws.role === "owner"} />;
      case "account":
        return <AccountSidebar username={user.username} />;
    }
  };
  // The sidebar's top row: the workspace and its switcher, and the way to fold the sidebar or close the drawer.
  const sidebarTop = (inDrawer: boolean) => (
    <div className="flex h-14 shrink-0 items-center gap-1 pr-1 pl-1">
      {ws ? (
        <WorkspaceSwitcher user={user} workspace={ws} />
      ) : (
        <Link to="/" aria-label="g1t" className="mr-auto flex h-9 items-center rounded-md px-2">
          <Logo className="text-[1.125rem]" />
        </Link>
      )}
      {inDrawer ? (
        <button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg">
          <X size={16} />
        </button>
      ) : (
        <SidebarToggle open onClick={toggleSidebar} />
      )}
    </div>
  );

  // On a phone (below 768px): the bottom bar, and a conversation full screen.
  const conversation = isConversation(going ?? pathname);
  // Where the page panel starts: 8px past the dock (88px), or right after the sidebar (260px) when it is open.
  const left = ws ? (inline ? "md:left-24 lg:left-[21.75rem]" : "md:left-24") : inline ? "md:left-2 lg:left-[16.75rem]" : "md:left-2";
  const pad = ws ? (inline ? "md:pl-24 lg:pl-[21.75rem]" : "md:pl-24") : inline ? "md:pl-2 lg:pl-[16.75rem]" : "md:pl-2";

  return (
    // The drawer is a sheet: a dialog that holds focus, closes on Escape or
    // a tap outside, and gives focus back to the button that opened it.
    <Sheet open={drawer} onOpenChange={setDrawer}>
      <Progress />
      {ws && (
        <div className="fixed top-2 bottom-2 left-2 z-40 hidden w-20 md:block">
          <Dock
            workspace={ws}
            pins={shell.pins ?? []}
            unread={unread}
            account={<AccountMenu user={user} />}
          />
        </div>
      )}
      {panel && (
        <aside
          aria-label={`${MODE_MENU[panel]} sidebar`}
          className={`fixed inset-y-0 z-40 hidden w-[16.25rem] flex-col pr-0.5 pl-1.5 ${ws ? "left-[5.5rem]" : "left-0"} ${inline ? "lg:flex" : ""}`}
        >
          {sidebarTop(false)}
          <div className="min-h-0 grow">{sidebarNode()}</div>
        </aside>
      )}
      <SheetContent
        side="left"
        showClose={false}
        aria-describedby={undefined}
        // Focus would land on the workspace's switcher and open its menu's hint; the sheet itself takes it instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="flex w-[min(18.5rem,86vw)] flex-col border-line bg-shell px-1.5 pb-[env(safe-area-inset-bottom)] max-md:[&_nav_a]:min-h-10"
      >
        <SheetTitle className="sr-only">{panel ? `${MODE_MENU[panel]} menu` : "Menu"}</SheetTitle>
        {sidebarTop(true)}
        <div className="min-h-0 grow">{sidebarNode()}</div>
      </SheetContent>

      <div className={`min-h-dvh px-1.5 pt-(--frame-top) pb-(--tabbar-h) md:pr-2 ${pad}`}>
        <div className="flex min-h-[calc(100dvh-var(--frame-top)-var(--tabbar-h))] min-w-0 flex-col rounded-[14px] bg-bg">
          <header
            className={`sticky top-(--frame-top) z-30 flex h-14 items-center gap-1.5 rounded-t-[14px] border-b border-line bg-bg pr-2 pl-2 sm:gap-2 sm:pr-3 ${conversation ? "max-md:hidden" : ""}`}
          >
            {panel && (
              <SidebarToggle open={drawer} onClick={toggleSidebar} className={inline ? "lg:hidden" : ""} />
            )}
            {ws && (
              <span className={`flex min-w-0 shrink items-center gap-1.5 ${inline ? "lg:hidden" : ""}`}>
                <WorkspaceSwitcher user={user} workspace={ws} compact />
                <span aria-hidden="true" className="text-line-strong">
                  /
                </span>
              </span>
            )}
            <Breadcrumbs pathname={pathname} missing={missing} repo={shell.repo} workspace={ws?.slug ?? null} />
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                aria-label="Search or jump to"
                onClick={() => setPalette(true)}
                className="flex h-8 items-center gap-2 rounded-md text-faint transition-colors hover:text-muted max-md:w-8 max-md:justify-center max-md:hover:bg-raised md:w-[min(17rem,26vw)] md:border md:border-line md:bg-surface md:px-2.5 md:hover:border-line-strong"
              >
                <Search size={15} className="shrink-0" />
                <span className="hidden grow truncate text-left text-[0.8125rem] md:inline">Search or jump to</span>
                <PaletteKey className="hidden rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line md:inline" />
              </button>
              {/* Your spend this month, or the workspace's for owners and billing managers; on a phone it is on Spend. */}
              {ws && (
                <span className="max-md:hidden">
                  <SpendPill slug={ws.slug} mayWorkspace={ws.role === "owner" || !!ws.org_roles?.includes("billing_manager")} />
                </span>
              )}
              {ws && <AskG1tButton slug={ws.slug} />}
              {/* On a phone, Notifications is in the bottom bar. */}
              <span className="max-md:hidden">
                <NotificationsBell counts={shell.inbox ? { ...shell.inbox, unread: notificationsUnread } : null} />
              </span>
              <CreateMenu shell={shell} />
              {/* Without a workspace there is no dock: the account is here. */}
              {!ws && <AccountMenu user={user} side="bottom" />}
            </div>
          </header>
          {banner}
          <main id="content" tabIndex={-1} {...leaving} className={`min-w-0 grow outline-none ${leaving.className}`}>
            <InMain.Provider value={true}>{children}</InMain.Provider>
          </main>
        </div>
      </div>
      {/* The panel's edge: a rounded frame over the page, with the background beyond it, so what scrolls stays inside. */}
      {!conversation && (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed top-(--frame-top) right-1.5 bottom-(--tabbar-h) left-1.5 z-[35] rounded-[14px] shadow-[0_0_0_1px_var(--color-line),0_0_0_100vmax_var(--color-shell)] md:right-2 ${left}`}
        />
      )}
      {ws && <BottomBar user={user} workspace={ws} pins={shell.pins ?? []} unread={unread} onReselect={panel ? () => setDrawer(true) : undefined} />}
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} repo={shell.repo ? `${shell.repo.namespace}/${shell.repo.name}` : null} />
    </Sheet>
  );
}

/** Create new: a project, an issue in the one you are in, a workspace or a team. */
function CreateMenu({ shell }: { shell: ShellData }) {
  return (
    <DropdownMenu>
      <Hint label="Create new">
        <DropdownMenuTrigger
          aria-label="Create new"
          className="flex h-8 items-center gap-1 rounded-md border border-line px-1.5 text-fg/90 outline-none transition-colors hover:border-line-strong hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised sm:px-2"
        >
          <Plus size={16} />
          <ChevronDown size={13} className="text-muted max-sm:hidden" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-52">
        {shell.repo && (
          <>
            <DropdownMenuLabel className="truncate">In {shell.repo.name}</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link to={`/${shell.repo.namespace}/${shell.repo.name}/issues/new`}>
                <CircleDot />
                New issue
              </Link>
            </DropdownMenuItem>
            {shell.repo.member && (
              <DropdownMenuItem asChild>
                <Link to={`/${shell.repo.namespace}/${shell.repo.name}/plans`}>
                  <ListTree />
                  Plan work
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link to="/?agent=new">
            <Sparkles />
            Put an agent on it
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/new">
            <Box />
            New project
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/new/github">
            <GitBranch />
            Import from GitHub
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <Users />
            New workspace
          </Link>
        </DropdownMenuItem>
        {/* A team in the workspace you are in, for whoever it lets create one. */}
        {shell.workspace &&
          (mayCreateTeams(shell.workspace.team_creation, shell.workspace.role) ? (
            <DropdownMenuItem asChild>
              <Link to={`/${shell.workspace.slug}/-/teams/new`}>
                <UsersRound />
                New team
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <UsersRound />
              New team
              <span className="ml-auto pl-3 text-xs text-faint">Owners only</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
