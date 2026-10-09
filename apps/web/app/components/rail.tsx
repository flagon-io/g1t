import { Activity, BookOpen, Building2, Check, CircleHelp, CircleUserRound, Code2, House, Inbox, Keyboard, LifeBuoy, MessagesSquare, Plus, Settings, Shapes, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigation } from "react-router";

import { type Membership, type User, hasCodeAccess, shownUsername } from "@g1t/contracts";

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
import { paletteKeyLabel } from "../lib/shortcut";
import { STATUS_URL } from "../lib/status";
import { type ModeKey, modeHome, modeOf } from "../lib/workspace-nav";

/** The rail's width; the shell lays the mode's sidebar and the page out beside it. */
export const RAIL_WIDTH = "5rem";

type Mode = { key: ModeKey; label: string; icon: ReactNode; badge?: { count: number; loud: boolean } | null };

function Badge({ count, loud }: { count: number; loud: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={`absolute -top-1 -right-1.5 min-w-[1.125rem] rounded-full px-1 text-center text-[0.625rem] leading-[1.125rem] font-bold tabular-nums ring-2 ring-[var(--rail-bg)] ${
        loud ? "bg-accent text-bg" : "bg-[#3d3d45] text-fg"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The square behind a rail icon: filled for the current mode. */
function IconSquare({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span
      className={`relative flex size-9 items-center justify-center rounded-[10px] transition-colors ${
        current
          ? "bg-[#2c2c33] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
          : "text-muted group-hover:bg-raised group-hover:text-fg group-data-[state=open]:bg-raised group-data-[state=open]:text-fg"
      }`}
    >
      {children}
    </span>
  );
}

/** A mode's name under its icon: centred on the rail, whatever its length. */
function RailLabel({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <span
      className={`block w-full truncate text-center text-[0.6875rem] leading-none font-medium transition-colors ${current ? "text-fg" : "text-faint group-hover:text-muted"}`}
    >
      {children}
    </span>
  );
}

// Each item fills the rail's width and centres its icon and name on it.
const RAIL_ITEM =
  "group flex w-full flex-col items-center justify-center gap-1 rounded-lg py-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent";

function RailButton({ mode, to, current }: { mode: Mode; to: string; current: boolean }) {
  return (
    <Link
      to={to}
      prefetch="intent"
      aria-current={current ? "page" : undefined}
      aria-label={mode.badge && mode.badge.count > 0 ? `${mode.label}, ${mode.badge.count} unread` : mode.label}
      className={RAIL_ITEM}
    >
      <IconSquare current={current}>
        {mode.icon}
        {mode.badge && <Badge count={mode.badge.count} loud={mode.badge.loud} />}
      </IconSquare>
      <RailLabel current={current}>{mode.label}</RailLabel>
    </Link>
  );
}

function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/**
 * The workspace at the top of the rail: its avatar, and the switcher. Your
 * workspaces, a new one, and your own account, which is no workspace's.
 */
function WorkspaceButton({ user, workspace }: { user: User; workspace: Membership }) {
  return (
    <DropdownMenu>
      <Hint label={displayName(workspace)} side="right">
        <DropdownMenuTrigger
          aria-label={`${displayName(workspace)}: switch workspace`}
          className="flex rounded-[10px] outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-line-strong"
        >
          <Avatar name={workspace.slug} image={workspace.avatar} size={36} square />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent side="right" align="start" className="w-72 p-1.5">
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
            <Link to={`/${membership.slug}/-/home`}>
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

/** Keyboard shortcuts, as the Help menu lists them. */
function shortcuts(palette: string): [string, string][] {
  return [
    [palette, "Search, jump anywhere, or run a command"],
    ["Esc", "Close a menu, dialog or panel"],
    ["Enter", "Send a message in Chat"],
    ["Shift Enter", "A new line in a message"],
    ["@", "Mention a person or an agent"],
    ["↑ ↓ then Tab", "Choose a suggestion"],
    ["Alt ↑ ↓", "Move a pinned project in Code's sidebar"],
  ];
}

/** Help, above the account: support, the documentation, status, and the keyboard's shortcuts. */
export function HelpMenu() {
  const [keys, setKeys] = useState(false);
  const palette = paletteKeyLabel(typeof navigator === "undefined" ? null : navigator.platform);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Help" className={RAIL_ITEM}>
          <IconSquare current={false}>
            <CircleHelp size={19} />
          </IconSquare>
          <RailLabel current={false}>Help</RailLabel>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-60">
          <DropdownMenuLabel>Help</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to="/support">
              <LifeBuoy />
              Support
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="https://docs.g1t.sh/">
              <BookOpen />
              Documentation
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={STATUS_URL}>
              <Activity />
              Status
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setKeys(true)}>
            <Keyboard />
            Keyboard shortcuts
            <kbd className="ml-auto font-sans text-xs text-faint">{palette}</kbd>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={keys} onOpenChange={setKeys}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Everywhere in g1t, and in Chat.</DialogDescription>
          </DialogHeader>
          <dl className="divide-y divide-line rounded-lg border border-line">
            {shortcuts(palette).map(([key, what]) => (
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
    </>
  );
}

/**
 * The rail down the left (docs/WORKSPACE.md, "Shell"): the workspace and
 * its switcher; Home, Code, Chat, Docs, Agents and the Inbox; then, at the
 * foot, the workspace itself, help and your account. Code sits second: for
 * those who have it, it is the everyday mode. The mode lit follows the
 * address. A member without Code access has no Code.
 */
export function Rail({
  user,
  workspace,
  unread,
  help,
  account,
}: {
  user: User;
  workspace: Membership;
  unread: { inbox: number; chat: number; mentions: number };
  help: ReactNode;
  account: ReactNode;
}) {
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  const here = modeOf(going ?? pathname, workspace.slug);
  const code = hasCodeAccess(workspace);
  const modes: Mode[] = [
    { key: "home", label: "Home", icon: <House size={19} /> },
    ...(code ? [{ key: "code" as const, label: "Code", icon: <Code2 size={19} /> }] : []),
    {
      key: "chat",
      label: "Chat",
      icon: <MessagesSquare size={19} />,
      badge: { count: unread.mentions > 0 ? unread.mentions : unread.chat, loud: unread.mentions > 0 },
    },
    { key: "artifacts", label: "Artifacts", icon: <Shapes size={19} /> },
    { key: "agents", label: "Agents", icon: <Sparkles size={19} /> },
    { key: "inbox", label: "Inbox", icon: <Inbox size={19} />, badge: { count: unread.inbox, loud: true } },
  ];
  const workspaceMode: Mode = { key: "workspace", label: "Workspace", icon: <Building2 size={19} /> };
  return (
    // The right-hand rule is an inset shadow, not a border, so the rail's
    // whole width is its content box and every item centres on it exactly.
    <nav
      aria-label="Modes"
      style={{ width: RAIL_WIDTH, ["--rail-bg" as string]: "#0b0b0d" }}
      className="flex h-full shrink-0 flex-col items-center overflow-y-auto bg-[var(--rail-bg)] pb-3 shadow-[inset_-1px_0_0_var(--color-line)] [scrollbar-width:none]"
    >
      {/* The top bar's height, rule and colour: the workspace sits in the top bar's line, tied to it as the
          sidebar's heading is, rather than on the rail below it. */}
      <div className="flex h-14 w-full shrink-0 items-center justify-center border-b border-line bg-bg shadow-[inset_-1px_0_0_var(--color-line)]">
        <WorkspaceButton user={user} workspace={workspace} />
      </div>
      <div className="mt-3 flex w-full flex-col items-center gap-2 px-1.5">
        {modes.map((mode) => (
          <RailButton key={mode.key} mode={mode} to={modeHome(mode.key, workspace.slug)} current={here === mode.key} />
        ))}
      </div>
      <div className="mt-auto flex w-full flex-col items-center gap-2 px-1.5 pt-4">
        <RailButton mode={workspaceMode} to={modeHome("workspace", workspace.slug)} current={here === "workspace"} />
        {help}
        <div className="mt-1.5">{account}</div>
      </div>
    </nav>
  );
}
