import { ArrowLeft, Bot, ChevronRight, ExternalLink, GitBranch, GitCommitHorizontal, Pencil, Sparkles, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, Link } from "react-router";

import type { Pull, SessionLink, SessionTouch, State, TouchKind, WorkSession } from "@g1t/contracts";

import type { Route } from "./+types/session";
import { page } from "../../../../lib/meta";
import { Actor, CoordinationFeed, EndSessionDialog, HarnessBadge, SessionStateBadge } from "../../../../components/coordination";
import { SessionEntries } from "../../../../components/session-entries";
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
import { notFound } from "../../../../lib/not-found.server";
import { repoPages } from "../../../../lib/repo-live";
import { agentSessions, work } from "../../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../../../lib/session.server";
import { useLive } from "../../../../lib/use-repo-live";
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
  // minute; while it goes, it is read now, through the top of its tree.
  const top = found.value.root ?? found.value.session;
  if (top.harness === MANAGED && top.state !== "ended") {
    // Reading it fresh is a nicety: without it, the page shows it as last recorded.
    const synced = await agentSessions.sync(path, top.id, viewer).catch(() => null);
    if (synced?.ok) {
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
  return {
    ...found.value,
    workspace,
    repoId: session.repoId,
    signedIn: viewer != null,
    // Only whoever started it stops it, and only the top of the tree.
    canStop: viewer?.id === session.actor.id && session.harness === MANAGED && session.state !== "ended" && !session.parentId,
    // One its harness left behind is ended by hand: by whoever runs it, or anyone with write access.
    canEnd: mayEndSession(session, viewer?.id, access.can.push),
    consoleUrl,
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
  if (form.get("action") !== "stop") return { error: "There is nothing to do here but stop, end or name the session." };
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

/** A part of the page under a heading. */
function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
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

/** One harness session: who ran it, where, what it worked on, its subagents, what it touched and what it recorded. */
export default function WorkSessionPage({ loaderData, actionData }: Route.ComponentProps) {
  const { session, entries, updates = [], children = [], touched = [], links = [], skills = [], root, canStop, canEnd, consoleUrl, limited, workspace, repo } = loaderData;
  const base = `/${repo}`;
  const [ending, setEnding] = useState(false);
  const now = Date.now();
  // Any session, claim or overlap in its repository: a change names no session.
  useLive({ match: repoPages.session(), repos: [{ id: loaderData.repoId, path: repo }], signedIn: loaderData.signedIn });

  const tools = entries.filter((entry) => entry.kind === "tool_call").length;
  const firstPrompt = entries.find((entry) => entry.kind === "prompt")?.text;
  const isSubagent = Boolean(session.parentId);
  const parent = isSubagent && root?.id === session.parentId ? root : null;
  // Its own subagents: those whose parent is in this tree (children lists every descendant).
  const tree = sessionTree([session, ...children]).find((node) => node.session.id === session.id)?.children ?? [];
  const managed = session.harness === MANAGED || root?.harness === MANAGED;

  // The skills, summed by name across the tree.
  const skillUses = new Map<string, number>();
  for (const skill of skills) skillUses.set(skill.name, (skillUses.get(skill.name) ?? 0) + skill.uses);

  const pulls = links.filter((link) => link.kind === "pull");
  const groups = touchedByKind(touched);
  const commits = groups.find((group) => group.kind === "commit")?.values ?? [];
  const where: TouchKind[] = ["file", "branch", "item"];

  return (
    <div className="max-w-4xl">
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

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Actor username={session.actor.username} harness={session.harness} size={24} />
        <SessionHeading session={session} name={sessionName(session, firstPrompt)} canTitle={canEnd && !isSubagent} />
        {isSubagent && session.agentType && (
          <Badge tone="accent">
            <Bot size={11} />
            {session.agentType}
          </Badge>
        )}
        <HarnessBadge harness={session.harness} />
        {session.model && <Badge shape="tag" className="font-mono">{session.model}</Badge>}
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
              Open in Claude Console
            </a>
          </Button>
        )}
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <PersonLink name={session.actor.username} className="font-medium text-fg hover:underline" />
        <Link to={base} className="font-mono text-xs hover:text-fg">
          in {repo}
        </Link>
        <span>
          started <TimeAgo at={session.startedAt} />
        </span>
        <span suppressHydrationWarning>
          · {session.state === "ended" ? "ran" : "running for"} {duration(session, now)}
        </span>
        <span>
          · {session.state === "ended" ? "ended" : "last heard from"} <TimeAgo at={session.endedAt ?? session.lastSeenAt} />
          {session.endReason && ` (${endReasonText(session.endReason)})`}
        </span>
        {session.branch && (
          <Link to={`${base}/tree/${session.branch}`} className="inline-flex items-center gap-1 font-mono text-xs hover:text-fg">
            · <GitBranch size={12} />
            {session.branch}
          </Link>
        )}
        {session.headCommit && (
          <Link to={`${base}/commit/${session.headCommit}`} className="inline-flex items-center gap-1 font-mono text-xs hover:text-fg">
            · <GitCommitHorizontal size={12} />
            {session.headCommit.slice(0, 7)}
          </Link>
        )}
      </p>

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
      {managed && session.state !== "ended" && (
        <Alert tone="info" className="mt-4">
          It runs on the workspace's Anthropic account, with Claude Managed Agents. What it does shows here as it goes.
        </Alert>
      )}
      <p className="mt-3 text-xs text-faint">
        {managed
          ? "Started by g1t on the workspace's Anthropic account, for whoever started it."
          : `Run by ${session.actor.username}'s token in ${harnessName(session.harness)}, as the harness declared.`}{" "}
        What it records is its own account; the commits, checks and merges are the record.
      </p>

      {isSubagent && (session.prompt || session.result) && (
        <Card className="mt-6 space-y-4 p-4">
          {session.prompt && (
            <div>
              <p className="text-xs font-medium text-muted">What it was asked</p>
              <div className="mt-1">
                <LongText text={session.prompt} />
              </div>
            </div>
          )}
          {session.result && (
            <div>
              <p className="text-xs font-medium text-muted">What it reported</p>
              <div className="mt-1">
                <LongText text={session.result} />
              </div>
            </div>
          )}
        </Card>
      )}
      {!isSubagent && session.result && (
        <Section title="What it reported">
          <Card className="p-4">
            <LongText text={session.result} />
          </Card>
        </Section>
      )}

      {tree.length > 0 && (
        <Section title="Subagents" aside={children.length > tree.length ? `${children.length} in all` : undefined}>
          <SubagentTree nodes={tree} base={base} touched={touched} now={now} />
        </Section>
      )}

      {skillUses.size > 0 && (
        <Section title="Skills used">
          <div className="flex flex-wrap gap-2">
            {[...skillUses].map(([name, uses]) => (
              <Badge key={name} size="md" shape="tag">
                <Sparkles size={11} className="text-accent" />
                <span className="font-mono">{name}</span>
                {uses > 1 && <span className="text-faint">×{uses}</span>}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {groups.some((group) => where.includes(group.kind)) && (
        <Section title="What it touched" aside={tree.length > 0 ? "With its subagents" : undefined}>
          <Card className="p-4">
            <Touched touched={touched} base={base} kinds={where} />
          </Card>
        </Section>
      )}

      {(pulls.length > 0 || commits.length > 0) && (
        <Section title="Commits and pull requests">
          <Card asChild divided>
            <ul>
              {pulls.map((link) => (
                <li key={link.number} className="flex items-center gap-2.5 px-4 py-2.5 text-sm">
                  <PullIcon status={(["open", "draft", "merged", "closed"].includes(link.state) ? link.state : "open") as Pull["status"]} size={14} />
                  <Link to={`${base}/pull/${link.number}`} prefetch="intent" className="min-w-0 grow truncate hover:text-accent">
                    {link.title} <span className="text-faint">#{link.number}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-faint">{link.via.map(viaLabel).join(", ")}</span>
                </li>
              ))}
              {commits.map((sha) => (
                <li key={sha} className="flex items-center gap-2.5 px-4 py-2.5 text-sm">
                  <GitCommitHorizontal size={14} className="shrink-0 text-faint" />
                  <Link to={`${base}/commit/${sha}`} className="font-mono text-xs hover:text-accent">
                    {sha.slice(0, 7)}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {updates.length > 0 && (
        <Section title="Awaiting agent acknowledgement" aside={`${updates.length}${updates.length === 100 ? "+" : ""} pending`}>
          <p className="mb-3 text-sm text-muted">What others did that concerns this session, which its agent has not said it considered yet. Acknowledging records that it was considered, not that anything was resolved.</p>
          <CoordinationFeed lines={pendingLines(updates)} base={base} />
        </Section>
      )}
      <Section title="What it recorded" aside={limited ? undefined : `${entries.length} entries, ${tools} tool calls`}>
        {limited ? (
          <EmptyState title="Shown to the workspace's members">
            What a session records is the work of whoever runs it, as it happens. Members of {workspace} see it; anyone else sees that it runs, who runs it and what it is tied to.
          </EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState title="Nothing recorded yet">Prompts, messages, tool calls, skills and notes show here as the session records them.</EmptyState>
        ) : (
          <SessionEntries entries={entries} base={base} />
        )}
      </Section>
    </div>
  );
}
