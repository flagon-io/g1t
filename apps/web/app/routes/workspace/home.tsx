import { ArrowRight, AtSign, GitPullRequest, Inbox, MessagesSquare, Sparkles } from "lucide-react";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { Await, Form, Link, data, redirect, useNavigation } from "react-router";

import { type ChatSidebarEntry, type InboxItem, type WorkspaceAgent, hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import { AgentFace } from "../../components/agents-mode";
import { MemberAvatar, StatusDot, statusLabel } from "../../components/chat/marks";
import { InboxCard } from "../../components/inbox";
import { G1tMark, isOrchestrator } from "../../components/orchestrator";
import { Skeleton } from "../../components/ui/skeleton";
import { channelPath } from "../../lib/chat";
import { sidebarOrNull } from "../../lib/chat.server";
import { greetingFor, hourIn, readCookie } from "../../lib/mission";
import type { NeedRow } from "../../lib/mission-control";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { chat, inbox, workspaceAgents } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/** Unread inbox items read, and how many Home shows. */
const INBOX_READ = 30;
const INBOX_SHOWN = 4;
/** Most rows in each of Home's lists. */
const ROWS = 5;

/**
 * Home: what needs you across the workspace, never one mode's sidebar.
 * Each section is read at once and on its own, and one whose service does
 * not answer is left saying so. Reviews and approvals come from Code's
 * Overview, the slowest part, so they arrive after the page does.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug) ?? null;
  const code = hasCodeAccess(membership);
  // Streamed: the page shows without waiting for it.
  const reviews: Promise<NeedRow[] | null> | null = code
    ? loadMissionControl(viewer, request, slug)
        .then(({ value }) => value.needs.slice(0, ROWS))
        .catch(() => null)
    : null;
  const [sidebar, agents, unread] = await Promise.all([
    sidebarOrNull(slug, viewer),
    workspaceAgents.list(slug, viewer).catch(() => null),
    inbox.list(viewer, { unread: true, limit: INBOX_READ }).catch(() => null),
  ]);
  const tz = readCookie(request.headers.get("cookie"), "g1t_tz");
  const listed = agents?.ok ? agents.value.filter((agent) => !agent.archived_at) : null;
  const items: InboxItem[] | null = unread?.items ?? null;
  return {
    slug,
    code,
    name: viewer.username,
    greeting: greetingFor(hourIn(Date.now(), tz)),
    chat: sidebar
      ? sidebar.entries
          .filter((entry) => !entry.muted && (entry.mentions > 0 || (entry.channel.kind === "dm" && entry.unread > 0)))
          .sort((a, b) => b.mentions - a.mentions || (b.channel.last_message_at ?? "").localeCompare(a.channel.last_message_at ?? ""))
      : null,
    agents: listed,
    orchestrator: listed?.find(isOrchestrator) ?? null,
    inbox: items ? [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, INBOX_SHOWN) : null,
    inboxTotal: items?.length ?? 0,
    reviews,
  };
}

/**
 * Ask g1t: the direct message with the workspace's orchestrator, opened or
 * made, with what was asked posted in it; then that conversation.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const form = await request.formData();
  const body = String(form.get("body") ?? "").trim();
  if (!body) return { error: "Write what you need." };
  const listed = await workspaceAgents.list(slug, viewer).catch(() => null);
  const g1t = listed?.ok ? listed.value.find(isOrchestrator) : null;
  if (!g1t) return { error: "g1t isn't reachable right now. Try again in a moment." };
  const dm = await chat.openDm(slug, viewer, [{ kind: "agent", id: g1t.id }]).catch(() => null);
  if (!dm?.ok) return { error: dm ? dm.error.message : "Chat didn't answer. Try again in a moment." };
  const posted = await chat.post(slug, dm.value.id, viewer, { body }).catch(() => null);
  if (!posted?.ok) return { error: posted ? posted.error.message : "Your message didn't send. Try again." };
  throw redirect(channelPath(slug, dm.value));
}

function Section({
  icon,
  title,
  count,
  to,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number | null;
  to: string;
  action: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
        <span className="text-muted">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {count != null && count > 0 && (
          <span className="rounded-full bg-accent/15 px-1.5 text-[0.6875rem] font-semibold text-accent tabular-nums">{count}</span>
        )}
        <Link to={to} className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-fg">
          {action}
          <ArrowRight size={12} />
        </Link>
      </header>
      <div className="grow p-2">{children}</div>
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-sm text-muted">{children}</p>;
}

function ChatRow({ entry, slug }: { entry: ChatSidebarEntry; slug: string }) {
  const other = entry.others[0];
  return (
    <Link to={channelPath(slug, entry.channel)} className="flex h-11 items-center gap-3 rounded-lg px-3 transition-colors hover:bg-raised/60">
      <span className="flex w-6 justify-center">
        {entry.channel.kind === "dm" && other ? <MemberAvatar member={other} size={22} /> : <span className="font-semibold text-faint">#</span>}
      </span>
      <span className="min-w-0 grow">
        <span className="block truncate text-sm font-medium text-fg">{entry.title}</span>
        <span className="block truncate text-xs text-faint">
          {entry.mentions > 0 ? `${entry.mentions} ${entry.mentions === 1 ? "mention" : "mentions"}` : `${entry.unread} unread`}
        </span>
      </span>
      <span
        className={`rounded-full px-1.5 text-[0.6875rem] leading-[1.125rem] font-semibold tabular-nums ${entry.mentions > 0 ? "bg-accent text-bg" : "bg-line-strong text-fg"}`}
      >
        {entry.mentions || entry.unread}
      </span>
    </Link>
  );
}

function AgentRow({ agent, slug }: { agent: WorkspaceAgent; slug: string }) {
  return (
    <Link to={`/${slug}/-/agents/${agent.handle}`} className="flex h-12 items-center gap-3 rounded-lg px-3 transition-colors hover:bg-raised/60">
      <AgentFace agent={{ ...agent, builtin: isOrchestrator(agent) }} size={26} />
      <span className="min-w-0 grow">
        <span className="block truncate text-sm font-medium">{agent.display_name}</span>
        <span className="block truncate text-xs text-faint">{agent.role}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <StatusDot status={agent.status} />
        {statusLabel(agent.status)}
      </span>
    </Link>
  );
}

function ReviewRow({ row }: { row: NeedRow }) {
  return (
    <Link to={row.to} className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-raised/60">
      <GitPullRequest size={16} className="mt-0.5 shrink-0 text-warn" />
      <span className="min-w-0 grow">
        <span className="block truncate text-sm font-medium text-fg">{row.title}</span>
        <span className="line-clamp-2 text-xs text-muted">
          {row.repo ? `${row.repo.name}${row.ref ? ` ${row.ref}` : ""} · ` : ""}
          {row.ask}
        </span>
      </span>
    </Link>
  );
}

/** Ask g1t: the orchestrator, from Home. Enter sends; Shift+Enter is a new line. */
function AskG1t({ slug, available, error }: { slug: string; available: boolean; error: string | null }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formAction === `/${slug}/-/home`;
  const [text, setText] = useState("");
  return (
    <Form method="post" action={`/${slug}/-/home`} className="rounded-2xl border border-line-strong bg-surface transition-colors focus-within:border-accent/40">
      <div className="flex items-center gap-2 px-4 pt-3.5 text-sm font-medium">
        <G1tMark size={20} />
        Ask g1t
        <span className="hidden font-normal text-faint sm:inline">It knows the team and hands work to the right agent.</span>
      </div>
      <textarea
        name="body"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (text.trim()) event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={2}
        disabled={!available}
        aria-label="Ask g1t"
        placeholder={available ? "Get the flaky checks fixed and tell #support when it ships…" : "g1t isn't reachable right now."}
        className="block w-full resize-none bg-transparent px-4 pt-2.5 pb-1 text-[0.9375rem] leading-relaxed text-fg outline-none placeholder:text-faint disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-3 px-3 pb-3">
        {error ? <p className="text-sm text-danger">{error}</p> : <p className="hidden pl-1 text-xs text-faint sm:block">Opens your conversation with g1t in Chat.</p>}
        <button
          type="submit"
          disabled={!available || busy || !text.trim()}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:bg-line disabled:text-faint"
        >
          {busy ? "Sending…" : "Ask"}
          <ArrowRight size={14} />
        </button>
      </div>
    </Form>
  );
}

export default function WorkspaceHome({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, code, name, chat: mentions, agents, orchestrator, inbox: items, inboxTotal, reviews } = loaderData;
  const [greeting, setGreeting] = useState(loaderData.greeting);
  // The reader's own clock.
  useEffect(() => setGreeting(greetingFor(new Date().getHours())), []);
  const waiting = agents?.filter((agent) => agent.status === "waiting") ?? null;
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight" suppressHydrationWarning>
          {greeting}, {name}
        </h1>
        <p className="mt-1.5 text-sm text-muted">Everything that needs you, across chat, agents{code ? ", code" : ""} and your inbox.</p>
      </header>

      <AskG1t slug={slug} available={orchestrator != null} error={actionData?.error ?? null} />

      <div>
        <h2 className="mb-3 text-sm font-semibold text-fg-soft">Needs you across everything</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Section icon={<AtSign size={15} />} title="Mentions and DMs" count={mentions?.length} to={`/${slug}/-/chat`} action="Open Chat">
            {mentions == null ? (
              <Quiet>Chat didn&apos;t answer. Your mentions show here once it does.</Quiet>
            ) : mentions.length === 0 ? (
              <Quiet>No unread mentions or messages.</Quiet>
            ) : (
              mentions.slice(0, ROWS).map((entry) => <ChatRow key={entry.channel.id} entry={entry} slug={slug} />)
            )}
          </Section>
          <Section icon={<Sparkles size={15} />} title="Agents waiting on you" count={waiting?.length} to={`/${slug}/-/agents`} action="Open Agents">
            {waiting == null ? (
              <Quiet>The agents service didn&apos;t answer.</Quiet>
            ) : waiting.length === 0 ? (
              <Quiet>No agent is waiting on you.</Quiet>
            ) : (
              waiting.slice(0, ROWS).map((agent) => <AgentRow key={agent.id} agent={agent} slug={slug} />)
            )}
          </Section>
          {code && reviews && (
            <Section icon={<GitPullRequest size={15} />} title="Reviews and approvals" to={`/${slug}/-/overview`} action="Open Code">
              <Suspense fallback={<RowsSkeleton />}>
                <Await resolve={reviews}>
                  {(rows) =>
                    rows == null ? (
                      <Quiet>Code&apos;s reviews couldn&apos;t be read right now.</Quiet>
                    ) : rows.length === 0 ? (
                      <Quiet>Nothing to review or approve.</Quiet>
                    ) : (
                      rows.map((row) => <ReviewRow key={row.key} row={row} />)
                    )
                  }
                </Await>
              </Suspense>
            </Section>
          )}
          <Section icon={<Inbox size={15} />} title="From your inbox" count={inboxTotal} to="/inbox" action="Open Inbox">
            {items == null ? (
              <Quiet>Your inbox couldn&apos;t be read right now.</Quiet>
            ) : items.length === 0 ? (
              <Quiet>Nothing unread.</Quiet>
            ) : (
              <ul className="space-y-2 p-1">
                {items.map((item) => (
                  <InboxCard key={item.id} item={item} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
      {!code && (
        <p className="flex items-center gap-2 text-xs text-faint">
          <MessagesSquare size={13} />
          Your membership includes Chat, Docs, Agents and the Inbox.
        </p>
      )}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-3 px-3 py-3" aria-busy="true">
      {[70, 55, 62].map((w) => (
        <div key={w} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
