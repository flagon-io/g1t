import { Check, ChevronDown, CircleUserRound, LayoutGrid, Plus, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigation } from "react-router";

import { type Membership, type User, hasCodeAccess, shownUsername } from "@g1t/contracts";

import { AppsLauncher, appIcon, useAppPins } from "./apps";
import { Mark } from "./logo";
import { Avatar } from "./ui";
import { Hint } from "./ui/hint";
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
import { type AppKey, type PinnableApp, appOf } from "../lib/apps";
import { cn } from "../lib/cn";
import { paletteKeyLabel } from "../lib/shortcut";
import { type ModeKey, modeHome, modeOf, todayPath } from "../lib/workspace-nav";

/** The dock's column: 8px from the window's edge, 80px wide. */
export const DOCK_COLUMN = "5.5rem";

type Item = { key: ModeKey; label: string; badge?: { count: number; loud: boolean } | null };

/** A count on an icon: loud (the accent) for what waits on you, quiet for the rest. */
export function CountBadge({ count, loud, className }: { count: number; loud: boolean; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "absolute -top-1 -right-1.5 min-w-[1.125rem] rounded-full px-1 text-center text-[0.625rem] leading-[1.125rem] font-bold tabular-nums ring-2 ring-dock",
        loud ? "bg-accent text-bg" : "bg-line-strong text-fg",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The square behind an icon in the dock: raised for the current one. */
function IconSquare({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "relative flex size-9 items-center justify-center rounded-[11px] transition-colors",
        current
          ? "bg-raised text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          : "text-muted group-hover:bg-raised group-hover:text-fg group-data-[state=open]:bg-raised group-data-[state=open]:text-fg",
      )}
    >
      {children}
    </span>
  );
}

/** The bar on the dock's left edge beside the current item. */
function CurrentBar() {
  return <span aria-hidden="true" className="absolute top-[9px] -left-1.5 h-5 w-[3px] rounded-r-[3px] bg-fg" />;
}

// Each item fills the dock's width and centres its icon and name on it.
const ITEM = "group relative flex w-full flex-col items-center justify-center gap-0.5 rounded-lg py-0.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent";

function DockLink({ to, label, icon, current, badge, compact = false }: { to: string; label: string; icon: ReactNode; current: boolean; badge?: Item["badge"]; compact?: boolean }) {
  const link = (
    <Link
      to={to}
      prefetch="intent"
      aria-current={current ? "page" : undefined}
      aria-label={badge && badge.count > 0 ? `${label}, ${badge.count} unread` : label}
      className={ITEM}
    >
      {current && <CurrentBar />}
      <IconSquare current={current}>
        {icon}
        {badge && <CountBadge count={badge.count} loud={badge.loud} />}
      </IconSquare>
      {!compact && <DockLabel current={current}>{label}</DockLabel>}
    </Link>
  );
  // An icon alone says its name on hover.
  return compact ? (
    <Hint label={label} side="right">
      {link}
    </Hint>
  ) : (
    link
  );
}

/** A name under an icon: centred on the dock, whatever its length. */
function DockLabel({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span className={cn("block w-full truncate text-[0.625rem] leading-tight font-medium transition-colors", current ? "text-fg" : "text-faint group-hover:text-muted")}>
      {children}
    </span>
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
          "flex min-w-0 items-center rounded-lg outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised",
          compact ? "h-8 shrink-0 gap-1.5 px-1 max-sm:max-w-40" : "h-9 grow gap-2 px-1.5",
        )}
      >
        <Avatar name={workspace.slug} image={workspace.avatar} size={compact ? 22 : 26} square />
        <span className={cn("min-w-0 truncate font-semibold", compact ? "text-sm" : "text-[0.875rem]")}>{displayName(workspace)}</span>
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
            <Link to={todayPath(membership.slug)}>
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
        <dl className="divide-y divide-line rounded-lg border border-line">
          {shortcuts(paletteKeyLabel(platform), sidebarKeyLabel(platform)).map(([key, what]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
              <dt className="text-fg-soft">{what}</dt>
              <dd>
                <kbd className="rounded-md border border-line-strong bg-raised px-1.5 py-0.5 font-sans text-xs whitespace-nowrap text-fg">{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** The Apps button at the foot of the dock's apps, and the launcher it opens. */
function AppsButton({ slug, code, pins, onToggle, current }: { slug: string; code: boolean; pins: PinnableApp[]; onToggle: (app: PinnableApp) => void; current: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Apps" className={ITEM}>
        {current && <CurrentBar />}
        <IconSquare current={current || open}>
          <LayoutGrid size={19} />
        </IconSquare>
        <DockLabel current={current || open}>Apps</DockLabel>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={14} aria-label="Apps" className="w-[23rem] bg-dock p-2.5">
        <AppsLauncher slug={slug} code={code} pins={pins} onToggle={onToggle} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The dock down the left: g1t's mark, which
 * leads to Today; the built-in apps (Today, Chat, Notifications, Agents,
 * Code and Artifacts) with their names; the apps you pinned, as icons;
 * the Apps launcher; and at its foot People, Workspace and your account.
 * What is lit follows the address. A member without Code access has no
 * Code. From 768px; a phone has the bottom bar (components/mobile.tsx).
 */
export function Dock({
  workspace,
  pins: saved,
  unread,
  account,
}: {
  workspace: Membership;
  /** The apps pinned to this person's dock in this workspace, as saved. */
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
    { key: "today", label: "Today" },
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
  const shown = pins.filter((key) => code || !appOf(key).code);
  // A pinned app is current on its own page and the pages under it.
  const at = (to: string) => path === to || path.startsWith(`${to}/`);
  return (
    <nav
      aria-label="Apps"
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-dock shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_8px_24px_rgba(0,0,0,0.18)]"
    >
      <div className="flex h-14 shrink-0 items-center justify-center">
        <Hint label="Today" side="right">
          <Link to={todayPath(slug)} aria-label="g1t: Today" className="flex size-9 items-center justify-center rounded-[11px] transition-colors hover:bg-raised">
            <Mark tight className="h-[1.125rem] w-auto" />
          </Link>
        </Hint>
      </div>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 px-1.5 pb-1.5">
        {builtins.map((item) => (
          <DockLink
            key={item.key}
            to={modeHome(item.key, slug)}
            label={item.label}
            icon={appIcon(item.key as AppKey, 19)}
            current={here === item.key && !shown.some((key) => at(appOf(key).path(slug)))}
            badge={item.badge}
          />
        ))}
      </div>
      {/* Your pinned apps: as many as you like, scrolling under a fade at either end. */}
      <div className="flex min-h-0 w-full grow flex-col items-center gap-1 overflow-y-auto border-t border-line px-1.5 py-2 [mask-image:linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%-14px),transparent)] [scrollbar-width:none]">
        {shown.map((key) => {
          const app = appOf(key);
          return <DockLink key={key} to={app.path(slug)} label={app.name} icon={appIcon(key, 18)} current={at(app.path(slug))} compact />;
        })}
      </div>
      <div className="flex w-full shrink-0 flex-col items-center px-1.5 pb-1.5">
        <AppsButton slug={slug} code={code} pins={pins} onToggle={toggle} current={here === "apps"} />
      </div>
      <div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-line px-1.5 pt-2 pb-2.5">
        <DockLink to={modeHome("people", slug)} label="People" icon={appIcon("people", 19)} current={here === "people"} />
        <DockLink to={modeHome("workspace", slug)} label="Workspace" icon={appIcon("workspace", 19)} current={here === "workspace"} />
        <div className="mt-1.5">{account}</div>
      </div>
    </nav>
  );
}
