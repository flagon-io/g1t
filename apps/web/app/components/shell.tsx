import { Activity, BarChart3, Building2, MessagesSquare, Bell, BookMarked, BookOpen, Bot, Box, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleDot, GripVertical, CircleUserRound, Code2, Compass, CreditCard, Fingerprint, GanttChart, Gauge, GitBranch, GitPullRequest, Globe, History, House, Inbox, KanbanSquare, KeyRound, Layers, LayoutDashboard, LayoutGrid, LifeBuoy, ListTree, Lock, LogIn, LogOut, Mail, Menu, Network, Package, PlayCircle, Plug, Plus, Rocket, Search, ServerCog, Settings, ShieldCheck, Scale, Smile, Sparkles, Ticket, TrendingUp, UserRoundKey, Users, UsersRound, Webhook, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useFetcher, useLocation, useNavigation, useRouteLoaderData, useSubmit } from "react-router";

import { type Abilities, type ChatSidebarEntry, type InboxCounts, type WorkspaceAgent, type Membership, type Spike, type User, hasCodeAccess, mayCreateTeams, shownUsername } from "@g1t/contracts";

import { InMain } from "./landmark";
import { CommandPalette, type PaletteCommand, PaletteKey, usePaletteShortcut } from "./command-palette";
import { AgentButton, InboxBell } from "./inbox";
import { PinButton } from "./pin-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Hint } from "./ui/hint";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { StatusDot, useSiteStatus } from "./footer";
import { Logo, Mark } from "./logo";
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
import { type ModeKey, SETTINGS_PAGES, modeOf, sidebarCurrent } from "../lib/workspace-nav";
import { AgentsSidebar } from "./agents-mode";
import { ChatSidebar } from "./chat/sidebar";
import { DocsSidebar } from "./docs/sidebar";
import { HelpMenu, Rail } from "./rail";
import { HomeSidebar } from "./home-sidebar";
import { G1tMark } from "./orchestrator";
import { AvatarSheetButton, MobileTabBar, isConversation, useVisualViewport } from "./mobile";
import { useChatSidebar } from "./chat/actions";
import { unreadTotals } from "../lib/chat";
import { SETTINGS_CAPABILITY, type ViewerAccess, seesSettings } from "../lib/access";
import { VISITOR_LINKS, projectPages } from "../lib/chrome";
import { ACCOUNT_SETTINGS, type AccountSettingsPage, FIRST_SETTINGS_PAGE, accountSettingsPage } from "../lib/account-settings";
import { GithubMark } from "./github";
import { withNext } from "../lib/next";
import { useInviteOnly, useSignUpCopy } from "../lib/registration";
import { STATUS_URL, statusTitle } from "../lib/status";
import { type ShortcutProject, movedPin, recentWith } from "../lib/pins";
import type { AccountMenuData } from "../routes/settings-menu-json";
import { useLiveBadges } from "../lib/notify-client";
import { OwnPresenceDot, OwnPresenceItems, StatusDialog } from "./presence";

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
  /** What is unread in their inbox, for the bell. Absent for a visitor. */
  inbox?: InboxCounts | null;
  /**
   * Chat, for the rail's badge and Home's sidebar: what is unread, and the
   * starred and latest conversations. Null when chat did not answer in time.
   */
  chat?: { unread: number; mentions: number; starred?: ChatSidebarEntry[]; recent?: ChatSidebarEntry[] } | null;
  /** The workspace's agents, g1t first, for Home's and Agents' sidebars; null when not known. */
  agents?: ShellAgent[] | null;
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
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive, isPending }) => {
        const current =
          lit ??
          (isActive || [also ?? []].flat().some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/")));
        return `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current
            ? "bg-raised font-medium text-fg"
            : isPending
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

function WorkspaceSwitcher({ user, shell }: { user: User; shell: ShellData }) {
  const workspace = shell.workspace;
  const current = workspace?.slug;
  const label = workspace ? displayName(workspace) : "Choose a workspace";
  return (
    <DropdownMenu>
      {/* The name goes to the workspace; only the arrows switch it. The
          name gets all the room there is, and the whole of it on hover. */}
      <Hint label={workspace ? `${label} · g1t.sh/${workspace.slug}` : undefined}>
      <Link
        to={current ? `/${current}` : "/workspaces/new"}
        prefetch="intent"
        className="flex h-9 min-w-0 grow items-center gap-2 rounded-md px-2 transition-colors hover:bg-raised"
      >
        {workspace ? (
          <Avatar name={workspace.slug} image={workspace.avatar} size={20} square />
        ) : (
          <span className="size-5 shrink-0 rounded-md border border-dashed border-line-strong" />
        )}
        <span className="min-w-0 truncate text-[0.8125rem] font-medium">{label}</span>
      </Link>
      </Hint>
      <DropdownMenuTrigger
        aria-label="Switch workspace"
        className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised data-[state=open]:text-fg"
      >
        <ChevronsUpDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {workspace && (
          <>
            {/* The workspace's own page: its projects, packages and people. */}
            <DropdownMenuItem asChild>
              <Link to={`/${workspace.slug}`}>
                <LayoutGrid />
                Workspace overview
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`/${workspace.slug}/-/projects`}>
                <Box />
                All projects
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {(user.workspaces ?? []).map((membership) => (
          <Hint key={membership.slug} label={displayName(membership)} side="right">
          <DropdownMenuItem asChild>
            <Link to={`/${membership.slug}`}>
              <Avatar name={membership.slug} image={membership.avatar} size={24} square />
              <span className="flex min-w-0 grow flex-col leading-tight">
                <span className="truncate">{displayName(membership)}</span>
                <span className="truncate font-mono text-[0.6875rem] text-faint">{membership.slug}</span>
              </span>
              <span className="shrink-0 text-[0.6875rem] text-faint capitalize">{membership.role}</span>
              {membership.slug === current ? (
                <Check className="shrink-0 text-accent" />
              ) : (
                <span className="size-4 shrink-0" aria-hidden="true" />
              )}
            </Link>
          </DropdownMenuItem>
          </Hint>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <Plus />
            New workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

function AccountMenu({ user, rail = false }: { user: User; rail?: boolean }) {
  const submit = useSubmit();
  const [open, setOpen] = useState(false);
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
      {rail ? (
        // On the rail: the avatar alone, with a dot that says how others see you (components/presence.tsx).
        <DropdownMenuTrigger
          aria-label={`Account menu for ${shownUsername(user)}`}
          onPointerEnter={prefetch}
          onFocus={prefetch}
          className="relative rounded-full outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-line-strong"
        >
          <Avatar name={user.username} image={user.avatar} size={34} />
          <OwnPresenceDot ring="#0b0b0d" className="absolute -right-0.5 -bottom-0.5" />
        </DropdownMenuTrigger>
      ) : (
      <DropdownMenuTrigger
        aria-label={`Account menu for ${shownUsername(user)}`}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-raised"
      >
        <Avatar name={user.username} image={user.avatar} size={22} />
        <span className="min-w-0 grow truncate text-[0.8125rem] font-medium">{shownUsername(user)}</span>
        <ChevronsUpDown size={14} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align={rail ? "end" : "start"} side={rail ? "right" : "top"} collisionPadding={8} className="w-[17.5rem] p-1.5">
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
    </>
  );
}

/**
 * A workspace's settings pages, which the sidebar drills into: how it is
 * set up and connected (guardrails, secrets, runners, integrations,
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
        <Link to={`/new?workspace=${slug}`} aria-label="New project" className="rounded p-0.5 text-faint hover:bg-raised hover:text-fg">
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

/**
 * The main list, in two parts a rule apart. Above it, what is yours
 * whichever workspace you are in: Mission control, your inbox, and what
 * others have shared with you. Below it, under the workspace's name, the
 * workspace: its overview, its projects, what it builds and runs with
 * across them, then its people, usage, support and settings. One row is
 * lit wherever you are (lib/workspace-nav.ts).
 */
function MainMenu({ user, shell }: { user: User | null; shell: ShellData }) {
  const ws = shell.workspace;
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  // The row lights as the link is followed, not once the page arrives.
  const here = sidebarCurrent(going ?? pathname, ws?.slug ?? null);
  // A visitor browses: no workspace, no projects of their own.
  if (!user) {
    return (
      <nav aria-label="g1t" className={PANEL}>
        <div className="mt-3 space-y-px">
          {VISITOR_LINKS.map((link) => (
            <SidebarLink key={link.to} to={link.to} icon={link.to === "/search" ? <Search size={15} /> : <Compass size={15} />}>
              {link.label}
            </SidebarLink>
          ))}
        </div>
      </nav>
    );
  }
  const shared = shell.shared ?? [];
  return (
    <nav aria-label="g1t" className={PANEL}>
      {/* Yours, in every workspace. Explore, all of g1t, is in the top bar. */}
      <div className="mt-3 space-y-px">
        <SidebarLink to="/" end icon={<House size={15} />} current={here === "mission"}>
          Mission control
        </SidebarLink>
        <SidebarLink to="/inbox" icon={<Inbox size={15} />} count={shell.inbox?.unread ?? undefined} current={here === "inbox"}>
          Inbox
        </SidebarLink>
      </div>
      {shared.length > 0 && (
        <SidebarGroup title="Shared with you" className="mt-3">
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
      )}

      <Rule />
      {ws ? (
        <>
          {/* The workspace the switcher names: its own page first. */}
          <SidebarGroup title={displayName(ws)}>
            <SidebarLink to={`/${ws.slug}`} end icon={<LayoutDashboard size={15} />} current={here === "overview"}>
              Overview
            </SidebarLink>
          </SidebarGroup>
          <div className="mt-3">
            <SidebarProjects slug={ws.slug} shell={shell} current={here === "projects"} />
          </div>

          <Rule />
          <div className="space-y-px">
            <SidebarLink to={`/${ws.slug}/-/agents`} icon={<Bot size={15} />} current={here === "agents"}>
              Agents
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/context`} icon={<Network size={15} />} current={here === "context"}>
              Context
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/memory`} icon={<Brain size={15} />} current={here === "memory"}>
              Memory
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/security`} icon={<ShieldCheck size={15} />} current={here === "security"}>
              Security
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/packages`} icon={<Package size={15} />} current={here === "packages"}>
              Packages
            </SidebarLink>
            {INSIGHTS && (
              <SidebarSoonLink
                to={`/${ws.slug}/-/insights`}
                icon={<TrendingUp size={15} />}
                about={INSIGHTS.summary}
                current={here === "insights"}
              >
                {INSIGHTS.title}
              </SidebarSoonLink>
            )}
            {roadmapIn("Workspace").filter((item) => item.key !== "insights").map((item) => (
              <SidebarSoonLink
                key={item.key}
                to={`/${ws.slug}/-/soon/${item.key}`}
                icon={WORKSPACE_ICONS[item.key] ?? <Sparkles size={15} />}
                about={item.summary}
              >
                {item.title === "Board" ? "Boards" : item.title}
              </SidebarSoonLink>
            ))}
          </div>

          <Rule />
          <div className="space-y-px">
            {/* Who belongs, for every member to see; owners invite and manage there. */}
            <SidebarLink to={`/${ws.slug}/-/people`} icon={<Users size={15} />} current={here === "people"}>
              People
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/teams`} icon={WORKSPACE_ICONS.teams} current={here === "teams"}>
              Teams
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/usage`} icon={<BarChart3 size={15} />} current={here === "usage"}>
              Usage
            </SidebarLink>
            <SidebarLink to="/support" icon={<LifeBuoy size={15} />} current={here === "support"}>
              Support
            </SidebarLink>
            {/* How it is set up and connected, what it pays and its record: a list of their own. */}
            <SidebarLink
              to={ws.role === "owner" ? `/${ws.slug}/-/settings` : `/${ws.slug}/-/repositories`}
              icon={<Settings size={15} />}
              drill
              current={here === "settings"}
            >
              Settings
            </SidebarLink>
          </div>
        </>
      ) : (
        <SidebarGroup title="Projects">
          <p className="px-2 py-1 text-xs text-faint">None yet.</p>
        </SidebarGroup>
      )}
    </nav>
  );
}

/** Insights, coming: the workspace's own page says what it will be. */
const INSIGHTS = roadmapItem("insights");

/** A workspace's settings, drilled into from Settings in the main list. */
function SettingsMenu({ slug, owner }: { slug: string; owner: boolean }) {
  return (
    <nav aria-label="Workspace settings" className={PANEL}>
      <BackRow to={`/${slug}`} label="Settings" context={slug} />
      <div className="mt-2 space-y-px">
        {owner && (
          <SidebarLink to={`/${slug}/-/settings`} icon={<Settings size={15} />}>
            General
          </SidebarLink>
        )}
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
        <SidebarLink to={`/${slug}/-/rules`} icon={<Scale size={15} />}>
          Rules
        </SidebarLink>
      </div>
      <SidebarGroup title="Agents and runs" className="mt-3">
        <SidebarLink to={`/${slug}/-/guardrails`} icon={<Gauge size={15} />}>
          Guardrails
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/secrets`} icon={<Lock size={15} />}>
          Secrets and variables
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/actions`} icon={<PlayCircle size={15} />}>
          Actions
        </SidebarLink>
        {owner && (
          <SidebarLink to={`/${slug}/-/runners`} icon={<ServerCog size={15} />}>
            Runners
          </SidebarLink>
        )}
      </SidebarGroup>
      <SidebarGroup title="Connections" className="mt-3">
        <SidebarLink to={`/${slug}/-/integrations`} icon={<Plug size={15} />}>
          Integrations
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/webhooks`} icon={<Webhook size={15} />}>
          Webhooks
        </SidebarLink>
      </SidebarGroup>
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/billing`} icon={<CreditCard size={15} />}>
          Billing and plans
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/audit`} icon={<History size={15} />}>
          Audit log
        </SidebarLink>
      </div>
    </nav>
  );
}

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
            <SidebarLink to={`${base}/settings/dependencies`} icon={<Network size={15} />}>
              Dependencies
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
 * Signing in and signing up, in place of the account for a visitor. Signing
 * in brings them back to the page they are on.
 */
/** Help, status and the fine print under a visitor's sign-in buttons. */
function VisitorLinks() {
  const status = useSiteStatus();
  const quiet = `${LEGAL_LINK} hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60`;
  const dot = (
    <span aria-hidden="true" className="text-[0.625rem] text-line-strong">
      ·
    </span>
  );
  return (
    // Two short rows, so a narrow sidebar never starts a line with a dot.
    <nav aria-label="About g1t" className="pt-0.5">
      <div className="flex items-center gap-0.5">
        <a href={STATUS_URL} className={`${quiet} gap-1.5`}>
          <StatusDot state={status?.overall.state ?? null} />
          Status
        </a>
        {dot}
        <Link to="/support" className={quiet}>
          Support
        </Link>
      </div>
      <div className="flex items-center gap-0.5">
        {LEGAL_LINKS.map(([label, to], index) => (
          <span key={to} className="flex items-center gap-0.5">
            {index > 0 && dot}
            <Link to={to} className={quiet}>
              {label}
            </Link>
          </span>
        ))}
      </div>
    </nav>
  );
}

function VisitorPanel() {
  const { pathname, search } = useLocation();
  const signUp = useSignUpCopy();
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-muted">Sign in to open issues, review pull requests and run agents.</p>
      <div className="grid grid-cols-2 gap-2">
        <Link
          to={withNext("/login", pathname + search)}
          className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-line text-[0.8125rem] font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
        >
          <LogIn size={14} />
          Sign in
        </Link>
        <Link
          to={withNext("/register", pathname + search)}
          className="flex h-9 items-center justify-center rounded-md bg-fg text-[0.8125rem] font-medium text-bg transition-colors hover:bg-white"
        >
          {signUp.primary}
        </Link>
      </div>
      <VisitorLinks />
    </div>
  );
}

function Sidebar({
  user,
  shell,
  missing = false,
  onFind,
  onClose,
  rail = false,
}: {
  user: User | null;
  shell: ShellData;
  /** The page is a 404: the address names nothing the viewer can see. */
  missing?: boolean;
  onFind: () => void;
  /** In the sheet on a small screen: closing it, at the end of the top row. */
  onClose?: () => void;
  /**
   * Beside the rail, as Code's sidebar: code only, under a Code heading.
   * The workspace, its settings and the account are the rail's.
   */
  rail?: boolean;
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
  const inSettings = !lost && ws != null && SETTINGS_PAGE.exec(target)?.[1]?.toLowerCase() === ws.slug;
  const inAccount = !lost && target === "/settings" || target.startsWith("/settings/");
  const active = shell.repo;
  // In a repository, or on the way into one, its own list.
  const repoPath = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(target);
  const reserved = new Set(["settings", "explore", "search", "new", "u", "pricing", "avatars", "workspaces", "login", "logout", "register", "verify", "forgot", "reset", "device", "oauth", "policies", "security", "support", "status", "invite", "inbox", ".well-known"]);
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
          member: (user?.workspaces ?? []).some((m) => m.slug === targetRepo.namespace.toLowerCase()),
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

  // The way from the main list to the one shown.
  const trail: Level[] = [{ key: "main", node: rail && user && ws ? <CodeMenu shell={shell} slug={ws.slug} /> : <MainMenu user={user} shell={shell} /> }];
  if (rail && !menuRepo) {
    // Code's own list: nothing to drill into but a project.
  } else if (user && inAccount && !rail) {
    trail.push({ key: "account", node: <AccountSettingsMenu username={user.username} /> });
  } else if (ws && inSettings && !rail) {
    trail.push({ key: `settings:${ws.slug}`, node: <SettingsMenu slug={ws.slug} owner={ws.role === "owner"} /> });
  } else if (menuRepo) {
    const key = `repo:${menuRepo.namespace}/${menuRepo.name}`.toLowerCase();
    // Out of a project: to its workspace's projects when they are yours.
    const home = (user?.workspaces ?? []).find((m) => m.slug === menuRepo.namespace.toLowerCase());
    const back = !user
      ? { to: "/explore", label: "Explore" }
      : home
        ? { to: `/${home.slug}/-/projects`, label: "All projects" }
        : { to: "/", label: "Home" };
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
      {/* The same height and rule as the top bar, so the two read as one line. */}
      {rail ? (
        <ModeHeader title="Code" onClose={onClose} />
      ) : (
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2 pl-2.5">
        {user ? (
          <>
            {/* The 1 alone beside the workspace: a square hover the height of the
                switcher, the mark as tall as the workspace avatar. */}
            <Link to="/" aria-label="g1t home" className="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-raised">
              <Mark tight className="h-4 w-auto" />
            </Link>
            <span className="shrink-0 text-line-strong" aria-hidden="true">
              /
            </span>
            <WorkspaceSwitcher user={user} shell={shell} />
          </>
        ) : (
          <Link to="/" aria-label="g1t home" className="mr-auto flex h-9 items-center rounded-md px-2 transition-colors hover:bg-raised">
            <Logo className="text-[1.25rem]" />
          </Link>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </button>
        )}
      </div>
      )}
      <div className="px-2 pt-3">
        <button
          type="button"
          onClick={onFind}
          className="flex h-9 w-full items-center gap-2 rounded-md bg-surface px-2.5 text-[0.8125rem] text-faint ring-1 ring-line transition-colors hover:text-muted hover:ring-line-strong"
        >
          <Search size={14} />
          <span className="grow text-left">Search or jump to…</span>
          <PaletteKey className="rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line" />
        </button>
      </div>
      <Drill trail={trail} />
      {/* The account, or signing in, as one row at the very bottom; beside the rail, the rail has it. */}
      {!rail && (
        <div className="shrink-0 border-t border-line p-2">
          {user ? <AccountMenu user={user} /> : <VisitorPanel />}
        </div>
      )}
    </div>
  );
}

/** A mode's sidebar heading: the same height and rule as the top bar, with a way to close the phone's sheet. */
export function ModeHeader({ title, action, onClose }: { title: ReactNode; action?: ReactNode; onClose?: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-4">
      <h2 className="min-w-0 grow truncate text-[0.9375rem] font-semibold">{title}</h2>
      {action}
      {onClose && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * Code's sidebar (beside the rail): only code. Its Overview (Mission
 * control's code panels), the projects, what spans them, and what is
 * coming. The workspace's people, money and settings are Workspace's;
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
      <div className="mt-3 space-y-px">
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
const WORKSPACE_SETTINGS = ["settings", "repositories", "tokens", "personal-access-tokens", "secrets", "actions", "runners", "webhooks", "emoji"];

/**
 * The Workspace mode's sidebar: the workspace itself, for every member.
 * Its overview, people, money, connections, policies and record, then its
 * settings as a list of their own. Owner-only pages stay owner-only.
 */
export function WorkspaceSidebar({ slug, owner, onClose }: { slug: string; owner: boolean; onClose?: () => void }) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const path = going ?? pathname;
  const page = path.startsWith(`/${slug}/-/`) ? path.slice(`/${slug}/-/`.length) : "";
  const top = page.split("/")[0] ?? "";
  const at = (...pages: string[]) => pages.some((p) => page === p || page.startsWith(`${p}/`));
  const inSettings = WORKSPACE_SETTINGS.includes(top);
  const main = (
    <nav aria-label="Workspace" className={PANEL}>
      <div className="mt-3 space-y-px">
        <SidebarLink to={`/${slug}/-/workspace`} icon={<LayoutGrid size={15} />} current={at("workspace")}>
          Overview
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/people`} icon={<Users size={15} />} current={at("people")}>
          People
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/teams`} icon={<UsersRound size={15} />} current={at("teams")}>
          Teams
        </SidebarLink>
      </div>
      <SidebarGroup title="Usage and billing" className="mt-3">
        <SidebarLink to={`/${slug}/-/usage`} icon={<BarChart3 size={15} />} current={at("usage", "gateway")}>
          Usage
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/billing`} icon={<CreditCard size={15} />} current={at("billing")}>
          Billing and plans
        </SidebarLink>
      </SidebarGroup>
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
        {owner && (
          <SidebarLink to={`/${slug}/-/runners`} icon={<ServerCog size={15} />}>
            Runners
          </SidebarLink>
        )}
      </SidebarGroup>
    </nav>
  );
  const trail: Level[] = [{ key: "workspace", node: main }];
  if (inSettings) trail.push({ key: "workspace:settings", node: settings });
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Workspace" onClose={onClose} />
      <Drill trail={trail} />
    </div>
  );
}

/** Your own settings, beside the rail: under the account menu, not any workspace's. */
export function AccountSidebar({ username, onClose }: { username: string; onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ModeHeader title="Your account" onClose={onClose} />
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
  dependencies: "Dependencies",
  code: "Files",
  secrets: "Secrets and variables",
  settings: "Settings",
  people: "People",
  projects: "Projects",
  teams: "Teams",
  tokens: "Access tokens",
  "personal-access-tokens": "Personal access tokens",
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
  docs: "Docs",
  home: "Home",
  "code-access": "Code access",
  overview: "Overview",
  workspace: "Workspace",
};

/** Settings pages whose name differs from the section's of the same word. */
const SETTINGS_SECTIONS: Record<string, string> = { branches: "Branches and merging", actions: "Actions" };

/** Where the page is, as a trail of links: workspace / repository / section. */
function Breadcrumbs({ pathname, missing, repo }: { pathname: string; missing?: boolean; repo?: ShellData["repo"] }) {
  // A 404 names nothing from the address, unless the project is real and
  // visible and only something inside it is missing.
  const visibleRepo = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(pathname);
  if (missing && !(visibleRepo && sameRepo(repo ?? null, { namespace: visibleRepo[1]!, name: visibleRepo[2]! }))) {
    return <span className="text-sm font-medium">Not found</span>;
  }
  const parts = pathname.split("/").filter(Boolean);
  const reserved = ["settings", "explore", "new", "search", "workspaces", "policies", "security", "support", "status", "invite", "inbox"];
  if (parts.length === 0) return <span className="text-sm font-medium">Home</span>;
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
      inbox: "Inbox",
    };
    return <span className="text-sm font-medium">{words[parts[0]!]}</span>;
  }
  // A person's profile, by their handle.
  if (parts[0] === "u" && parts[1]) return <ProfileCrumb username={parts[1]} />;
  const [owner, second, third, fourth] = parts;
  const trail: Crumb[] = [{ label: owner!, to: `/${owner}`, mono: true }];
  if (second === "-") {
    const page = `/${owner}/-/${third}`;
    if (third && SETTINGS_PAGE.test(page)) {
      trail.push({ label: "Settings", to: `/${owner}/-/settings` });
      trail.push({ label: third === "settings" ? "General" : (SECTIONS[third] ?? third), to: page });
    } else if (third) trail.push({ label: SECTIONS[third] ?? third, to: page });
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
function commandsFor(user: User | null, shell: ShellData, here: string, signUpLabel = "Sign up"): Command[] {
  if (!user) return visitorCommands(shell, here, signUpLabel);
  const commands: Command[] = [
    { label: "Home", to: "/", icon: <House size={15} /> },
    ...(shell.workspace
      ? [
          { label: "Chat", to: `/${shell.workspace.slug}/-/chat`, icon: <MessagesSquare size={15} /> },
          { label: "Agents", to: `/${shell.workspace.slug}/-/agents`, icon: <Sparkles size={15} /> },
          ...(hasCodeAccess(shell.workspace) ? [{ label: "Code overview", to: `/${shell.workspace.slug}/-/overview`, icon: <Code2 size={15} /> }] : []),
          { label: "Workspace", hint: "People, billing, policies, settings", to: `/${shell.workspace.slug}/-/workspace`, icon: <Building2 size={15} /> },
        ]
      : []),
    ...(shell.repos.length > 0
      ? [{ label: "Put an agent on it", hint: "Open an issue and assign g1t", to: "/?agent=new", icon: <Sparkles size={15} /> }]
      : []),
    { label: "Explore repositories", to: "/explore", icon: <Compass size={15} /> },
    { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
    { label: "Inbox", hint: "What needs you", to: "/inbox", icon: <Bell size={15} /> },
    { label: "New project", to: "/new", icon: <Plus size={15} /> },
    { label: "New workspace", to: "/workspaces/new", icon: <Plus size={15} /> },
    { label: "Your settings", to: FIRST_SETTINGS_PAGE, icon: <Settings size={15} /> },
    ...(Object.keys(ACCOUNT_SETTINGS) as AccountSettingsPage[])
      .filter((page) => page !== "profile")
      .map((page) => ({ label: ACCOUNT_SETTINGS[page].title, hint: "Your settings", to: `/settings/${page}`, icon: <Settings size={15} /> })),
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

/** What the palette offers a visitor: browsing, the project they are in, and signing in. */
function visitorCommands(shell: ShellData, here: string, signUpLabel: string): Command[] {
  const commands: Command[] = [];
  const repo = shell.repo;
  if (repo) {
    const base = `/${repo.namespace}/${repo.name}`;
    const name = `${repo.namespace}/${repo.name}`;
    commands.push(
      { label: "Overview", hint: name, to: base, icon: <LayoutGrid size={15} /> },
      { label: "Code", hint: name, to: `${base}/code`, icon: <Code2 size={15} /> },
      { label: "Issues", hint: name, to: `${base}/issues`, icon: <CircleDot size={15} /> },
      { label: "Pull requests", hint: name, to: `${base}/pulls`, icon: <GitPullRequest size={15} /> },
      { label: "Commits", hint: name, to: `${base}/commits`, icon: <History size={15} /> },
    );
  }
  commands.push(
    { label: "Explore", hint: "Public projects", to: "/explore", icon: <Compass size={15} /> },
    { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
    { label: "Pricing", to: "/pricing", icon: <CreditCard size={15} /> },
    { label: "Documentation", to: "https://docs.g1t.sh/", icon: <BookOpen size={15} /> },
    { label: "Sign in", to: withNext("/login", here), icon: <LogIn size={15} /> },
    { label: signUpLabel, to: withNext("/register", here), icon: <Plus size={15} /> },
  );
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
        className="flex h-9 items-center gap-1.5 rounded-md border border-line px-2 text-sm text-fg/90 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg sm:px-2.5"
      >
        <G1tMark size={18} />
        <span className="hidden sm:inline">Ask g1t</span>
      </Link>
    </Hint>
  );
}

/** The mode's sidebar beside the rail: a shade lighter than the page. */
const SIDEBAR_BOX = "h-full border-r border-line bg-[color-mix(in_srgb,var(--color-surface)_70%,var(--color-bg))]";

/**
 * Which sidebar sits beside the rail: each mode's own, or none (the Inbox,
 * which is a page of its own, and g1t's public pages, such as a profile,
 * which are no workspace's and carry their own left column). Without a
 * workspace (a visitor), the one sidebar there always was.
 */
function sidebarFor(mode: ModeKey | null): Panel | null {
  if (mode == null) return "code";
  if (mode === "inbox" || mode === "site") return null;
  return mode;
}

/** The sidebars that sit beside the rail, one per mode that has one. */
type Panel = "home" | "chat" | "docs" | "agents" | "code" | "workspace" | "account";

/**
 * The app: a sidebar with the workspace, its repositories and the sections
 * of the one being looked at; a slim bar with search and the account; and
 * the page. A visitor who is not signed in gets the same frame, with
 * Explore and Search in place of the workspace, and signing in in place of
 * the account.
 */
export function AppShell({
  user,
  shell,
  missing = false,
  banner,
  children,
}: {
  user: User | null;
  shell: ShellData;
  /** The page is a 404 (see Sidebar). */
  missing?: boolean;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const here = pathname + search;
  const signUpLabel = useSignUpCopy().primary;
  const commands = useMemo(() => commandsFor(user, shell, here, signUpLabel), [user, shell, here, signUpLabel]);

  // A new page closes the drawer on small screens.
  useEffect(() => setDrawer(false), [pathname]);
  // Mission control's code, fetched while the browser is idle, so going
  // home never waits on it (routes/home.tsx).
  useEffect(() => {
    if (!user) return;
    const load = () => void import("./mission-control").catch(() => undefined);
    const idle = (window as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    if (idle) idle(load);
    else setTimeout(load, 1500);
  }, [user]);
  usePaletteShortcut(() => setPalette((open) => !open));
  const leaving = useLeaving();
  useVisualViewport();

  // The rail and the mode's sidebar (docs/WORKSPACE.md, "Shell"), for
  // someone in a workspace. A visitor, or someone with none, keeps the one
  // sidebar.
  const going = useNavigation().location?.pathname;
  const ws = user ? shell.workspace : null;
  const mode: ModeKey | null = ws ? modeOf(going ?? pathname, ws.slug) : null;
  const panel = ws ? sidebarFor(mode) : "code";
  const code = ws ? hasCodeAccess(ws) : true;
  const { sidebar: chatSidebar } = useChatSidebar();
  // Notify: the feed socket's live counts (lib/notify-client.ts) once it has them; the page's until then.
  const live = useLiveBadges(ws?.slug);
  const chatUnread = chatSidebar
    ? unreadTotals(chatSidebar.entries)
    : live?.chat != null
      ? { unread: live.chat, mentions: live.mentions ?? 0 }
      : (shell.chat ?? { unread: 0, mentions: 0 });
  const inboxUnread = live?.inbox ?? shell.inbox?.unread ?? 0;
  const sidebarNode = (inSheet: boolean) => {
    const close = inSheet ? () => setDrawer(false) : undefined;
    const find = () => {
      if (inSheet) setDrawer(false);
      setPalette(true);
    };
    if (!ws || !user || panel === "code") {
      return <Sidebar user={user} shell={shell} missing={missing} onFind={find} onClose={close} rail={Boolean(ws && user)} />;
    }
    switch (panel) {
      case "home":
        return <HomeSidebar slug={ws.slug} shell={shell} code={code} onFind={find} header={<ModeHeader title="Home" onClose={close} />} />;
      case "chat":
        return <ChatSidebar slug={ws.slug} />;
      case "docs":
        return <DocsSidebar slug={ws.slug} onClose={close} />;
      case "agents":
        return <AgentsSidebar slug={ws.slug} shellAgents={shell.agents ?? null} code={code} owner={ws.role === "owner"} />;
      case "workspace":
        return <WorkspaceSidebar slug={ws.slug} owner={ws.role === "owner"} onClose={close} />;
      case "account":
        return <AccountSidebar username={user.username} onClose={close} />;
      default:
        return null;
    }
  };
  const rail =
    user && ws ? (
      <Rail
        user={user}
        workspace={ws}
        unread={{ inbox: inboxUnread, chat: chatUnread.unread, mentions: chatUnread.mentions }}
        help={<HelpMenu />}
        account={<AccountMenu user={user} rail />}
      />
    ) : null;
  const pad = rail ? (panel ? "lg:pl-[21rem]" : "lg:pl-20") : "lg:pl-64";
  // On a phone (below 768px): the tab bar, and a conversation full screen.
  const conversation = isConversation(going ?? pathname);
  const tabs = Boolean(user && ws) && !conversation;

  return (
    // The phone's menu is a sheet: a dialog that holds focus, closes on
    // Escape or a tap outside, and gives focus back to the menu button.
    <Sheet open={drawer} onOpenChange={setDrawer}>
    <div className="min-h-dvh">
      <Progress />
      <aside className="fixed inset-y-0 left-0 z-40 hidden lg:flex">
        {rail}
        {panel && <div className={`${SIDEBAR_BOX} w-64`}>{sidebarNode(false)}</div>}
      </aside>
      <SheetContent
        side="left"
        showClose={false}
        aria-describedby={undefined}
        // Focus would land on the workspace's avatar and open its hint over
        // the sidebar's heading; the sheet itself takes it instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className={`lg:hidden ${rail ? `flex flex-row ${panel ? "w-[21rem] max-w-[92vw] sm:max-w-[21rem]" : "w-20 sm:max-w-20"}` : "w-72 max-w-[85vw] sm:max-w-72"}`}
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {rail}
        {panel && <div className={`min-w-0 grow ${rail ? SIDEBAR_BOX : ""}`}>{sidebarNode(true)}</div>}
      </SheetContent>

      <div className={`flex min-h-dvh min-w-0 flex-col ${pad} ${tabs ? "pb-(--tabbar-h)" : ""}`}>
        <header
          className={`sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-bg/85 pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur sm:px-6 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] ${mode === "chat" ? "lg:hidden" : ""} ${conversation ? "max-md:hidden" : ""}`}
        >
          {/* A phone: the workspace's avatar opens everything else (components/mobile.tsx). */}
          {user && ws && <AvatarSheetButton user={user} workspace={ws} />}
          <SheetTrigger
            aria-label="Open menu"
            className={`rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg lg:hidden ${user && ws ? "max-md:hidden" : ""}`}
          >
            <Menu size={18} />
          </SheetTrigger>
          <Breadcrumbs pathname={pathname} missing={missing} repo={shell.repo} />
          <div className="ml-auto flex items-center gap-1.5">
            {/* Search lives in the sidebar ("Search or jump to"); with the sidebar folded away, this opens the same palette. */}
            <button
              type="button"
              aria-label="Search or jump to"
              onClick={() => setPalette(true)}
              className="flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
            >
              <Search size={16} />
            </button>
            {/* All of g1t's public projects: not any one workspace's, so here, not in the sidebar. */}
            <NavLink
              to="/explore"
              prefetch="intent"
              aria-label="Explore"
              className={({ isActive }) =>
                `flex h-9 items-center gap-1.5 rounded-md px-2 text-sm transition-colors hover:bg-raised hover:text-fg sm:px-2.5 ${user ? "max-md:hidden" : ""} ${isActive ? "text-fg" : "text-muted"}`
              }
            >
              <Compass size={16} className="sm:hidden" />
              <span className="hidden sm:inline">Explore</span>
            </NavLink>
            <a
              href="https://docs.g1t.sh/"
              className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg sm:block"
            >
              Docs
            </a>
            {user && (
              <>
                {shell.workspace ? <AskG1tButton slug={shell.workspace.slug} /> : <AgentButton />}
                {/* On a phone the Inbox is a tab. */}
                <span className={shell.workspace ? "max-md:hidden" : undefined}>
                  <InboxBell counts={shell.inbox ? { ...shell.inbox, unread: inboxUnread } : null} />
                </span>
              </>
            )}
            {!user ? (
              // The sidebar has these too, but on a phone it is folded away.
              <Link
                to={withNext("/login", here)}
                className="flex h-9 items-center rounded-md bg-fg px-3 text-sm font-medium text-bg transition-colors hover:bg-white lg:hidden"
              >
                Sign in
              </Link>
            ) : (
            <>
            {/* Room between what comes in (the inbox) and what you make. */}
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger
                    aria-label="Create new"
                    className="flex h-9 items-center gap-1 rounded-md border border-line px-2 text-fg/90 outline-none transition-colors hover:border-line-strong hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised"
                  >
                    <Plus size={16} />
                    <ChevronDown size={13} className="text-muted" />
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Create new…</TooltipContent>
              </Tooltip>
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
                {/* A team in the workspace the sidebar is about, for whoever it lets create one. */}
                {shell.workspace &&
                  (mayCreateTeams(shell.workspace.team_creation, shell.workspace.role) ? (
                    <DropdownMenuItem asChild>
                      <Link to={`/${shell.workspace.slug}/-/teams/new`}>
                        <UsersRound />
                        New team
                      </Link>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem disabled title="Only owners can create teams in this workspace.">
                      <UsersRound />
                      New team
                      <span className="ml-auto pl-3 text-xs text-faint">Owners only</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            </>
            )}
          </div>
        </header>
        {banner}
        <main id="content" tabIndex={-1} {...leaving} className={`min-w-0 grow outline-none ${leaving.className}`}>
          <InMain.Provider value={true}>{children}</InMain.Provider>
        </main>
      </div>
      {user && ws && <MobileTabBar workspace={ws} unread={{ inbox: inboxUnread, chat: chatUnread.unread, mentions: chatUnread.mentions }} />}
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        commands={commands}
        repo={shell.repo ? `${shell.repo.namespace}/${shell.repo.name}` : null}
      />
    </div>
    </Sheet>
  );
}
