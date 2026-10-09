import { BookOpen, Check, Code2, House, Inbox, MessagesSquare, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigation } from "react-router";

import { type Membership, type User, hasCodeAccess } from "@g1t/contracts";

import { Avatar } from "./ui";
import { Hint } from "./ui/hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
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

function RailButton({ mode, to, current }: { mode: Mode; to: string; current: boolean }) {
  return (
    <Link
      to={to}
      prefetch="intent"
      aria-current={current ? "page" : undefined}
      aria-label={mode.badge && mode.badge.count > 0 ? `${mode.label}, ${mode.badge.count} unread` : mode.label}
      className="group flex w-full flex-col items-center gap-1 rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span
        className={`relative flex size-9 items-center justify-center rounded-[10px] transition-colors ${
          current ? "bg-[#2c2c33] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "text-muted group-hover:bg-raised group-hover:text-fg"
        }`}
      >
        {mode.icon}
        {mode.badge && <Badge count={mode.badge.count} loud={mode.badge.loud} />}
      </span>
      <span className={`text-[0.6875rem] leading-none font-medium transition-colors ${current ? "text-fg" : "text-faint group-hover:text-muted"}`}>
        {mode.label}
      </span>
    </Link>
  );
}

function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

/** The workspace at the top of the rail: its avatar, which switches between yours. */
function WorkspaceButton({ user, workspace }: { user: User; workspace: Membership }) {
  return (
    <DropdownMenu>
      <Hint label={displayName(workspace)} side="right">
        <DropdownMenuTrigger
          aria-label={`${displayName(workspace)}: switch workspace`}
          className="rounded-[11px] outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-line-strong"
        >
          <Avatar name={workspace.slug} image={workspace.avatar} size={40} square />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent side="right" align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {(user.workspaces ?? []).map((membership) => (
          <DropdownMenuItem key={membership.slug} asChild>
            <Link to={hasCodeAccess(membership) ? `/${membership.slug}` : `/${membership.slug}/-/home`}>
              <Avatar name={membership.slug} image={membership.avatar} size={24} square />
              <span className="flex min-w-0 grow flex-col leading-tight">
                <span className="truncate">{displayName(membership)}</span>
                <span className="truncate font-mono text-[0.6875rem] text-faint">{membership.slug}</span>
              </span>
              {membership.slug === workspace.slug ? <Check className="shrink-0 text-accent" /> : <span className="size-4 shrink-0" aria-hidden="true" />}
            </Link>
          </DropdownMenuItem>
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
 * The rail down the left (docs/WORKSPACE.md, "Shell"): the workspace, then
 * Home, Code, Chat, Docs, Agents and the Inbox, then the account. The mode
 * lit follows the address. A member without Code access has no Code.
 */
export function Rail({
  user,
  workspace,
  unread,
  account,
}: {
  user: User;
  workspace: Membership;
  unread: { inbox: number; chat: number; mentions: number };
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
    { key: "docs", label: "Docs", icon: <BookOpen size={19} /> },
    { key: "agents", label: "Agents", icon: <Sparkles size={19} /> },
    { key: "inbox", label: "Inbox", icon: <Inbox size={19} />, badge: { count: unread.inbox, loud: true } },
  ];
  return (
    <nav
      aria-label="Modes"
      style={{ width: RAIL_WIDTH, ["--rail-bg" as string]: "#0b0b0d" }}
      className="flex h-full shrink-0 flex-col items-center border-r border-line bg-[var(--rail-bg)] pt-3 pb-3"
    >
      <WorkspaceButton user={user} workspace={workspace} />
      <div className="mt-4 flex w-full flex-col items-center gap-2.5 px-2">
        {modes.map((mode) => (
          <RailButton key={mode.key} mode={mode} to={modeHome(mode.key, workspace.slug, code)} current={here === mode.key} />
        ))}
      </div>
      <div className="mt-auto">{account}</div>
    </nav>
  );
}
