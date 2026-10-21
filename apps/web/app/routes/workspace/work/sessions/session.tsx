import { ArrowLeft, Bot, ChevronRight, ExternalLink, GitBranch, GitCommitHorizontal, LoaderCircle, Pencil, ShieldAlert, Sparkles, Square } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, redirect } from "react-router";

import { MAX_PROMPT_CHARS, type Pull, type SessionLink, type SessionTouch, type State, type Thread, type TouchKind, type WorkSession } from "@g1t/contracts";

import type { Route } from "./+types/session";
import { page } from "../../../../lib/meta";
import { Actor, CoordinationFeed, EndSessionDialog, HarnessBadge, SessionStateBadge } from "../../../../components/coordination";
import { Unavailable } from "../../../../components/boundary";
import { ApprovalCard, SessionMessageBox } from "../../../../components/session-answer";
import { SessionEntries, entryAnchor } from "../../../../components/session-entries";
import { ActivityBars, AskedBubble, Deliverables, FileNames, Highlights, SessionAnswer, StatTile, WorkedFor } from "../../../../components/session-story";
import { EmptyState, Input, SubmitButton, TimeAgo } from "../../../../components/ui";
import { Alert } from "../../../../components/ui/alert";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../../components/ui/collapsible";
import { Hint } from "../../../../components/ui/hint";
import { PersonLink } from "../../../../components/work";
import { ItemIcon, PullIcon } from "../../../../components/work-icons";
import { itemPath } from "../../../../lib/refs";
import { accessTo } from "../../../../lib/access.server";
import {
  type SessionNode,
  TOUCH_KINDS,
  duration,
  endReasonText,
  harnessName,
  mayEndSession,
  pendingLines,
  sessionTitle,
  sessionTree,
  titleHint,
  titleIsProvisional,
  touchedByKind,
  viaLabel,
} from "../../../../lib/coordination";
import { repoAt } from "../../../../lib/markdown-plugins";
import { notFound } from "../../../../lib/not-found.server";
import { isFailed, part } from "../../../../lib/partial";
import { activity, deliverables, filesTouched, highlights, sessionAnswer } from "../../../../lib/session-story";
import { sessionCost } from "../../../../lib/sessions";
import { repoPages } from "../../../../lib/repo-live";
import { agentSessions, work } from "../../../../lib/services.server";
import { readAnswer, readMessage } from "../../../../lib/session-approvals";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../../../lib/session.server";
import { useLive } from "../../../../lib/use-repo-live";
import { useSessionFollow } from "../../../../lib/use-session-follow";
import { continuation } from "../../../../lib/agent-chat";
import { sessionPath, sessionsPath } from "../../../../lib/work-items";

const MANAGED = "claude_managed_agents";

/**
 * What a session is called: its title, a subagent's kind and task, else
 * what its first prompt was for, its branch, or "Untitled session".
 */
function sessionName(session: WorkSession, firstPrompt?: string | null): string {
  if (!session.title?.trim() && session.parentId) return [session.agentType ?? "Subagent", session.task].filter(Boolean).join(": ");
  return sessionTitle(session, firstPrompt ?? session.firstPrompt);
}

/** The workspace of the repository at `base` (`/acme/web`): its work items are numbered there. */
function workspaceOf(base: string): string {
  return base.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

/** The repository `owner/name` as a path to look it up by. */
function repoPath(repo: string): { namespace: string; name: string } {
  const [namespace = "", name = ""] = repo.split("/");
  return { namespace, name };
}

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const session = loaderData?.session;
  const firstPrompt = loaderData?.entries.find((entry) => entry.kind === "prompt")?.text;
  const name = session ? `${sessionName(session, firstPrompt)} · ` : "";
  return page(args, { title: `${name}Session · ${loaderData?.repo ?? params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const read = () => work.getWorkspaceSession(workspace, params.id, viewer);
  // The session is what the page is about: a service that fails fails the
  // page, rather than calling it not found.
  let found = await read();
  if (!found.ok) throw notFound("page");
  const repo = found.value.repo;
  const path = repoPath(repo);
  const access = await accessTo(context, { owner: path.namespace, repo: path.name });
  // A session on the workspace's Anthropic account is followed every
  // minute; while it goes, it is read now, through the top of its tree
  // (at most once every couple of seconds, however many pages ask), and
  // the page keeps following it from there (lib/use-session-follow.ts).
  const top = found.value.root ?? found.value.session;
  let followMark: string | null = null;
  if (top.harness === MANAGED && top.state !== "ended") {
    // Reading it fresh is a nicety: without it, the page shows it as last recorded.
    const followed = await agentSessions.follow(path, top.id, viewer).catch(() => null);
    if (followed?.ok) {
      followMark = followed.value.mark;
      const again = await read().catch(() => null);
      if (again?.ok) found = again;
    }
  }
  const { session } = found.value;
  // Where it opens on the Claude Console, which shows everything it was
  // asked and every tool's output: told to whoever started it, nobody else
  // (the integrations service checks that too). Without it, the page does without the link.
  const consoleUrl =
    viewer && viewer.id === top.actor.id && top.harness === MANAGED
      ? await agentSessions
          .link(viewer, path, top.id)
          .then((linked) => (linked.ok ? linked.value : null))
          .catch(() => null)
      : null;
  // The decisions kept on what it worked on, for its highlights: a part, so
  // the page stands without them and says they could not be read. Someone
  // outside the workspace sees no highlights, so they are not read for them.
  const threads = (found.value.limited ? [] : (found.value.links ?? []))
    .slice(0, 6)
    .map((link): Thread => (link.kind === "pull" ? { repo: path, number: link.number } : { workspace, number: link.number }));
  const decided = await part(Promise.all(threads.map((thread) => work.listDecisions(thread, viewer))), "Decisions");
  const decisions = isFailed(decided) ? null : decided.flatMap((result) => (result.ok ? result.value : []));
  // While a hosted session runs, the people who may answer it (whoever
  // started it, and the workspace's members with write access) see the
  // calls it waits on and a box to message it. The service lists only the
  // calls the viewer may answer, and checks again on every answer.
  const answering = top.harness === MANAGED && top.state !== "ended" && viewer != null;
  const mayMessage = answering && (viewer.id === top.actor.id || (roleIn(viewer, workspace) != null && access.can.push));
  const waiting = answering
    ? await part(
        agentSessions.approvals(viewer, workspace, top.id).then((listed) => (listed.ok ? listed.value : [])),
        "Calls waiting for approval",
      )
    : [];
  return {
    ...found.value,
    decisions,
    workspace,
    repoId: session.repoId,
    signedIn: viewer != null,
    // Only whoever started it stops it, and only the top of the tree.
    canStop: viewer?.id === session.actor.id && session.harness === MANAGED && session.state !== "ended" && !session.parentId,
    // One its harness left behind is ended by hand: by whoever runs it, or anyone with write access.
    canEnd: mayEndSession(session, viewer?.id, access.can.push),
    consoleUrl,
    // Null when they could not be read: the page says so where they would be.
    approvals: isFailed(waiting) ? null : waiting,
    canMessage: mayMessage,
    // Once it has ended, the same people may follow it up: a new session carries on from it.
    canContinue:
      top.harness === MANAGED &&
      top.state === "ended" &&
      !session.parentId &&
      viewer != null &&
      roleIn(viewer, workspace) != null &&
      (viewer.id === top.actor.id || access.can.push),
    followMark,
    // A running hosted session is followed every few seconds by a member's page in view.
    follow: top.harness === MANAGED && top.state !== "ended" && viewer != null && roleIn(viewer, workspace) != null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  // Where it runs: the repository its ending and stopping go to.
  const found = await work.getWorkspaceSession(params.owner.toLowerCase(), params.id, user, 4294967295).catch(() => null);
  if (!found?.ok) return { error: "The session could not be found. Try again in a moment." };
  const path = repoPath(found.value.repo);
  // Ending it by hand (from here, or a list's menu by fetcher); the work service checks who may.
  if (form.get("action") === "end") {
    const ended = await work.endWorkSession(user, path, params.id).catch(() => null);
    if (!ended) return { error: "The session could not be ended. Try again in a moment." };
    return ended.ok ? { ended: true } : { error: ended.error.message };
  }
  // Naming it pins its title; an empty one lets g1t name it again. The work service checks who may.
  if (form.get("action") === "title") {
    const title = String(form.get("title") ?? "").trim();
    if (title.length > 200) return { error: "A title is at most 200 characters." };
    const titled = await work.titleWorkSession(user, path, params.id, title || null).catch(() => null);
    if (!titled) return { error: "The title could not be saved. Try again in a moment." };
    return titled.ok ? { titled: true } : { error: titled.error.message };
  }
  // Answering a hosted session goes to the top of its tree, which holds its
  // calls and takes its messages; the integrations service checks who may
  // and refuses an answer that came too late.
  const top = (found.value.root ?? found.value.session).id;
  if (form.get("action") === "answer") {
    const read = readAnswer(form);
    if ("error" in read) return { error: read.error };
    const answered = await agentSessions.answer(user, path, top, read.toolUseId, read.answer, read.note).catch(() => null);
    if (!answered) return { error: "The answer could not be sent. Try again in a moment." };
    return answered.ok ? { answered: true } : { error: answered.error.message };
  }
  if (form.get("action") === "message") {
    const read = readMessage(form);
    if ("error" in read) return { error: read.error };
    const sent = await agentSessions.message(user, path, top, read.text).catch(() => null);
    if (!sent) return { error: "The message could not be sent. Try again in a moment." };
    return sent.ok ? { sent: true } : { error: sent.error.message };
  }
  // A follow-up to a hosted session that ended: a new session that carries on from it
  // (its branch, pull requests and report), on its work item if it had one; then its page.
  if (form.get("action") === "continue") {
    const read = readMessage(form, MAX_PROMPT_CHARS);
    if ("error" in read) return { error: read.error };
    const ended = found.value.root ?? found.value.session;
    if (ended.harness !== MANAGED || ended.state !== "ended") return { error: "Only a hosted session that has ended is continued in a new one." };
    const url = new URL(sessionPath(params.owner, ended.id), request.url).href;
    const next = continuation({ text: read.text, session: ended, links: found.value.links ?? [], url });
    const started = await agentSessions.start(user, path, { ...next, handoff: false }).catch(() => null);
    if (!started) return { error: "The new session could not be started. Try again in a moment." };
    if (!started.ok) return { error: started.error.message };
    if (!started.value.session) return { error: "No session was started." };
    throw redirect(sessionPath(params.owner, started.value.session.id));
  }
  if (form.get("action") !== "stop") return { error: "There is nothing to do here but stop, end, name, answer or follow up the session." };
  const result = await agentSessions.stop(user, path, params.id).catch(() => null);
  if (!result) return { error: "The session could not be stopped. Try again in a moment." };
  return result.ok ? null : { error: result.error.message };
}

/**
 * The session's name, muted while it is provisional, and for whoever may,
 * a way to name it (pinning it: g1t keeps a person's title) or to let g1t
 * name it again.
 */
function SessionHeading({ session, name, canTitle }: { session: WorkSession; name: string; canTitle: boolean }) {
  const [editing, setEditing] = useState(false);
  const provisional = titleIsProvisional(session);
  if (editing) {
    return (
      <div className="flex min-w-0 grow flex-wrap items-center gap-2">
        <Form method="post" className="flex min-w-0 grow items-center gap-2" onSubmit={() => setEditing(false)}>
          <input type="hidden" name="action" value="title" />
          <Input
            name="title"
            defaultValue={provisional ? "" : (session.title ?? "")}
            placeholder={name}
            maxLength={200}
            required
            autoFocus
            aria-label="Session title"
          />
          <SubmitButton size="xs" match={{ action: "title" }} pending="Saving…">
            Save
          </SubmitButton>
          <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Form>
        {session.titleSource === "person" && (
          <Form method="post" onSubmit={() => setEditing(false)}>
            <input type="hidden" name="action" value="title" />
            <input type="hidden" name="title" value="" />
            <Button type="submit" variant="ghost" size="xs">
              Let g1t name it
            </Button>
          </Form>
        )}
      </div>
    );
  }
  const hint = titleHint(session);
  const text = <span className="min-w-0">{name}</span>;
  return (
    <h2 className={`flex min-w-0 grow items-center gap-1.5 text-lg font-semibold tracking-tight wrap-break-word ${provisional ? "text-muted" : ""}`}>
      {hint ? <Hint label={hint}>{text}</Hint> : text}
      {canTitle && (
        <Hint label="Rename">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Rename this session" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </Button>
        </Hint>
      )}
    </h2>
  );
}

/** Text a session wrote, as it wrote it: cut short, with a way to see it all. */
function LongText({ text, limit = 600 }: { text: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const long = text.length > limit;
  return (
    <div>
      <p className="text-sm whitespace-pre-wrap wrap-break-word text-fg-soft">{long && !all ? `${text.slice(0, limit).trimEnd()}…` : text}</p>
      {long && (
        <Button variant="link" size="inline" className="mt-1 text-xs" onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

/** A work item or pull request it worked on, with how it was tied there. */
function LinkChip({ link, base }: { link: SessionLink; base: string }) {
  const icon =
    link.kind === "pull" ? (
      <PullIcon status={(["open", "draft", "merged", "closed"].includes(link.state) ? link.state : "open") as Pull["status"]} size={12} />
    ) : (
      <ItemIcon item={{ state: (link.state === "closed" ? "closed" : "open") as State, reason: null }} size={12} />
    );
  return (
    <Hint label={`Tied by ${link.via.map(viaLabel).join(", ")}`}>
      <Link to={link.kind === "pull" ? `${base}/pull/${link.number}` : itemPath(workspaceOf(base), link.number)} prefetch="intent">
        <Badge size="md" className="max-w-72 hover:border-line-strong hover:text-fg">
          {icon}
          <span className="truncate">
            {link.title} <span className="text-faint">#{link.number}</span>
          </span>
        </Badge>
      </Link>
    </Hint>
  );
}

/** One thing touched, linked where the site shows it. */
function TouchedValue({ kind, value, base }: { kind: TouchKind; value: string; base: string }) {
  if (kind === "file") return <span className="font-mono text-xs break-all text-fg-soft">{value}</span>;
  const [to, text] =
    kind === "commit"
      ? [`${base}/commit/${value}`, value.slice(0, 7)]
      : kind === "branch"
        ? [`${base}/tree/${value}`, value]
        : [kind === "pull" ? `${base}/pull/${value}` : itemPath(workspaceOf(base), Number(value)), `#${value}`];
  return (
    <Link to={to} className="font-mono text-xs text-fg-soft hover:text-accent">
      {text}
    </Link>
  );
}

const SHOWN = 8;

/** Values of one kind: the first few, and the rest folded. */
function TouchedValues({ kind, values, base }: { kind: TouchKind; values: string[]; base: string }) {
  const [open, setOpen] = useState(false);
  const list = (items: string[]) => (
    <ul className={kind === "file" ? "space-y-0.5" : "flex flex-wrap gap-x-3 gap-y-0.5"}>
      {items.map((value) => (
        <li key={value}>
          <TouchedValue kind={kind} value={value} base={base} />
        </li>
      ))}
    </ul>
  );
  if (values.length <= SHOWN) return list(values);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {list(values.slice(0, SHOWN))}
      <CollapsibleContent>{list(values.slice(SHOWN))}</CollapsibleContent>
      <CollapsibleTrigger className="mt-1 text-xs">
        <ChevronRight size={12} />
        {open ? "Show fewer" : `${values.length - SHOWN} more`}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

/** What was touched, by kind. */
function Touched({ touched, base, kinds }: { touched: SessionTouch[]; base: string; kinds?: TouchKind[] }) {
  const groups = touchedByKind(touched).filter((group) => !kinds || kinds.includes(group.kind));
  if (groups.length === 0) return null;
  return (
    <dl className="space-y-3">
      {groups.map((group) => (
        <div key={group.kind}>
          <dt className="text-xs font-medium text-muted">
            {TOUCH_KINDS[group.kind]} <span className="font-normal text-faint">· {group.values.length}</span>
          </dt>
          <dd className="mt-1">
            <TouchedValues kind={group.kind} values={group.values} base={base} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A subagent in the tree: a line, and folded under it what it touched, what it reported and its own subagents. */
function SubagentNode({ node, base, touched, now }: { node: SessionNode; base: string; touched: SessionTouch[]; now: number }) {
  const [open, setOpen] = useState(false);
  const { session } = node;
  const mine = touched.filter((one) => one.sessionId === session.id);
  return (
    <li className="px-4 py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CollapsibleTrigger aria-label={open ? "Fold" : "Unfold"}>
            <ChevronRight size={14} />
          </CollapsibleTrigger>
          <Bot size={14} className="shrink-0 text-faint" />
          <Link to={sessionPath(workspaceOf(base), session.id)} prefetch="intent" className="shrink-0 text-sm font-medium hover:text-accent">
            {session.agentType ?? "Subagent"}
          </Link>
          {session.task && (
            <Hint label={session.task}>
              <span className="min-w-0 flex-1 truncate text-sm text-muted">{session.task}</span>
            </Hint>
          )}
          <span className="ml-auto flex items-center gap-2 text-xs text-faint">
            {node.children.length > 0 && <Badge>{node.children.length} under it</Badge>}
            <SessionStateBadge state={session.state} />
            <TimeAgo at={session.startedAt} />
            <span suppressHydrationWarning>· {duration(session, now)}</span>
            {sessionCost(session) && <span className="tabular-nums">· {sessionCost(session)}</span>}
          </span>
        </div>
        <CollapsibleContent className="mt-3 space-y-4 pl-6">
          {mine.length > 0 && <Touched touched={mine} base={base} />}
          {session.result ? (
            <div>
              <p className="text-xs font-medium text-muted">What it reported</p>
              <div className="mt-1">
                <LongText text={session.result} limit={400} />
              </div>
            </div>
          ) : (
            mine.length === 0 && <p className="text-xs text-faint">{session.state === "ended" ? "It reported nothing." : "Nothing yet."}</p>
          )}
          {node.children.length > 0 && <SubagentTree nodes={node.children} base={base} touched={touched} now={now} />}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function SubagentTree({ nodes, base, touched, now }: { nodes: SessionNode[]; base: string; touched: SessionTouch[]; now: number }) {
  return (
    <Card asChild divided tone="plain">
      <ol>
        {nodes.map((node) => (
          <SubagentNode key={node.session.id} node={node} base={base} touched={touched} now={now} />
        ))}
      </ol>
    </Card>
  );
}

/** The page's own sections: a heading, then what it holds. */
function Part({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[0.9375rem] font-semibold text-fg">{title}</h2>
        {aside && <span className="text-xs text-faint">{aside}</span>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One harness session, told as an answer: what it was asked, how long it
 * worked, what it came to, a few figures, the highlights with where each
 * comes from, and what it delivered; then its subagents, skills and what it
 * touched; and the transcript, folded under "Worked for" once there is an
 * answer above it, open while it is still the whole story.
 */
export default function WorkSessionPage(props: Route.ComponentProps) {
  // Going from a session to its subagent or back keeps this route: a page of its own for each, so nothing carries over.
  return <SessionPage key={props.loaderData.session.id} {...props} />;
}

function SessionPage({ loaderData, actionData }: Route.ComponentProps) {
  const {
    session,
    entries,
    updates = [],
    children = [],
    touched = [],
    links = [],
    skills = [],
    root,
    decisions,
    canStop,
    canEnd,
    consoleUrl,
    limited,
    workspace,
    repo,
    approvals,
    canMessage,
    canContinue,
    followMark,
    follow,
  } = loaderData;
  const base = `/${repo}`;
  const [ending, setEnding] = useState(false);
  const now = Date.now();
  // Any session, claim or overlap in its repository: a change names no session.
  useLive({ match: repoPages.session(), repos: [{ id: loaderData.repoId, path: repo }], signedIn: loaderData.signedIn });
  // A running hosted session streams in: the page asks every few seconds while in view (lib/use-session-follow.ts).
  const topId = root?.id ?? session.id;
  useSessionFollow({
    url: `/${workspace}/-/chat/sessions/${encodeURIComponent(topId)}/follow?repo=${encodeURIComponent(repo)}`,
    running: follow,
    mark: followMark,
    enabled: follow,
  });
  // Talking to it: the page reads as a chat while it runs, for whoever may answer it.
  const conversation = canMessage && !session.parentId && session.state !== "ended";
  // A reader at the bottom of the conversation stays there as it goes.
  const count = entries.length + (approvals?.length ?? 0);
  useEffect(() => {
    if (!conversation) return;
    const near = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
    if (near) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [conversation, count]);
  useEffect(() => {
    if (conversation && !location.hash) window.scrollTo({ top: document.documentElement.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening it
  }, []);

  const tools = entries.filter((entry) => entry.kind === "tool_call").length;
  const prompt = entries.find((entry) => entry.kind === "prompt");
  const firstPrompt = prompt?.text;
  const isSubagent = Boolean(session.parentId);
  const parent = isSubagent && root?.id === session.parentId ? root : null;
  // Its own subagents: those whose parent is in this tree (children lists every descendant).
  const tree = sessionTree([session, ...children]).find((node) => node.session.id === session.id)?.children ?? [];
  const managed = session.harness === MANAGED || root?.harness === MANAGED;
  const cost = sessionCost(session);
  const live = session.state !== "ended";

  const answer = limited ? null : sessionAnswer(session, entries);
  // The transcript is folded under an answer, and open while it is the whole story, or when a citation points into it.
  const [transcript, setTranscript] = useState(answer == null);
  // A citation into the transcript: unfold it, then, once it is drawn, go to the entry and let the address say so.
  const [cited, setCited] = useState<number | null>(null);
  const cite = (seq: number) => {
    setTranscript(true);
    setCited(seq);
  };
  // A link straight to an entry (`#entry-12`) unfolds the transcript once the page has hydrated, so the server's page and the browser's agree.
  useEffect(() => {
    const seq = Number(/^#entry-(\d+)$/.exec(location.hash)?.[1]);
    if (Number.isFinite(seq) && seq > 0) cite(seq);
  }, []);
  useEffect(() => {
    if (cited == null) return;
    const anchor = entryAnchor(cited);
    history.replaceState(history.state, "", `#${anchor}`);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(anchor)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    setCited(null);
  }, [cited]);

  // The skills, summed by name across the tree.
  const skillUses = new Map<string, number>();
  for (const skill of skills) skillUses.set(skill.name, (skillUses.get(skill.name) ?? 0) + skill.uses);

  const ids = new Set([session.id, ...children.map((child) => child.id)]);
  const told = limited
    ? []
    : highlights(decisions ?? [], entries, ids, (decision) =>
        decision.pull != null ? `${base}/pull/${decision.pull}` : decision.item != null ? itemPath(workspace, decision.item) : null,
      );
  const delivered = deliverables(links, touched);
  const bars = limited ? [] : activity(entries, session.startedAt, session.endedAt, now);
  const files = filesTouched(touched);
  const commits = delivered.find((item) => item.kind === "commits")?.shas.length ?? 0;
  const pulls = links.filter((link) => link.kind === "pull").length;
  // Every commit is listed here, each linked: the Deliverables card links the first.
  const where: TouchKind[] = ["file", "branch", "commit", "item"];
  const groups = touchedByKind(touched);

  if (conversation) {
    const waitingOn = (approvals?.length ?? 0) > 0;
    return (
      <div className="mx-auto flex min-h-(--page-h) max-w-3xl flex-col">
        <Link to={sessionsPath(workspace)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} />
          Sessions
        </Link>
        <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-2">
          <SessionHeading session={session} name={sessionName(session, firstPrompt)} canTitle={canEnd} />
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            <SessionStateBadge state={session.state} />
            {consoleUrl && (
              <Button asChild variant="outline" size="xs">
                <a href={consoleUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} />
                  Claude Console
                </a>
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
          <Actor username={session.actor.username} harness={session.harness} size={16} />
          <PersonLink name={session.actor.username} className="font-medium text-fg-soft hover:underline" />
          <span className="text-faint">in</span>
          <Link to={base} className="font-mono hover:text-fg">
            {repo}
          </Link>
          {session.branch && (
            <Link to={`${base}/tree/${session.branch}`} className="inline-flex items-center gap-1 font-mono hover:text-fg">
              <GitBranch size={11} />
              {session.branch}
            </Link>
          )}
          {session.model && <span className="font-mono text-faint">{session.model}</span>}
          <span className="text-faint" suppressHydrationWarning>
            · working for {duration(session, now)}
          </span>
        </div>
        {links.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {links.map((link) => (
              <LinkChip key={`${link.kind}-${link.number}`} link={link} base={base} />
            ))}
          </div>
        )}
        {actionData?.error && (
          <Alert tone="danger" className="mt-4">
            {actionData.error}
          </Alert>
        )}
        <div className="mt-8 grow space-y-5">
          {entries.length === 0 ? (
            <p className="text-[0.9375rem] text-muted">It is setting up its sandbox: what it says and does shows here as it goes.</p>
          ) : (
            <SessionEntries entries={entries} base={base} variant="chat" />
          )}
          {approvals == null ? (
            <Unavailable what="Calls waiting for approval" compact />
          ) : (
            approvals.map((approval) => <ApprovalCard key={approval.toolUseId} approval={approval} now={now} />)
          )}
          <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            {waitingOn ? (
              <>
                <ShieldAlert size={14} className="text-warn" />
                Waiting for an answer to the call above.
              </>
            ) : (
              <>
                <LoaderCircle size={14} className="animate-spin text-accent motion-reduce:animate-none" />
                Working…
              </>
            )}
          </p>
        </div>
        <SessionMessageBox canStop={canStop} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {isSubagent ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
          <Link to={sessionPath(workspace, session.parentId!)} className="inline-flex items-center gap-1.5 hover:text-fg">
            <ArrowLeft size={14} />
            Subagent of {parent ? sessionName(parent) : "another subagent"}
          </Link>
          {root && root.id !== session.parentId && (
            <>
              <span className="text-faint">in</span>
              <Link to={sessionPath(workspace, root.id)} className="hover:text-fg">
                {sessionName(root)}
              </Link>
            </>
          )}
        </p>
      ) : (
        <Link to={sessionsPath(workspace)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} />
          Sessions
        </Link>
      )}

      {/* Its name, and what can be done with it. */}
      <div className="mt-5 flex flex-wrap items-start gap-x-3 gap-y-2">
        <SessionHeading session={session} name={sessionName(session, firstPrompt)} canTitle={canEnd && !isSubagent} />
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <SessionStateBadge state={session.state} />
          {canStop && (
            <Form method="post">
              <input type="hidden" name="action" value="stop" />
              <SubmitButton variant="destructive" size="xs" match={{ action: "stop" }} pending="Stopping…">
                <Square size={12} />
                Stop
              </SubmitButton>
            </Form>
          )}
          {canEnd && (
            <>
              <Button variant="outline" size="xs" onClick={() => setEnding(true)}>
                <Square size={12} />
                End session
              </Button>
              <EndSessionDialog session={session} base={base} open={ending} onOpenChange={setEnding} />
            </>
          )}
          {consoleUrl && (
            <Button asChild variant="outline" size="xs">
              <a href={consoleUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={12} />
                Claude Console
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* Who ran it, where, and when. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
        <Actor username={session.actor.username} harness={session.harness} size={18} />
        <PersonLink name={session.actor.username} className="font-medium text-fg hover:underline" />
        <span className="text-faint">in</span>
        <Link to={base} className="font-mono text-xs hover:text-fg">
          {repo}
        </Link>
        <span className="text-faint">·</span>
        <span>
          started <TimeAgo at={session.startedAt} />
        </span>
        {/* Whether it is still alive: when it was last heard from, or when and why it ended. */}
        <span>
          · {live ? "last heard from" : "ended"} <TimeAgo at={session.endedAt ?? session.lastSeenAt} />
          {session.endReason && ` (${endReasonText(session.endReason)})`}
        </span>
        {/* Outside the workspace there are no figures below: the cost stays here, as it always was. */}
        {limited && cost && <span className="tabular-nums">· {cost}</span>}
        {session.branch && (
          <Link to={`${base}/tree/${session.branch}`} className="inline-flex items-center gap-1 font-mono text-xs hover:text-fg">
            <GitBranch size={12} />
            {session.branch}
          </Link>
        )}
        {session.headCommit && (
          <Link to={`${base}/commit/${session.headCommit}`} className="inline-flex items-center gap-1 font-mono text-xs hover:text-fg">
            <GitCommitHorizontal size={12} />
            {session.headCommit.slice(0, 7)}
          </Link>
        )}
        <HarnessBadge harness={session.harness} />
        {session.model && (
          <Badge shape="tag" className="font-mono">
            {session.model}
          </Badge>
        )}
        {isSubagent && session.agentType && (
          <Badge tone="accent">
            <Bot size={11} />
            {session.agentType}
          </Badge>
        )}
      </div>

      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((link) => (
            <LinkChip key={`${link.kind}-${link.number}`} link={link} base={base} />
          ))}
        </div>
      )}

      {actionData?.error && (
        <Alert tone="danger" className="mt-4">
          {actionData.error}
        </Alert>
      )}

      {/* What it waits on someone to allow or deny, first: it is stuck until then. */}
      {approvals == null ? (
        <div className="mt-6">
          <Unavailable what="Calls waiting for approval" compact />
        </div>
      ) : (
        approvals.length > 0 && (
          <div className="mt-6 space-y-3">
            {approvals.map((approval) => (
              <ApprovalCard key={approval.toolUseId} approval={approval} now={now} />
            ))}
          </div>
        )
      )}

      {/* The story: what it was asked, how long it worked, and what it came to. */}
      <div className="mt-8 space-y-5">
        {prompt && !prompt.withheld && prompt.text.trim() && <AskedBubble text={prompt.text} repo={repoAt(base)} />}
        {isSubagent && session.prompt && (!prompt || prompt.withheld) && <AskedBubble text={session.prompt} repo={repoAt(base)} />}
        <WorkedFor live={live} span={duration(session, now)} tools={tools} open={transcript} onToggle={() => setTranscript((open) => !open)} />
        {answer ? (
          <SessionAnswer text={answer} repo={repoAt(base)} />
        ) : (
          !limited && (
            <p className="text-[0.9375rem] text-muted">
              {live ? "It has not reported back yet: what it has done so far is in the transcript below." : "It ended without reporting back."}
            </p>
          )
        )}
      </div>
      {canMessage && <SessionMessageBox canStop={canStop} />}

      {!limited && (
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <StatTile
            label={live ? "Working for" : "Worked for"}
            value={<span suppressHydrationWarning>{duration(session, now)}</span>}
            detail={tools === 1 ? "1 tool call" : `${tools} tool calls`}
          >
            {bars.length > 0 && <ActivityBars bars={bars} />}
          </StatTile>
          <StatTile
            label="Changed"
            value={files.length === 1 ? "1 file" : `${files.length} files`}
            detail={[commits === 1 ? "1 commit" : `${commits} commits`, pulls === 1 ? "1 pull request" : `${pulls} pull requests`].join(" · ")}
          >
            <FileNames paths={files} />
          </StatTile>
          <StatTile
            label="Model cost"
            value={
              session.costUsd != null && Number.isFinite(session.costUsd)
                ? session.costUsd > 0 && session.costUsd < 0.01
                  ? "< $0.01"
                  : `≈ $${session.costUsd.toFixed(2)}`
                : session.costPartial
                  ? "Unknown"
                  : "—"
            }
            detail={
              cost ? (
                <Hint
                  label={`${cost}. Estimated from the tokens its transcript recorded, at the provider's list price; its subagents count on their own sessions.`}
                >
                  <span>
                    {managed ? "Billed by Anthropic to the workspace" : "Billed by the provider to whoever ran it"}
                    {session.costPartial && ", some usage priced as unknown"}
                  </span>
                </Hint>
              ) : (
                "Its harness reported no usage"
              )
            }
          />
        </div>
      )}

      {(told.length > 0 || decisions == null) && (
        <Part title="Highlights">
          {decisions == null && <Unavailable what="The decisions it kept" compact />}
          {told.length > 0 && <Highlights items={told} onCite={cite} />}
        </Part>
      )}

      {delivered.length > 0 && (
        <Part title="Deliverables">
          <Deliverables items={delivered} base={base} workspace={workspace} />
        </Part>
      )}

      {managed && live && (
        <Alert tone="info" className="mt-8">
          It runs on the workspace's Anthropic account, with Claude Managed Agents. What it does shows here as it goes, and a call it waits on someone to allow
          shows at the top for whoever started it and the workspace's members with write access.
        </Alert>
      )}

      {tree.length > 0 && (
        <Part title="Subagents" aside={children.length > tree.length ? `${children.length} in all` : undefined}>
          <SubagentTree nodes={tree} base={base} touched={touched} now={now} />
        </Part>
      )}

      {skillUses.size > 0 && (
        <Part title="Skills used">
          <div className="flex flex-wrap gap-2">
            {[...skillUses].map(([name, uses]) => (
              <Badge key={name} size="md" shape="tag">
                <Sparkles size={11} className="text-accent" />
                <span className="font-mono">{name}</span>
                {uses > 1 && <span className="text-faint">×{uses}</span>}
              </Badge>
            ))}
          </div>
        </Part>
      )}

      {groups.some((group) => where.includes(group.kind)) && (
        <Part title="What it touched" aside={tree.length > 0 ? "With its subagents" : undefined}>
          <Card className="p-4">
            <Touched touched={touched} base={base} kinds={where} />
          </Card>
        </Part>
      )}

      {updates.length > 0 && (
        <Part title="Awaiting agent acknowledgement" aside={`${updates.length}${updates.length === 100 ? "+" : ""} pending`}>
          <p className="mb-3 text-sm text-muted">
            What others did that concerns this session, which its agent has not said it considered yet. Acknowledging records that it was considered, not that
            anything was resolved.
          </p>
          <CoordinationFeed lines={pendingLines(updates)} base={base} />
        </Part>
      )}

      <section id="transcript" className="mt-12 scroll-mt-[calc(var(--topbar-h)+1rem)]">
        {/* The heading holds the button, so it stays a heading to a screen reader. */}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[0.9375rem] font-semibold text-fg">
            <button
              type="button"
              onClick={() => setTranscript((open) => !open)}
              aria-expanded={transcript}
              aria-controls="transcript-entries"
              className="flex items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronRight size={15} className={`text-faint transition-transform ${transcript ? "rotate-90" : ""}`} />
              Transcript
            </button>
          </h2>
          {!limited && <span className="text-xs text-faint">{`${entries.length} entries, ${tools} tool calls`}</span>}
        </div>
        {transcript && (
          <div id="transcript-entries" className="mt-4">
            {limited ? (
              <EmptyState title="Shown to the workspace's members">
                What a session records is the work of whoever runs it, as it happens. Members of {workspace} see it; anyone else sees that it runs, who runs it
                and what it is tied to.
              </EmptyState>
            ) : entries.length === 0 ? (
              <EmptyState title="Nothing recorded yet">Prompts, messages, tool calls, skills and notes show here as the session records them.</EmptyState>
            ) : (
              <SessionEntries entries={entries} base={base} />
            )}
          </div>
        )}
        <p className="mt-4 text-xs text-faint">
          {managed
            ? "Started by g1t on the workspace's Anthropic account, for whoever started it."
            : `Run by ${session.actor.username}'s token in ${harnessName(session.harness)}, as the harness declared.`}{" "}
          What it records is its own account; the commits, checks and merges are the record.
        </p>
      </section>
      {/* Once it has ended, a follow-up starts a new session that carries on from it. */}
      {canContinue && <SessionMessageBox mode="continue" />}
    </div>
  );
}
