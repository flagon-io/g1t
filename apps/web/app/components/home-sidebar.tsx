import { Code2, MessagesSquare, Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";

import type { ChatSidebarEntry } from "@g1t/contracts";

import { PaletteKey } from "./command-palette";
import { StatusDot } from "./chat/marks";
import { isOrchestrator } from "./orchestrator";
import type { ShellAgent, ShellData } from "./shell";
import { channelPath } from "../lib/chat";

/** Most of each kind under Recent. */
const RECENT_CHATS = 5;
const RECENT_PROJECTS = 4;
const RECENT_AGENTS = 3;

type Item = { key: string; to: string; label: string; mode: "chat" | "code" | "agents"; trailing?: ReactNode };

const MODE_ICON: Record<Item["mode"], ReactNode> = {
  chat: <MessagesSquare size={15} />,
  code: <Code2 size={15} />,
  agents: <Sparkles size={15} />,
};
const MODE_WORD: Record<Item["mode"], string> = { chat: "Chat", code: "Code", agents: "Agents" };

function Row({ item }: { item: Item }) {
  return (
    <li>
      <NavLink
        to={item.to}
        prefetch="intent"
        className={({ isActive }) =>
          `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
            isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
          }`
        }
      >
        <span className="shrink-0 text-faint group-hover:text-muted" aria-hidden="true">
          {MODE_ICON[item.mode]}
        </span>
        <span className="sr-only">{MODE_WORD[item.mode]}: </span>
        <span className="min-w-0 grow truncate">{item.label}</span>
        {item.trailing}
      </NavLink>
    </li>
  );
}

function Group({ title, items, empty }: { title: string; items: Item[]; empty: string }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 px-2 text-xs font-medium text-faint">{title}</h3>
      {items.length === 0 ? <p className="px-2 py-1 text-xs text-faint">{empty}</p> : <ul className="space-y-px">{items.map((item) => <Row key={item.key} item={item} />)}</ul>}
    </section>
  );
}

function chatItem(slug: string, entry: ChatSidebarEntry): Item {
  const count = entry.mentions || entry.unread;
  return {
    key: `chat:${entry.channel.id}`,
    to: channelPath(slug, entry.channel),
    label: entry.channel.kind === "channel" ? `#${entry.channel.name}` : entry.title,
    mode: "chat",
    trailing:
      count > 0 && !entry.muted ? (
        <span
          className={`rounded-full px-1.5 text-[0.6875rem] leading-[1.125rem] font-semibold tabular-nums ${entry.mentions ? "bg-accent text-bg" : "bg-line-strong text-fg"}`}
        >
          {count}
        </span>
      ) : null,
  };
}

function agentItem(slug: string, agent: ShellAgent): Item {
  return {
    key: `agent:${agent.id}`,
    to: `/${slug}/-/agents/${agent.handle}`,
    label: agent.display_name,
    mode: "agents",
    trailing: isOrchestrator(agent) ? null : <StatusDot status={agent.status} />,
  };
}

/**
 * Home's sidebar: never Code's. A way to search or jump, what you pinned
 * across modes (starred channels and conversations, pinned projects, and
 * docs once they exist), and what you were in last, each marked with its
 * mode.
 */
export function HomeSidebar({
  slug,
  shell,
  code,
  onFind,
  header,
}: {
  slug: string;
  shell: ShellData;
  /** Whether the viewer uses Code here: without it, no projects. */
  code: boolean;
  onFind: () => void;
  header: ReactNode;
}) {
  const chat = shell.chat;
  const starredChats = chat?.starred ?? [];
  const starred: Item[] = [
    ...starredChats.map((entry) => chatItem(slug, entry)),
    ...(code ? (shell.pinned ?? []) : []).map((project) => ({
      key: `project:${project.namespace}/${project.name}`,
      to: `/${project.namespace}/${project.name}`,
      label: project.title ?? project.name,
      mode: "code" as const,
    })),
  ];
  const starredIds = new Set(starredChats.map((entry) => entry.channel.id));
  const pinnedProjects = new Set((shell.pinned ?? []).map((project) => `${project.namespace}/${project.name}`));
  const agents = shell.agents ?? [];
  const recent: Item[] = [
    ...(chat?.recent ?? []).filter((entry) => !starredIds.has(entry.channel.id)).slice(0, RECENT_CHATS).map((entry) => chatItem(slug, entry)),
    ...(code ? (shell.recent ?? []) : [])
      .filter((project) => !pinnedProjects.has(`${project.namespace}/${project.name}`))
      .slice(0, RECENT_PROJECTS)
      .map((project) => ({
        key: `project:${project.namespace}/${project.name}`,
        to: `/${project.namespace}/${project.name}`,
        label: project.title ?? project.name,
        mode: "code" as const,
      })),
    ...[...agents]
      .sort((a, b) => Number(isOrchestrator(b)) - Number(isOrchestrator(a)) || Number(b.status !== "idle") - Number(a.status !== "idle"))
      .slice(0, RECENT_AGENTS)
      .map((agent) => agentItem(slug, agent)),
  ];
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="px-2.5 pt-3">
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
      <nav aria-label="Home" className="min-h-0 grow overflow-y-auto px-2.5 pb-4 [scrollbar-width:thin]">
        <Group title="Starred" items={starred} empty="Star a channel or pin a project to keep it here." />
        <Group title="Recent" items={recent} empty={chat == null ? "Recent conversations show here once chat answers." : "Nothing yet."} />
      </nav>
    </div>
  );
}
