import { useSidebarLocation } from "../lib/use-sidebar-location";
import { Check, ChevronDown, Compass, LayoutGrid, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import { type Membership, type User, hasCodeAccess } from "@g1t/contracts";

import { AppsLauncher, appIcon, pinnedApp, useAppPins } from "./apps";
import { Mark } from "./logo";

import { Avatar } from "./ui/avatar";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Kbd } from "./ui/kbd";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { type PinnableApp, appOf, barApps } from "../lib/apps";
import { cn } from "../lib/cn";
import { PALETTE_KEY, modKeyLabel, shortcutsKeyLabel } from "../lib/shortcut";
import { type ModeKey, homePagePath, modeHome, modeOf } from "../lib/workspace-nav";

type Badge = { count: number; loud: boolean } | null;

/** A count on an icon: loud (the accent) for what waits on you, quiet for the rest. */
export function CountBadge({ count, loud, className }: { count: number; loud: boolean; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "absolute -top-1 -right-1.5 min-w-4.5 rounded-full px-1 text-center text-[0.625rem] leading-4.5 font-bold tabular-nums ring-2 ring-rail",
        loud ? "bg-accent text-bg" : "bg-line-strong text-fg",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/**
 * The workspace you are in and the way to another: its avatar, its name
 * and a chevron, opening the workspace itself, its people and settings,
 * your workspaces and a new one; your own account is its own menu. `bar` sits in the app
 * bar after g1t's mark, lit while you are in People or Workspace; `row`
 * heads the drawer; `compact` starts a phone's top bar.
 */
export function WorkspaceSwitcher({
  user,
  workspace,
  variant = "row",
  current = false,
}: {
  user: User;
  workspace: Membership;
  variant?: "bar" | "row" | "compact";
  /** You are on one of the workspace's own pages: People, or its settings. */
  current?: boolean;
}) {
  const slug = workspace.slug;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${displayName(workspace)}: switch workspace`}
        data-current={current || undefined}
        className={cn(
          "flex min-w-0 items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
          variant === "bar" &&
            "h-8.5 shrink-0 gap-2 px-1.5 hover:bg-sidebar-accent/60 data-[current=true]:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
          variant === "row" && "h-9 grow gap-2 px-1.5 hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
          variant === "compact" && "h-8 shrink-0 gap-1.5 px-1 hover:bg-raised data-[state=open]:bg-raised max-md:h-11 max-sm:gap-1",
        )}
      >
        <Avatar name={slug} image={workspace.avatar} size={variant === "row" ? 26 : 22} square />
        <span
          className={cn(
            "min-w-0 truncate font-semibold",
            variant === "bar" && "max-w-44 text-sm max-lg:hidden",
            variant === "row" && "text-[0.875rem]",
            variant === "compact" && "text-sm max-sm:hidden",
          )}
        >
          {displayName(workspace)}
        </span>
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <DropdownMenuItem asChild className="gap-3 px-2 py-2">
          <Link to={modeHome("workspace", slug)}>
            <Avatar name={slug} image={workspace.avatar} size={36} square />
            <span className="flex min-w-0 grow flex-col leading-tight">
              <span className="truncate text-sm font-medium text-fg">{displayName(workspace)}</span>
              <span className="truncate font-mono text-xs text-muted">g1t.sh/{slug}</span>
              <span className="mt-0.5 text-xs text-faint capitalize">{workspace.role}</span>
            </span>
          </Link>
        </DropdownMenuItem>
        {/* The workspace's own pages, which were the rail's foot: who is in it, and how it is run. */}
        <DropdownMenuItem asChild>
          <Link to={modeHome("people", slug)}>
            {appIcon("people", 16)}
            People
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={modeHome("workspace", slug)}>
            {appIcon("workspace", 16)}
            Workspace settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        {(user.workspaces ?? []).map((membership) => (
          <DropdownMenuItem key={membership.slug} asChild>
            <Link to={homePagePath(membership.slug)}>
              <Avatar name={membership.slug} image={membership.avatar} size={24} square />
              <span className="flex min-w-0 grow flex-col leading-tight">
                <span className="truncate">{displayName(membership)}</span>
                <span className="truncate font-mono text-[0.6875rem] text-faint">{membership.slug}</span>
              </span>
              {membership.slug === slug ? <Check className="shrink-0 text-accent" /> : <span className="size-4 shrink-0" aria-hidden="true" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <Plus />
            New workspace
          </Link>
        </DropdownMenuItem>
        {/* Only the workspace and switching between them: your own profile and settings are your account menu's, at the bar's other end. */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keyboard shortcuts, as the account menu lists them. */
function shortcuts(palette: string, keys: string, sidebar: string): [string, string][] {
  return [
    [palette, "Search, jump anywhere, or run a command"],
    [keys, "Show these shortcuts (? does too)"],
    [sidebar, "Show or hide the sidebar"],
    ["Esc", "Close a menu, dialog or panel"],
    ["Enter", "Send a message in Chat"],
    ["Shift Enter", "A new line in a message"],
    ["@", "Mention a person or a team"],
    ["↑ ↓ then Tab", "Choose a suggestion"],
    ["Alt ↑ ↓", "Move a pinned project in Code's sidebar"],
  ];
}

/** The sidebar's shortcut, as this computer writes it. */
export function sidebarKeyLabel(platform: string | null): string {
  return modKeyLabel(platform, "B");
}

/** The keyboard's shortcuts, opened from the account menu. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const platform = typeof navigator === "undefined" ? null : navigator.platform;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Everywhere in g1t, and in Chat.</DialogDescription>
        </DialogHeader>
        <Card asChild tone="plain" radius="lg" divided>
          <dl>
            {shortcuts(PALETTE_KEY, shortcutsKeyLabel(platform), sidebarKeyLabel(platform)).map(([key, what]) => (
              <div key={key} className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
                <dt className="text-fg-soft">{what}</dt>
                <dd>
                  <Kbd className="px-1.5 py-0.5 font-sans text-xs whitespace-nowrap text-fg ring-line-strong">{key}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </DialogContent>
    </Dialog>
  );
}

/** One tab of the app bar: a rounded pill, the current one filled. */
const TAB =
  "relative flex h-8.5 shrink-0 items-center gap-2 rounded-lg text-[0.875rem] text-muted outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-fg data-[state=open]:bg-sidebar-accent data-[state=open]:text-fg [&_svg]:shrink-0";

/** What is unread on a tab: beside its name when it has one, on its icon when it is the icon alone. */
function TabCount({ badge }: { badge: Badge }) {
  if (!badge || badge.count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "min-w-4.5 rounded-full px-1 text-center text-[0.625rem] leading-4.5 font-bold tabular-nums",
        "max-xl:absolute max-xl:-top-0.5 max-xl:-right-0.5 max-xl:ring-2 max-xl:ring-sidebar",
        badge.loud ? "bg-accent text-bg" : "bg-line-strong text-fg",
      )}
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}

/**
 * One built-in app: its icon and its name. Below 1280px the name steps
 * aside for the icon alone, and a hint says it on hover instead.
 */
function AppTab({ to, label, icon, current, badge }: { to: string; label: string; icon: ReactNode; current: boolean; badge?: Badge }) {
  const unread = badge && badge.count > 0 ? `, ${badge.count} unread` : "";
  return (
    <li className="flex">
      <Hint label={label} side="bottom" contentClassName="xl:hidden">
        <Link to={to} prefetch="intent" aria-current={current ? "page" : undefined} className={cn(TAB, "px-2 xl:px-2.5")}>
          <span className="flex [&_svg]:size-4.25">{icon}</span>
          <span className="max-xl:sr-only">
            {label}
            {unread && <span className="sr-only">{unread}</span>}
          </span>
          <TabCount badge={badge ?? null} />
        </Link>
      </Hint>
    </li>
  );
}

/** An icon alone in the app bar (a pinned app, Explore), its name in the hint. */
function IconTab({ to, label, icon, current }: { to: string; label: string; icon: ReactNode; current: boolean }) {
  return (
    <li className="flex">
      <Hint label={label} side="bottom">
        <Link to={to} prefetch="intent" aria-label={label} aria-current={current ? "page" : undefined} className={cn(TAB, "w-8.5 justify-center")}>
          {icon}
        </Link>
      </Hint>
    </li>
  );
}

/** The Apps icon after the pinned apps, and the launcher it opens under it. */
function AppsButton({ slug, pins, onToggle, current }: { slug: string; pins: PinnableApp[]; onToggle: (app: PinnableApp) => void; current: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex">
      <Popover open={open} onOpenChange={setOpen}>
        <Hint label="Apps" side="bottom">
          <PopoverTrigger aria-label="Apps" aria-current={current ? "page" : undefined} className={cn(TAB, "w-8.5 justify-center")}>
            <LayoutGrid size={17} />
          </PopoverTrigger>
        </Hint>
        <PopoverContent side="bottom" align="start" sideOffset={8} aria-label="Apps" className="w-92 p-2.5">
          <AppsLauncher slug={slug} pins={pins} onToggle={onToggle} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/**
 * The app bar across the top of the window, from 768px: g1t's mark, which
 * leads to Home; the workspace you are in, with People and its settings in
 * its menu; then the built-in apps as tabs (Home, Work with its sessions,
 * Chat, Code for a member with Code access, Artifacts and Routines) with
 * what is unread on them; the apps you pinned and the Apps launcher; and
 * Explore, g1t beyond your workspaces. What sits at its end (search, Ask,
 * the bell, Create new and your account) is the shell's: `end`. The tab you
 * are in is filled, and which that is follows the address, so it changes
 * the moment a link is pressed. A phone has the bottom bar instead
 * (components/mobile.tsx).
 */
export function AppBar({
  user,
  workspace,
  mode,
  pins: saved,
  unread,
  end,
}: {
  user: User;
  workspace: Membership;
  /** The mode the shell is in, when it knows more than the address (`browse`, lib/workspace-nav.ts `shellMode`). */
  mode?: ModeKey;
  /** The apps pinned to this person's bar in this workspace, as saved. */
  pins: PinnableApp[];
  unread: { notifications: number; chat: number; mentions: number };
  end: ReactNode;
}) {
  const { pathname: path } = useSidebarLocation();
  const here = mode ?? modeOf(path, workspace.slug);
  const slug = workspace.slug;
  // A member without Code access has no Code; Work is every member's, its sessions in it.
  const code = hasCodeAccess(workspace);
  const { pins, toggle } = useAppPins(slug, saved);
  const badges: Partial<Record<ModeKey, Badge>> = {
    chat: { count: unread.mentions > 0 ? unread.mentions : unread.chat, loud: unread.mentions > 0 },
  };
  const shown = pins.map((key) => pinnedApp(key, slug)).filter((app) => app != null);
  // A pinned app is current on its own page and the pages under it.
  const at = (to: string) => path === to || path.startsWith(`${to}/`);
  const onPin = shown.some((app) => at(app.to));
  return (
    <header
      data-slot="app-bar"
      className="fixed inset-x-0 top-(--frame-top) z-40 flex h-(--appbar-h) items-center gap-1 border-b border-sidebar-border bg-sidebar pr-2 pl-2.5 max-md:hidden lg:pr-3"
    >
      <Hint label="Home" side="bottom">
        <Link to={homePagePath(slug)} aria-label="g1t: Home" className={cn(TAB, "w-8.5 justify-center text-fg")}>
          <Mark tight className="h-4.5 w-auto" />
        </Link>
      </Hint>
      <WorkspaceSwitcher user={user} workspace={workspace} variant="bar" current={here === "people" || here === "workspace"} />
      <span aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 bg-sidebar-border" />
      <nav aria-label="Apps" className="flex min-w-0 grow">
        {/* Too many pins for the window, once search has narrowed all it can: the row scrolls under a fade at its end. */}
        <ul className="flex min-w-0 items-center gap-0.5 overflow-x-auto pr-4 mask-[linear-gradient(to_right,#000_calc(100%-1rem),transparent)] scrollbar-none">
          {barApps(code).map((key) => (
            <AppTab key={key} to={modeHome(key, slug)} label={appOf(key).name} icon={appIcon(key, 17)} current={here === key && !onPin} badge={badges[key]} />
          ))}
          <li aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 bg-sidebar-border" />
          {shown.map((app) => (
            <IconTab key={app.key} to={app.to} label={app.name} icon={app.icon(18)} current={at(app.to)} />
          ))}
          <AppsButton slug={slug} pins={pins} onToggle={toggle} current={here === "apps"} />
          <IconTab to="/explore" label="Explore" icon={<Compass size={17} />} current={here === "browse" || at("/explore")} />
        </ul>
      </nav>
      {/* The end gives way first: search narrows (it shrinks twenty times as fast as the tabs) before a tab is hidden. */}
      <div className="flex min-w-0 shrink-20 items-center justify-end gap-1 lg:gap-1.5">{end}</div>
    </header>
  );
}
