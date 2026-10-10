import { Check, ChevronDown, CircleUserRound, LayoutGrid, Plus, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigation } from "react-router";

import { type Membership, type User, hasCodeAccess, shownUsername } from "@g1t/contracts";

import { AppsLauncher, appIcon, pinnedApp, useAppPins } from "./apps";
import { Mark } from "./logo";

import { Avatar } from "./ui/avatar";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Kbd } from "./ui/kbd";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarSeparator } from "./ui/sidebar";
import { type BuiltinApp, type PinnableApp } from "../lib/apps";
import { cn } from "../lib/cn";
import { paletteKeyLabel } from "../lib/shortcut";
import { type ModeKey, homePagePath, modeHome, modeOf } from "../lib/workspace-nav";

type Item = { key: ModeKey; label: string; badge?: { count: number; loud: boolean } | null };

/** A count on an icon: loud (the accent) for what waits on you, quiet for the rest. */
export function CountBadge({ count, loud, className }: { count: number; loud: boolean; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "absolute -top-1 -right-1.5 min-w-[1.125rem] rounded-full px-1 text-center text-[0.625rem] leading-[1.125rem] font-bold tabular-nums ring-2 ring-rail",
        loud ? "bg-accent text-bg" : "bg-line-strong text-fg",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** One icon of the rail: a link to an app, its name as the hint beside it, and what is unread on it. */
function RailLink({ to, label, icon, current, badge }: { to: string; label: string; icon: ReactNode; current: boolean; badge?: Item["badge"] }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="icon" isActive={current} tooltip={label}>
        <Link to={to} prefetch="intent" aria-current={current ? "page" : undefined} aria-label={badge && badge.count > 0 ? `${label}, ${badge.count} unread` : label}>
          {icon}
          {badge && <CountBadge count={badge.count} loud={badge.loud} />}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/**
 * The workspace you are in and the way to another: its avatar, its name
 * and a chevron, opening your workspaces, a new one, and your own account.
 * `row` heads the sidebar; `compact` starts the page header's trail when
 * no sidebar is open.
 */
export function WorkspaceSwitcher({ user, workspace, compact = false }: { user: User; workspace: Membership; compact?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${displayName(workspace)}: switch workspace`}
        className={cn(
          "flex min-w-0 items-center rounded-lg outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-sidebar-accent",
          compact ? "h-8 shrink-0 gap-1.5 px-1 max-md:h-11 max-sm:gap-1 hover:bg-raised data-[state=open]:bg-raised" : "h-9 grow gap-2 px-1.5",
        )}
      >
        <Avatar name={workspace.slug} image={workspace.avatar} size={compact ? 22 : 26} square />
        <span className={cn("min-w-0 truncate font-semibold", compact ? "text-sm max-sm:hidden" : "text-[0.875rem]")}>{displayName(workspace)}</span>
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <DropdownMenuItem asChild className="gap-3 px-2 py-2">
          <Link to={`/${workspace.slug}/-/workspace`}>
            <Avatar name={workspace.slug} image={workspace.avatar} size={36} square />
            <span className="flex min-w-0 grow flex-col leading-tight">
              <span className="truncate text-sm font-medium text-fg">{displayName(workspace)}</span>
              <span className="truncate font-mono text-xs text-muted">g1t.sh/{workspace.slug}</span>
              <span className="mt-0.5 text-xs text-faint capitalize">{workspace.role}</span>
            </span>
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
              {membership.slug === workspace.slug ? <Check className="shrink-0 text-accent" /> : <span className="size-4 shrink-0" aria-hidden="true" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <Plus />
            New workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuLabel>Personal account</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link to={`/u/${user.username}`}>
            <CircleUserRound />
            <span className="grow">Your profile</span>
            <span className="font-mono text-xs text-faint">@{shownUsername(user)}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            Your settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Keyboard shortcuts, as the account menu lists them. */
function shortcuts(palette: string, sidebar: string): [string, string][] {
  return [
    [palette, "Search, jump anywhere, or run a command"],
    [sidebar, "Show or hide the sidebar"],
    ["Esc", "Close a menu, dialog or panel"],
    ["Enter", "Send a message in Chat"],
    ["Shift Enter", "A new line in a message"],
    ["@", "Mention a person or an agent"],
    ["↑ ↓ then Tab", "Choose a suggestion"],
    ["Alt ↑ ↓", "Move a pinned project in Code's sidebar"],
  ];
}

/** The sidebar's shortcut, as this computer writes it. */
export function sidebarKeyLabel(platform: string | null): string {
  return paletteKeyLabel(platform).replace(/K$/, "B");
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
            {shortcuts(paletteKeyLabel(platform), sidebarKeyLabel(platform)).map(([key, what]) => (
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

/** The Apps icon at the foot of the rail's apps, and the launcher it opens beside it. */
function AppsButton({ slug, pins, onToggle, current }: { slug: string; pins: PinnableApp[]; onToggle: (app: PinnableApp) => void; current: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SidebarMenuButton asChild size="icon" isActive={current} tooltip="Apps">
        <PopoverTrigger aria-label="Apps">
          <LayoutGrid />
        </PopoverTrigger>
      </SidebarMenuButton>
      <PopoverContent side="right" align="end" sideOffset={12} aria-label="Apps" className="w-[23rem] p-2.5">
        <AppsLauncher slug={slug} pins={pins} onToggle={onToggle} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The rail down the window's left edge: a narrow column of icons, each
 * named by the hint beside it. g1t's mark, which leads to Home; the
 * built-in apps (Home, Chat, Notifications, Agents, Code and Artifacts)
 * with what is unread on them; the apps you pinned; the Apps launcher;
 * and at its foot People, Workspace and your account. The one you are in
 * sits on a filled square, and which that is follows the address. A
 * member without Code access has no Code. From 768px; a phone has the
 * bottom bar (components/mobile.tsx). Drawn from the sidebar kit
 * (components/ui/sidebar.tsx), as the mode sidebar beside it is.
 */
export function Rail({
  workspace,
  pins: saved,
  unread,
  account,
}: {
  workspace: Membership;
  /** The apps pinned to this person's rail in this workspace, as saved. */
  pins: PinnableApp[];
  unread: { notifications: number; chat: number; mentions: number };
  account: ReactNode;
}) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const path = going ?? pathname;
  const here = modeOf(path, workspace.slug);
  const slug = workspace.slug;
  const code = hasCodeAccess(workspace);
  const { pins, toggle } = useAppPins(slug, saved);
  const builtins: Item[] = [
    { key: "home", label: "Home" },
    {
      key: "chat",
      label: "Chat",
      badge: { count: unread.mentions > 0 ? unread.mentions : unread.chat, loud: unread.mentions > 0 },
    },
    { key: "notifications", label: "Notifications", badge: { count: unread.notifications, loud: true } },
    { key: "agents", label: "Agents" },
    ...(code ? [{ key: "code" as const, label: "Code" }] : []),
    { key: "artifacts", label: "Artifacts" },
  ];
  const shown = pins.map((key) => pinnedApp(key, slug)).filter((app) => app != null);
  // A pinned app is current on its own page and the pages under it.
  const at = (to: string) => path === to || path.startsWith(`${to}/`);
  return (
    <Sidebar variant="rail" collapsible="none" role="navigation" aria-label="Apps">
      <SidebarHeader className="h-14 items-center justify-center p-0">
        <SidebarMenu className="w-auto">
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="icon" tooltip="Home">
              <Link to={homePagePath(slug)} aria-label="g1t: Home">
                <span className="flex">
                  <Mark tight className="h-[1.125rem] w-auto" />
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="items-center gap-0">
        <SidebarMenu className="w-auto shrink-0 gap-2">
          {builtins.map((item) => (
            <RailLink
              key={item.key}
              to={modeHome(item.key, slug)}
              label={item.label}
              icon={appIcon(item.key as BuiltinApp, 20)}
              current={here === item.key && !shown.some((app) => at(app.to))}
              badge={item.badge}
            />
          ))}
        </SidebarMenu>
        {/* Your pinned apps: as many as you like, scrolling under a fade at either end. */}
        {shown.length > 0 && (
          <SidebarMenu className="mt-2 w-auto min-h-0 grow gap-2 overflow-y-auto py-2 [mask-image:linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%-14px),transparent)] [scrollbar-width:none]">
            {shown.map((app) => (
              <RailLink key={app.key} to={app.to} label={app.name} icon={app.icon(20)} current={at(app.to)} />
            ))}
          </SidebarMenu>
        )}
      </SidebarContent>
      <SidebarFooter className="items-center gap-0 p-0 pb-3">
        <SidebarMenu className="w-auto gap-2">
          <SidebarMenuItem>
            <AppsButton slug={slug} pins={pins} onToggle={toggle} current={here === "apps"} />
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator className="my-2.5 w-7" />
        <SidebarMenu className="w-auto gap-2">
          <RailLink to={modeHome("people", slug)} label="People" icon={appIcon("people", 20)} current={here === "people"} />
          <RailLink to={modeHome("workspace", slug)} label="Workspace" icon={appIcon("workspace", 20)} current={here === "workspace"} />
          <SidebarMenuItem className="mt-1 flex justify-center">{account}</SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
