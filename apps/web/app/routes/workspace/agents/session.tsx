import { ArrowLeft,
  Ban,
  BookmarkPlus,
  Check,
  CircleAlert,
  CircleDot,
  CornerDownRight,
  EyeOff,
  Flag,
  GitBranch,
  Lock,
  Megaphone,
  MessageSquare,
  Send,
  Square,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link, data, redirect, useFetcher } from "react-router";

import type { AgentSession, AgentSessionDetail, SessionEvent } from "@g1t/contracts";

import type { Route } from "./+types/session";
import { AgentAvatar } from "../../../components/agent-avatar";
import { agentsAction, answer } from "../../../components/agents/actions.server";
import { type ActionResult, ApproveDialog, Confirm } from "../../../components/agents/dialogs";
import { isLive, kindLabel, sessionRows, whereLabel } from "../../../components/agents/format";
import { KindBadge, Meter, PrivateTitle, SpendOfCap, StatusChip, sessionHref, stepsLine } from "../../../components/agents/parts";
import { skillsPath } from "../../../components/agents/skills";
import { Markdown } from "../../../components/markdown";
import { ButtonLink, TimeAgo } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { Textarea } from "../../../components/ui/textarea";
import { microsFromDollars } from "../../../lib/agent-form";
import { channelPath } from "../../../lib/chat";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { useRefreshWhile } from "../../../lib/refresh";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const session = loaderData?.detail?.session;
  const title = session?.visible ? session.title : "A session";
  return page(args, { title: `${title} · @${params.handle} · ${params.owner} · g1t` });
}

/** One session: its transcript, its tree, what it produced, and what the viewer may do to it. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ detail: AgentSessionDetail | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await workspaceAgents.session(params.owner.toLowerCase(), params.id, viewer).catch(() => null);
  if (found && !found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  const detail = found?.ok ? found.value : null;
  // A session is under the agent that runs it.
  if (detail && detail.session.agent_handle !== params.handle.toLowerCase()) {
    throw redirect(`/${params.owner}/-/agents/${detail.session.agent_handle}/sessions/${detail.session.id}`);
  }
  return { detail };
}

/** Stop it (and everything under it), approve more spend, or say something to it. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  if (intent === "stop") return answer(intent, workspaceAgents.stopSession(slug, params.id, viewer));
  if (intent === "approve") {
    const cap = microsFromDollars(form.get("cap"));
    if (cap == null || Number.isNaN(cap)) return { ok: false, intent, error: "Write the new cap in dollars, such as 5 or 2.50." };
    return answer(intent, workspaceAgents.approveSession(slug, params.id, viewer, cap));
  }
  if (intent === "steer") {
    const body = String(form.get("body") ?? "").trim();
    if (!body) return { ok: false, intent, error: "Write something to send." };
    return answer(intent, workspaceAgents.steerSession(slug, params.id, viewer, body));
  }
  // Save as skill: the agent drafts one from this session, for a person to review.
  if (intent === "save_skill") {
    const drafted = await skillLibrary.draftFromSession(slug, viewer, params.id).catch(() => null);
    if (!drafted) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
    if (!drafted.ok) return { ok: false, intent, error: drafted.error.message };
    throw redirect(skillsPath(slug, drafted.value.skill.name, drafted.value.skill.can_edit ? "/edit" : ""));
  }
  return { ok: false, intent, error: "Unknown request." };
}

export default function SessionPage({ loaderData, params }: Route.ComponentProps) {
  const { detail } = loaderData;
  const slug = params.owner;
  const live = Boolean(detail && isLive(detail.session.status));
  useRefreshWhile(live);
  const back = (
    <Link to={`/${slug}/-/agents/${params.handle}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Sessions
    </Link>
  );
  if (!detail) {
    return (
      <div className="space-y-4">
        {back}
        <Card tone="plain" className="border-dashed px-6 py-14 text-center">
          <p className="font-medium">This session can&apos;t be shown right now</p>
          <p className="mt-1.5 text-sm text-muted">The agents service didn&apos;t answer. Reload in a moment.</p>
        </Card>
      </div>
    );
  }
  const { session, events, tree } = detail;
  return (
    <div className="space-y-8">
      {back}
      <Header slug={slug} detail={detail} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-6">
          {!session.visible ? (
            <Card className="flex items-start gap-3 px-4 py-4 text-sm text-muted">
              <Lock size={16} className="mt-0.5 shrink-0 text-faint" />
              <p>
                This session came from a conversation you&apos;re not in. You can see that it ran, how far it got and what it cost, but not what it was about.
              </p>
            </Card>
          ) : (
            <>
              {session.summary && !events.some((e) => e.kind === "result") && <Report body={session.summary} />}
              <Transcript events={events} agentHandle={session.agent_handle} agentSeed={session.agent_avatar_seed} live={live} />
              {detail.can_steer && <Steer session={session} live={live} />}
            </>
          )}
        </div>
        <aside className="space-y-6">
          <TreePanel slug={slug} tree={tree} current={session.id} />
          {session.visible && <Outputs slug={slug} session={session} />}
        </aside>
      </div>
    </div>
  );
}

function Header({ slug, detail }: { slug: string; detail: AgentSessionDetail }) {
  const { session } = detail;
  const chat = session.visible
    ? `${channelPath(slug, { id: session.channel_id, kind: session.channel_kind, name: session.channel_name })}${session.card_message_id ? `?thread=${encodeURIComponent(session.card_message_id)}` : ""}`
    : null;
  return (
    <header className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={session.kind} subagent={session.subagent} />
        <StatusChip status={session.status} />
      </div>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-balance sm:text-2xl">
        {session.visible ? session.title || "Untitled session" : <PrivateTitle className="not-italic" />}
      </h1>
      {session.visible && session.status_note && (
        <p className={cn("mt-2 text-sm", session.status === "failed" ? "text-danger" : session.status === "needs_approval" ? "text-warn" : "text-muted")}>{session.status_note}</p>
      )}
      <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="Agent">
          <Link to={`/${slug}/-/agents/${session.agent_handle}`} className="inline-flex items-center gap-1.5 hover:underline">
            <AgentAvatar agent={{ handle: session.agent_handle, avatar_seed: session.agent_avatar_seed }} size={18} />
            {session.agent_name}
          </Link>
        </Meta>
        <Meta label="Asked by">{session.visible && session.asked_by_username ? `@${session.asked_by_username}` : session.kind === "routine" ? "A routine" : "—"}</Meta>
        <Meta label="Where">{session.visible ? whereLabel(session) : "A conversation you're not in"}</Meta>
        <Meta label="Started">
          <TimeAgo at={session.created_at} />
          {session.finished_at && (
            <span className="text-faint">
              {" "}
              · ended <TimeAgo at={session.finished_at} />
            </span>
          )}
        </Meta>
        <Meta label="Model">{session.model ? <span className="font-mono text-[0.8125rem]">{session.model}</span> : "—"}</Meta>
        <Meta label="Work">{stepsLine(session)}</Meta>
        <Meta label="Tokens">
          <span className="tabular-nums">
            {session.input_tokens.toLocaleString("en-US")} in · {session.output_tokens.toLocaleString("en-US")} out
          </span>
        </Meta>
        <Meta label={session.parent_id ? "Spent (paid by its root)" : "Spent"}>
          <SpendOfCap spent={session.charged_micros} cap={session.cap_micros} />
          {session.cap_micros != null && <Meter spent={session.charged_micros} cap={session.cap_micros} label="Spent of its cap" size="sm" className="mt-1.5" />}
        </Meta>
      </dl>
      {(detail.can_stop || detail.can_approve || chat) && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          {detail.can_approve && (
            <ApproveDialog
              slug={slug}
              session={session}
              trigger={
                <Button type="button" variant="accent">
                  <Check size={15} />
                  Approve more…
                </Button>
              }
            />
          )}
          {chat && (
            <ButtonLink to={chat} variant="outline">
              <MessageSquare size={15} />
              Open in chat
            </ButtonLink>
          )}
          {session.visible && session.status === "done" && <SaveAsSkill agentName={session.agent_name} />}
          {detail.can_stop && (
            <Confirm
              title="Stop this session?"
              confirm="Stop session"
              fields={{ intent: "stop" }}
              fetcherKey={`stop-${session.id}`}
              trigger={
                <Button type="button" variant="outline" className="hover:border-danger/50 hover:text-danger">
                  <Square size={13} />
                  Stop
                </Button>
              }
            >
              {session.agent_name} stops where it is, and so does every session it started. What it spent so far stays spent; its card in the conversation says it was
              stopped.
            </Confirm>
          )}
        </div>
      )}
    </header>
  );
}

/** Save as skill: the agent drafts a skill from this session; a person reviews it before any agent uses it. */
function SaveAsSkill({ agentName }: { agentName: string }) {
  const fetcher = useFetcher<ActionResult>({ key: "save-skill" });
  const busy = fetcher.state !== "idle";
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <fetcher.Form method="post" className="contents">
      <input type="hidden" name="intent" value="save_skill" />
      <Hint label={`${agentName} drafts a skill from this session, so the work can be done the same way again. It is billed like a short step, and no agent uses it until it is reviewed and published.`}>
        <Button type="submit" variant="outline" disabled={busy}>
          <BookmarkPlus size={15} />
          {busy ? "Drafting…" : "Save as skill"}
        </Button>
      </Hint>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </fetcher.Form>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

const OUTCOMES: Record<string, { icon: ReactNode; label: string }> = {
  allowed: { icon: <Check size={13} className="text-success" />, label: "Read" },
  withheld: { icon: <EyeOff size={13} className="text-warn" />, label: "Withheld: the audience can't see it" },
  refused: { icon: <Ban size={13} className="text-danger" />, label: "Refused" },
  error: { icon: <CircleAlert size={13} className="text-danger" />, label: "Failed" },
};

/** The session's transcript, oldest first: its goal, what it said and did, who steered it, and its report. */
function Transcript({ events, agentHandle, agentSeed, live }: { events: SessionEvent[]; agentHandle: string; agentSeed: string; live: boolean }) {
  if (events.length === 0) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">{live ? "Getting started…" : "Nothing was recorded for this session."}</p>;
  }
  return (
    <section aria-label="Transcript">
      <ol className="relative space-y-1 before:absolute before:top-3 before:bottom-3 before:left-[0.6875rem] before:w-px before:bg-line">
        {events.map((event) => (
          <EventItem key={event.seq} event={event} agentHandle={agentHandle} agentSeed={agentSeed} />
        ))}
        {live && (
          <li className="relative flex items-center gap-3 py-2 pl-0 text-sm text-faint">
            <span className="relative z-10 flex size-6 items-center justify-center rounded-full bg-bg">
              <CircleDot size={13} className="animate-pulse text-accent motion-reduce:animate-none" />
            </span>
            Working…
          </li>
        )}
      </ol>
    </section>
  );
}

function Rail({ children }: { children: ReactNode }) {
  return <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-bg ring-1 ring-line">{children}</span>;
}

function EventItem({ event, agentHandle, agentSeed }: { event: SessionEvent; agentHandle: string; agentSeed: string }) {
  const when = (
    <span className="ml-auto shrink-0 text-[0.6875rem] text-faint">
      <TimeAgo at={event.created_at} />
    </span>
  );
  switch (event.kind) {
    case "goal":
      return (
        <li className="relative flex gap-3 py-2">
          <Rail>
            <Flag size={12} className="text-accent" />
          </Rail>
          <div className="min-w-0 grow rounded-lg border border-accent/30 bg-accent/[0.06] px-3.5 py-2.5">
            <p className="flex items-center gap-2 text-xs font-medium text-accent">Goal{when}</p>
            <p className="mt-1 text-sm whitespace-pre-wrap wrap-break-word text-fg">{event.body}</p>
          </div>
        </li>
      );
    case "text":
      return (
        <li className="relative flex gap-3 py-2">
          <span className="relative z-10 shrink-0">
            <AgentAvatar agent={{ handle: event.by ?? agentHandle, avatar_seed: event.by && event.by !== agentHandle ? event.by : agentSeed }} size={24} />
          </span>
          <div className="min-w-0 grow">
            <p className="flex items-center gap-2 text-xs text-muted">
              <span className="font-medium text-fg">{event.by ? `@${event.by}` : "g1t"}</span>
              {when}
            </p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap wrap-break-word text-fg-soft">{event.body}</p>
          </div>
        </li>
      );
    case "tool": {
      const outcome = OUTCOMES[event.outcome ?? ""] ?? { icon: <Wrench size={12} className="text-faint" />, label: event.outcome ?? "Called" };
      const long = event.body.length > 140;
      return (
        <li className="relative flex gap-3 py-1">
          <Rail>
            <Hint label={outcome.label}>
              <span className="flex" aria-label={outcome.label}>
                {outcome.icon}
              </span>
            </Hint>
          </Rail>
          <div className="min-w-0 grow pt-0.5">
            {long ? (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-[0.8125rem] [&::-webkit-details-marker]:hidden">
                  <span className="font-mono text-fg">{event.tool ?? "tool"}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-faint group-open:hidden">{event.body}</span>
                  {when}
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted">{event.body}</pre>
              </details>
            ) : (
              <p className="flex items-center gap-2 text-[0.8125rem]">
                <span className="font-mono text-fg">{event.tool ?? "tool"}</span>
                <span className="min-w-0 truncate font-mono text-xs text-faint">{event.body}</span>
                {when}
              </p>
            )}
          </div>
        </li>
      );
    }
    case "steer":
      return (
        <li className="relative flex gap-3 py-2">
          <Rail>
            <MessageSquare size={12} className="text-info" />
          </Rail>
          <div className="min-w-0 grow rounded-lg border border-info/30 bg-info/[0.06] px-3.5 py-2.5">
            <p className="flex items-center gap-2 text-xs text-info">
              <span className="font-medium">{event.by ? `@${event.by}` : "Someone"}</span> steered it{when}
            </p>
            <p className="mt-1 text-sm whitespace-pre-wrap wrap-break-word text-fg">{event.body}</p>
          </div>
        </li>
      );
    case "update":
      return (
        <li className="relative flex gap-3 py-2">
          <Rail>
            <Megaphone size={12} className="text-muted" />
          </Rail>
          <div className="min-w-0 grow">
            <p className="flex items-center gap-2 text-xs text-muted">Posted an update in the conversation{when}</p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap wrap-break-word text-fg-soft">{event.body}</p>
          </div>
        </li>
      );
    case "child":
      return (
        <li className="relative flex gap-3 py-2">
          <Rail>
            <GitBranch size={12} className="text-merged" />
          </Rail>
          <div className="min-w-0 grow">
            <p className="flex items-center gap-2 text-xs text-muted">
              {event.by ? <span className="font-medium text-fg">@{event.by}</span> : null} reported back{when}
            </p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap wrap-break-word text-fg-soft">{event.body}</p>
          </div>
        </li>
      );
    case "result":
      return (
        <li className="relative flex gap-3 py-2">
          <Rail>
            <Check size={12} className="text-success" />
          </Rail>
          <div className="min-w-0 grow">
            <Report body={event.body} when={event.created_at} />
          </div>
        </li>
      );
    default:
      return (
        <li className="relative flex gap-3 py-1.5">
          <Rail>
            <CircleDot size={11} className="text-faint" />
          </Rail>
          <p className="flex min-w-0 grow items-center gap-2 pt-0.5 text-xs text-faint italic">
            <span className="min-w-0">{event.body}</span>
            {when}
          </p>
        </li>
      );
  }
}

/** What it found or did: its report, rendered. */
function Report({ body, when }: { body: string; when?: string }) {
  return (
    <section className="rounded-xl border border-success/30 bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs font-medium text-success">
        Report
        {when && (
          <span className="ml-auto font-normal text-faint">
            <TimeAgo at={when} />
          </span>
        )}
      </header>
      <div className="px-4 py-3 text-sm">
        <Markdown source={body} />
      </div>
    </section>
  );
}

/** Say something to the session: it reads it before its next step, or picks back up if it had finished. */
function Steer({ session, live }: { session: AgentSession; live: boolean }) {
  const fetcher = useFetcher<ActionResult>({ key: `steer-${session.id}` });
  const form = useRef<HTMLFormElement>(null);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <Card asChild className="p-3 focus-within:border-accent-dim">
      <fetcher.Form ref={form} method="post">
        <input type="hidden" name="intent" value="steer" />
        <label htmlFor="steer" className="sr-only">
          Message this session
        </label>
        <Textarea
          id="steer"
          name="body"
          rows={2}
          maxLength={4000}
          required
          placeholder={live ? `Message this session: ${session.agent_name} reads it before its next step` : `Message this session: ${session.agent_name} picks it back up`}
          className="min-h-14 border-0 bg-transparent px-1 hover:border-0 focus-visible:ring-0"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-faint">
            {fetcher.data && !fetcher.data.ok ? <span className="text-danger">{fetcher.data.error}</span> : live ? "It reads this before its next step." : "It picks the session back up with everything it knew."}
          </p>
          <Button type="submit" disabled={busy} variant="accent" size="sm">
            <Send size={14} />
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </fetcher.Form>
    </Card>
  );
}

/** Every session in this one's tree, root first, each under the one that started it. */
function TreePanel({ slug, tree, current }: { slug: string; tree: AgentSession[]; current: string }) {
  const rows = sessionRows(tree);
  return (
    <section>
      <h2 className="text-xs font-medium tracking-wide text-faint uppercase">Session tree</h2>
      {rows.length <= 1 ? (
        <p className="mt-2 text-sm text-muted">It hasn&apos;t brought in a colleague or a subagent. If it does, they show here, paid from this session.</p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {rows.map(({ session, depth }) => {
            const here = session.id === current;
            const body = (
              <>
                {depth > 0 && <CornerDownRight size={12} className="shrink-0 text-faint" />}
                <AgentAvatar agent={{ handle: session.agent_handle, avatar_seed: session.agent_avatar_seed }} size={18} />
                <span className="min-w-0 grow">
                  <span className="block truncate text-[0.8125rem]">{session.visible ? session.title : "A private session"}</span>
                  <span className="block truncate text-[0.6875rem] text-faint">
                    {session.subagent ? `${session.agent_name} · ${session.subagent}` : session.agent_name} · {kindLabel(session.kind)}
                  </span>
                </span>
                <StatusChip status={session.status} className="px-1.5" />
              </>
            );
            return (
              <li key={session.id} style={{ paddingLeft: `${depth * 0.875}rem` }}>
                {here ? (
                  <div className="flex items-center gap-2 rounded-md bg-raised px-2 py-1.5" aria-current="page">
                    {body}
                  </div>
                ) : session.visible ? (
                  <Link to={sessionHref(slug, session)} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised/60">
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-muted">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">Everything in the tree is charged to the agent at its root.</p>
    </section>
  );
}

/** What it produced: issues filed, sessions started, memories kept. */
function Outputs({ slug, session }: { slug: string; session: AgentSession }) {
  return (
    <section>
      <h2 className="text-xs font-medium tracking-wide text-faint uppercase">What it produced</h2>
      {session.outputs.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing yet. Issues it files, sessions it starts and facts it keeps show here.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {session.outputs.map((output, i) => (
            <li key={i} className="text-sm">
              {output.kind === "issue" ? (
                <Link to={`/${output.repo}/issues/${output.number}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised/60">
                  <CircleDot size={14} className="mt-0.5 shrink-0 text-success" />
                  <span className="min-w-0">
                    <span className="block truncate">{output.title}</span>
                    <span className="block font-mono text-[0.6875rem] text-faint">
                      {output.repo}#{output.number}
                    </span>
                  </span>
                </Link>
              ) : output.kind === "session" ? (
                <Link to={`/${slug}/-/agents/${output.agent_handle}/sessions/${output.id}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised/60">
                  <GitBranch size={14} className="mt-0.5 shrink-0 text-merged" />
                  <span className="min-w-0">
                    <span className="block truncate">{output.title}</span>
                    <span className="block text-[0.6875rem] text-faint">Session for @{output.agent_handle}</span>
                  </span>
                </Link>
              ) : (
                <Link to={`/${slug}/-/agents/${session.agent_handle}/memory`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised/60">
                  <BookmarkPlus size={14} className="mt-0.5 shrink-0 text-accent" />
                  <span className="min-w-0">
                    <span className="line-clamp-2">{output.body}</span>
                    <span className="block text-[0.6875rem] text-faint">Kept in memory</span>
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
