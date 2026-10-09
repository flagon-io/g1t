import { ArrowRight, BookOpen, Hash, Inbox, Lock, MessagesSquare, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data } from "react-router";

import type { ChatSidebarEntry } from "@g1t/contracts";

import type { Route } from "./+types/home";
import { AgentFace } from "../../components/agents-mode";
import { MemberAvatar, StatusDot, statusLabel } from "../../components/chat/marks";
import { channelPath, sections } from "../../lib/chat";
import { sidebarOrNull } from "../../lib/chat.server";
import { page } from "../../lib/meta";
import { inbox, workspaceAgents } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/**
 * Home for the workspace without Code (docs/WORKSPACE.md, "Members without
 * Code"): the conversations waiting, the agents, Docs and the inbox, in
 * place of projects. Anyone in the workspace can open it.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [sidebar, agents, counts] = await Promise.all([
    sidebarOrNull(slug, viewer),
    workspaceAgents.list(slug, viewer).catch(() => null),
    inbox.counts(viewer.username).catch(() => null),
  ]);
  return {
    slug,
    name: viewer.username,
    sidebar,
    agents: agents?.ok ? agents.value.filter((a) => !a.archived_at) : null,
    unreadInbox: counts?.unread ?? 0,
  };
}

function Card({ title, icon, to, action, children }: { title: string; icon: ReactNode; to: string; action: string; children: ReactNode }) {
  return (
    <section className="flex flex-col rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
        <span className="text-muted">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link to={to} className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-fg">
          {action}
          <ArrowRight size={12} />
        </Link>
      </header>
      <div className="grow p-2">{children}</div>
    </section>
  );
}

function ConversationRow({ entry, slug }: { entry: ChatSidebarEntry; slug: string }) {
  const other = entry.others[0];
  return (
    <Link to={channelPath(slug, entry.channel)} className="flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors hover:bg-raised/60">
      <span className="flex w-5 justify-center text-faint">
        {entry.channel.kind === "dm" && other ? <MemberAvatar member={other} size={20} /> : entry.channel.private ? <Lock size={14} /> : <Hash size={15} />}
      </span>
      <span className={`min-w-0 grow truncate ${entry.unread > 0 ? "font-semibold text-fg" : "text-muted"}`}>{entry.title}</span>
      {entry.unread > 0 && (
        <span className={`rounded-full px-1.5 text-[0.6875rem] leading-[1.125rem] font-semibold tabular-nums ${entry.mentions ? "bg-accent text-bg" : "bg-line-strong text-fg"}`}>
          {entry.mentions || entry.unread}
        </span>
      )}
    </Link>
  );
}

export default function WorkspaceHome({ loaderData }: Route.ComponentProps) {
  const { slug, name, sidebar, agents, unreadInbox } = loaderData;
  const all = sidebar?.entries ?? [];
  const waiting = all.filter((e) => !e.muted && e.unread > 0);
  const { dms } = sections(all);
  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {name}</h1>
        <p className="mt-1.5 text-sm text-muted">
          {waiting.length > 0
            ? `${waiting.length} ${waiting.length === 1 ? "conversation has" : "conversations have"} something new.`
            : "You're caught up in chat."}
          {unreadInbox > 0 ? ` ${unreadInbox} unread in your inbox.` : ""}
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Unread" icon={<MessagesSquare size={16} />} to={`/${slug}/-/chat`} action="Open chat">
          {sidebar == null ? (
            <p className="px-3 py-6 text-sm text-muted">Chat didn&apos;t answer. Your conversations show here once it does.</p>
          ) : waiting.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted">Nothing new. Conversations with new messages show here.</p>
          ) : (
            waiting.slice(0, 6).map((entry) => <ConversationRow key={entry.channel.id} entry={entry} slug={slug} />)
          )}
        </Card>
        <Card title="Direct messages" icon={<MessagesSquare size={16} />} to={`/${slug}/-/chat`} action="All">
          {dms.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted">Message a teammate or an agent from Chat.</p>
          ) : (
            dms.slice(0, 6).map((entry) => <ConversationRow key={entry.channel.id} entry={entry} slug={slug} />)
          )}
        </Card>
        <Card title="Agents" icon={<Sparkles size={16} />} to={`/${slug}/-/agents`} action="All agents">
          {agents == null || agents.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted">
              {agents == null ? "The agents service didn't answer." : "No agents yet. Ask an owner to add one, or make one from a template."}
            </p>
          ) : (
            agents.slice(0, 5).map((agent) => (
              <Link key={agent.id} to={`/${slug}/-/agents/${agent.handle}`} className="flex h-12 items-center gap-3 rounded-lg px-3 transition-colors hover:bg-raised/60">
                <AgentFace agent={agent} size={26} />
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm font-medium">{agent.display_name}</span>
                  <span className="block truncate text-xs text-faint">{agent.role}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <StatusDot status={agent.status} />
                  {statusLabel(agent.status)}
                </span>
              </Link>
            ))
          )}
        </Card>
        <div className="grid gap-4">
          <Card title="Inbox" icon={<Inbox size={16} />} to="/inbox" action="Open">
            <p className="px-3 py-4 text-sm text-muted">
              {unreadInbox > 0 ? `${unreadInbox} unread: mentions, approvals and what needs you.` : "Nothing waiting on you."}
            </p>
          </Card>
          <Card title="Docs" icon={<BookOpen size={16} />} to={`/${slug}/-/docs`} action="Learn more">
            <p className="px-3 py-4 text-sm text-muted">Specs, runbooks and decisions, kept current by agents. Coming soon.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
