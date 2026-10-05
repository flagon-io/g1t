import { env } from "cloudflare:workers";
import {
  Bot,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  CircleCheck,
  CircleSlash,
  GitMerge,
  Layers,
  GitPullRequestArrow,
  Hand,
  Loader,
  Radar,
  Sparkles,
  MessageSquare,
  ArrowUpRight,
  MessagesSquare,
  Rocket,
  Network,
  StickyNote,
  User,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, redirect, useRevalidator } from "react-router";

import {
  type Comparison,
  type Deployment,
  type Job,
  type LiveApp,
  type SessionEntry,
  type Viewer,
  pullComparison,
} from "@g1t/contracts";

import type { Route } from "./+types/pull";
import { excerpt, page } from "../../lib/meta";
import { DiffView } from "../../components/diff-view";
import { LifecyclePanel } from "../../components/lifecycle";
import { AgentPanel } from "../../components/agents";
import { Markdown } from "../../components/markdown";
import {
  Avatar,
  Button,
  ButtonLink,
  CopyLine,
  EmptyState,
  ErrorText,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { WorkflowStatuses } from "../../components/actions";
import { ChecksPanel } from "../../components/checks";
import {
  CommentForm,
  CommentList,
  IssueIcon,
  PeoplePicker,
  PersonLink,
  PullState,
  TimelineItem,
  verdicts,
} from "../../components/work";
import { ChecksSection, ConflictsSection, MergeabilityRow, runIdOf } from "../../components/merge-box";
import { actions, deployments, identity, projects, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

const REFRESH_MS = 4000;
const EMPTY_COMPARISON: Comparison = { base: null, head: "", files: [], truncated: false };
const TABS = ["conversation", "session", "changes"] as const;
type Tab = (typeof TABS)[number];

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const pull = loaderData?.pull;
  const title = pull ? `${pull.title} · Pull request #${pull.number} · ` : "";
  const state = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" }[pull?.status ?? "open"];
  const body = excerpt(pull?.body);
  return page(args, {
    title: `${title}${params.owner}/${params.repo} · g1t`,
    description: pull
      ? `${state} pull request #${pull.number} on ${params.owner}/${params.repo} by ${pull.author.username}.${body ? ` ${body}` : ""}`
      : null,
    // The card shows the title and the state.
    version: pull ? [pull.title, pull.status] : undefined,
    type: "article",
  });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const asked = new URL(request.url).searchParams.get("tab");
  const tab: Tab = TABS.find((name) => name === asked) ?? "conversation";

  const member = (viewer?.workspaces ?? []).some(
    (membership) => membership.slug === params.owner,
  );
  // At once: none of these depends on another.
  const ref = { workspace: params.owner, slug: params.repo };
  const [found, repo, settings, agentsEnabled, members, deps, deployed] = await Promise.all([
    work.getPull(path, number, viewer),
    repos.get(path, viewer),
    work.getSettings(path, viewer),
    env.RUNNER.enabled(viewer, path),
    // A member picks reviewers and assignees from the workspace's people.
    member ? identity.listMembers(params.owner, viewer) : null,
    // The projects that use this one: what a change here can affect.
    projects.dependencies(params.owner, params.repo, viewer),
    member ? deployments.list(ref, viewer) : null,
  ]);
  if (!found.ok) {
    // Issues and pull requests share numbers; this one may be an issue.
    const issue = await work.getIssue(path, number, viewer);
    if (issue.ok) throw redirect(`/${params.owner}/${params.repo}/issues/${number}`);
    throw new Response("Pull request not found.", { status: 404 });
  }
  const { pull } = found.value;
  const range = pullComparison(pull);
  // The jobs of each workflow run on its head, to list checks job by job.
  // Read as the viewer: a run they cannot see is listed by its status alone.
  const runIds = [...new Set((found.value.statuses ?? []).map(runIdOf).filter((id) => id != null))].slice(0, 10);
  const [session, comparison, runs] = await Promise.all([
    tab === "session" ? work.readSession(path, number, viewer) : null,
    tab === "changes"
      ? repos.compare(range.repoId, viewer, range.base, range.head)
      : null,
    tab === "conversation" && pull.status === "open"
      ? Promise.all(runIds.map((id) => actions.run(path, viewer, id).catch(() => null)))
      : [],
  ]);
  const workflowJobs: Record<string, Job[]> = {};
  for (const run of runs) if (run?.ok) workflowJobs[run.value.run.id] = run.value.jobs;
  return {
    ...found.value,
    workflowJobs,
    tab,
    session: session?.ok ? session.value : [],
    // An empty comparison if it could not be made.
    comparison: comparison && (comparison.ok ? comparison.value : EMPTY_COMPARISON),
    viewer,
    // Members of the repository's workspace can merge.
    canMerge: member,
    canManage: member || viewer?.id === pull.author.id,
    // A catch-up is pushed as the viewer: a fork takes pushes only from
    // whoever opened it, a branch from any member.
    canUpdate: pull.fork ? viewer?.id === pull.author.id : member,
    agentsEnabled,
    members: members?.ok ? members.value.map((person) => person.username) : [],
    requireUpToDate: settings.ok && settings.value.requireUpToDate,
    mergeQueue: settings.ok && settings.value.mergeQueue,
    requiredApprovals: settings.ok ? settings.value.requiredApprovals : 0,
    canIgnoreChecks: !settings.ok || settings.value.allowIgnoringChecks,
    defaultBranch: repo.ok ? repo.value.defaultBranch : "main",
    affects: deps.ok ? deps.value.usedBy : [],
    ...(await deploymentOf(deployed?.ok ? deployed.value : null, number, params.owner, deps.ok ? deps.value.usedBy : [], viewer)),
  };
}

/**
 * Where this pull request is live: its preview (or its latest build, while
 * one is going or after one failed), and the previews of the projects
 * that use this one, built against it.
 */
async function deploymentOf(
  list: { deployments: Deployment[]; live: LiveApp[] } | null,
  number: number,
  owner: string,
  affects: { slug: string; name: string }[],
  viewer: Viewer,
) {
  if (!list) return { preview: null, build: null, stacked: [] };
  const preview = list.live.find((app) => app.kind === "preview" && app.number === number) ?? null;
  const build = list.deployments.find((d) => d.kind === "preview" && d.number === number) ?? null;
  const branch = preview?.branch ?? build?.branch ?? null;
  const stacked = branch
    ? (
        await Promise.all(
          affects.slice(0, 5).map(async (project) => {
            const theirs = await deployments.list({ workspace: owner, slug: project.slug }, viewer);
            const app = theirs.ok ? theirs.value.live.find((a) => a.kind === "preview" && a.branch === branch) : undefined;
            return app ? { name: project.name, slug: project.slug, url: app.url } : null;
          }),
        )
      ).filter((entry) => entry != null)
    : [];
  return { preview, build, stacked };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const action = form.get("action");
  const verdict = form.get("verdict");
  const line = Number(form.get("line"));
  /** Names ticked in a people picker, plus those typed beside it. */
  const picked = (field: string) => [
    ...form.getAll(field).map(String),
    ...String(form.get("others") ?? "").split(/[\s,]+/),
  ];
  // The projects that use this one, built against this pull request's preview.
  if (action === "stack") {
    const built = await deployments.stack(user, { workspace: params.owner, slug: params.repo }, String(form.get("branch") ?? ""));
    return built.ok
      ? { action, notice: `Building ${built.value.join(", ")} against this preview. They appear on their Deployments pages.` }
      : { action, error: built.error.message };
  }
  // Asking a g1t agent for its review records the request, then starts it.
  if (action === "agent-review") {
    const asked = await work.updatePull(user, path, number, {
      reviewers: [...form.getAll("reviewer").map(String), "g1t-agent"],
    });
    if (!asked.ok) return { error: asked.error.message, action };
  }
  // A workflow run's failed jobs, run again. Who may is the actions service's call.
  if (action === "rerun-workflow") {
    const rerun = await actions.rerun(user, path, String(form.get("run") ?? ""), true);
    return rerun.ok ? null : { error: rerun.error.message, action };
  }
  const result =
    action === "merge"
      ? await work.mergePull(user, path, number, {
          keepIssueOpen: form.get("keepIssueOpen") === "on",
          ignoreChecks: form.get("ignoreChecks") === "on",
        })
      : action === "unqueue"
        ? await work.removeFromQueue(user, path, number)
      : action === "message"
        ? await work.messageAgent(user, path, number, String(form.get("body") ?? ""))
      : action === "close"
        ? await work.closePull(user, path, number)
        : action === "recheck"
          ? await env.RUNNER.recheck(user, path, number)
          : action === "update"
            ? await env.RUNNER.update(user, path, number)
          : action === "agent-review"
            ? await env.RUNNER.review(user, path, number)
          : action === "reviewers"
            ? await work.updatePull(user, path, number, { reviewers: picked("reviewer") })
          : action === "assign"
            ? await work.updatePull(user, path, number, { assignees: picked("assignee") })
          : action === "comment"
            ? await work.addComment(user, path, number, {
                body: String(form.get("body") ?? ""),
                path: String(form.get("path") ?? "") || undefined,
                line: line > 0 ? line : undefined,
                verdict:
                  verdict === "approve" || verdict === "request_changes" ? verdict : undefined,
              })
            : await work.readyPull(user, path, number, String(form.get("summary") ?? ""));
  return result.ok ? null : { error: result.error.message, action };
}

function TabLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      preventScrollReset
      className={
        "-mb-px flex items-center gap-2 border-b-2 px-1 pb-2.5 text-sm transition-colors " +
        (active
          ? "border-accent font-medium text-fg"
          : "border-transparent text-muted hover:text-fg")
      }
    >
      {children}
    </Link>
  );
}

/** One step of the session, on the timeline's rail. */
function Entry({ entry, agent }: { entry: SessionEntry; agent: string }) {
  const isTool = entry.kind === "tool_call" || entry.kind === "tool_result";
  const Icon =
    entry.kind === "prompt"
      ? User
      : entry.kind === "note"
        ? StickyNote
        : isTool
          ? Wrench
          : Bot;
  return (
    <li className="relative pl-10">
      <span
        className={`absolute top-0.5 left-0 flex size-7 items-center justify-center rounded-full border bg-bg ${
          entry.kind === "prompt"
            ? "border-accent/50 text-accent"
            : "border-line text-faint"
        }`}
      >
        <Icon size={14} />
      </span>
      {isTool ? (
        <details className="group rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm">
            <ChevronRight
              size={14}
              className="text-faint transition-transform group-open:rotate-90"
            />
            <span className="font-mono text-xs text-accent">
              {entry.tool ?? "tool"}
            </span>
            <span className="truncate font-mono text-xs text-muted">
              {entry.kind === "tool_result" ? "→ " : ""}
              {entry.text.split("\n")[0]}
            </span>
          </summary>
          <pre className="overflow-x-auto border-t border-line p-3 font-mono text-xs whitespace-pre-wrap text-muted">
            <code>{entry.text}</code>
          </pre>
        </details>
      ) : (
        <div>
          <p className="text-xs font-medium text-faint">
            {entry.kind === "prompt"
              ? "Prompt"
              : entry.kind === "note"
                ? "Note"
                : agent}
          </p>
          {entry.kind === "message" ? (
            <div className="mt-1">
              <Markdown source={entry.text} />
            </div>
          ) : entry.kind === "prompt" ? (
            <div className="mt-1.5 max-h-[32rem] overflow-y-auto rounded-xl border border-line bg-surface p-4">
              <Markdown source={entry.text} />
            </div>
          ) : (
            <p className="mt-1 text-[0.9375rem] leading-relaxed wrap-break-word whitespace-pre-wrap">
              {entry.text}
            </p>
          )}
        </div>
      )}
      {entry.commit && (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-xs text-faint">
          <GitCommitHorizontal size={12} />
          {entry.commit.slice(0, 7)}
        </p>
      )}
    </li>
  );
}

/** The box at the foot of the conversation saying what stands before a merge. */
function StatusBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="hidden w-8 shrink-0 sm:block" />
      <section className="min-w-0 grow divide-y divide-line overflow-hidden rounded-xl border border-line-strong bg-surface">
        {children}
      </section>
    </div>
  );
}

function StatusRow({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 py-3 text-sm">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-muted">{children}</div>}
      </div>
    </div>
  );
}

export default function PullPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const {
    pull,
    issue,
    comments,
    checks,
    overlaps,
    behind,
    reviewPending,
    lifecycle,
    messages,
    statuses = [],
    mergeable = "unknown",
    conflicts = [],
    earlierChecks = [],
    workflowJobs,
    affects,
    preview,
    build,
    stacked,
    landing,
    stalled,
    requireUpToDate,
    mergeQueue,
    requiredApprovals,
    canIgnoreChecks,
    canUpdate,
    agentsEnabled,
    members,
    tab,
    session,
    comparison,
    viewer,
    canMerge,
    canManage,
    defaultBranch,
  } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const here = `${base}/pull/${pull.number}`;
  const remote = pull.fork
    ? `https://g1t.sh/${pull.fork.namespace}/${pull.fork.name}.git`
    : `https://g1t.sh/${params.owner}/${params.repo}.git`;
  const active = pull.status === "draft" || pull.status === "open";

  // Follow an agent at work, or checks in progress, without a manual reload.
  const revalidator = useRevalidator();
  const working = pull.status === "draft";
  const checking =
    checks?.status === "queued" || checks?.status === "running" || statuses.some((status) => status.state === "pending");
  const reviews = verdicts(comments);
  // What stands between this pull request and a merge, if anything.
  const unchecked = checks && checks.status !== "passed";
  // Pull requests for other issues changing the same files will conflict;
  // ones for the same issue are alternatives, and expected to.
  const collisions = overlaps.filter((other) => other.issue == null || other.issue !== pull.issue);
  const review = {
    changesUrl: here + "?tab=changes",
    // Nobody reviews their own pull request.
    canJudge: active && viewer != null && viewer.id !== pull.author.id,
  };
  // Everyone whose review was asked for, then anyone who reviewed unasked.
  const reviewerNames = [
    ...new Set([...pull.reviewers, ...reviews.map(({ reviewer }) => reviewer)]),
  ];
  const [submitted, setSubmitted] = useState<string | null>(null);
  const catchingUp = submitted === "update" && behind;
  // g1t is taking a step of its own accord, so the page will change.
  const moving =
    lifecycle != null && lifecycle.stage !== "ready" && lifecycle.stage !== "needs_you";
  // Whether it merges cleanly is being worked out, so the box will change.
  const probing = active && mergeable === "checking";
  const conflicting = active && mergeable === "conflicting";
  const resolving = submitted === "update" && conflicting;
  useEffect(() => {
    if (!working && !checking && !reviewPending && !catchingUp && !moving && !landing && !probing && !resolving) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [working, checking, reviewPending, catchingUp, moving, landing, probing, resolving, revalidator]);
  // Why the merge button cannot be pressed, if it cannot.
  const mergeBlocked = conflicting
    ? "Resolve the conflicts first."
    : probing
      ? "Waiting to find out whether it merges cleanly."
      : behind && requireUpToDate
        ? `This repository requires it to be up to date with ${defaultBranch} first.`
        : null;

  return (
    // The changes get the whole width; people and settings are a tab away.
    <div className={`grid gap-8 ${tab === "changes" ? "" : "lg:grid-cols-[1fr_19rem]"}`}>
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <PullState status={pull.status} />
          <span className="flex items-center gap-2">
            <Avatar
              name={(pull.status === "merged" && pull.mergedBy) || pull.author.username}
              size={18}
            />
            <span>
              <PersonLink
                name={(pull.status === "merged" && pull.mergedBy) || pull.author.username}
                className="font-medium text-fg hover:underline"
              />{" "}
              {pull.status === "merged" ? "merged" : "wants to merge"}
              {pull.branch && (
                <>
                  {" "}
                  <span className="font-mono text-fg">{pull.branch}</span>
                </>
              )}{" "}
              into <span className="font-mono text-fg">{defaultBranch}</span>
            </span>
          </span>
          {/* A pull request from a branch was made by its author, not an agent. */}
          {!pull.branch && (
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <Bot size={14} />
              {pull.agent}
              {pull.runtime === "hosted" && <span className="text-faint">on g1t</span>}
            </span>
          )}
        </div>

        {reviews.length > 0 && (
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {reviews.map(({ reviewer, verdict }) => (
              <span
                key={reviewer}
                className={`flex items-center gap-1.5 ${
                  verdict === "approve" ? "text-accent" : "text-danger"
                }`}
              >
                {verdict === "approve" ? <CircleCheck size={15} /> : <CircleSlash size={15} />}
                {verdict === "approve" ? "Approved by" : "Changes requested by"}{" "}
                <span className="font-medium">{reviewer}</span>
              </span>
            ))}
          </p>
        )}

        {lifecycle && <LifecyclePanel lifecycle={lifecycle} />}
        {/* The agent on it: who, doing what this minute, for how long, at what cost. */}
        <AgentPanel owner={params.owner} repo={params.repo} number={pull.number} stage={lifecycle?.stage ?? null} />

        {/* Steering: while its agent works, people can tell it things. */}
        {canManage &&
          pull.runtime === "hosted" &&
          (working || ["working", "revising", "catching_up", "answering"].includes(lifecycle?.stage ?? "")) && (
            <Form method="post" className="mt-4 rounded-2xl bg-surface p-4 ring-1 ring-merged/30">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Sparkles size={15} className="text-merged" />
                Message the agent
              </p>
              <p className="mt-1 text-xs text-muted">
                A correction, a hint, a change of plan. It reads it at its next step, without
                starting over.
              </p>
              <div className="mt-3 flex gap-2">
                <input type="hidden" name="action" value="message" />
                <input
                  name="body"
                  required
                  autoComplete="off"
                  data-1p-ignore
                  placeholder="Keep the old flag working too…"
                  className="h-9 min-w-0 grow rounded-md bg-bg px-3 text-sm ring-1 ring-line outline-none placeholder:text-faint focus:ring-merged/60"
                />
                <Button type="submit">Send</Button>
              </div>
            </Form>
          )}
        {messages.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {messages.map((message) => (
              <li key={message.id} className="flex items-start gap-2 text-sm">
                <Avatar name={message.author} size={18} />
                <span className="min-w-0 grow">
                  <span className="font-medium">
                    {message.fromNumber != null ? `The agent on #${message.fromNumber}` : message.author}
                  </span>{" "}
                  <span className="text-muted">
                    {message.kind === "question"
                      ? "asked:"
                      : message.kind === "handoff"
                        ? "handed over:"
                        : message.kind === "answer"
                          ? "answered:"
                          : "to the agent:"}
                  </span>{" "}
                  {message.body}
                  {message.answer && (
                    <span className="mt-1 block border-l-2 border-merged/40 pl-2 text-muted">
                      {message.declined ? "Declined: " : "Answer: "}
                      {message.answer}
                    </span>
                  )}
                </span>
                <span className={`shrink-0 text-xs ${message.deliveredAt ? "text-accent" : "text-faint"}`}>
                  {message.deliveredAt ? "read by the agent" : "waiting for its next step"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {issue && (
          <Link
            to={`${base}/issues/${issue.number}`}
            className="mt-4 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm transition-colors hover:border-line-strong"
          >
            <IssueIcon issue={issue} />
            <span className="text-muted">
              {pull.status === "merged" && issue.resolvedBy === pull.number
                ? "Resolved"
                : "For issue"}
            </span>
            <span className="truncate font-medium">{issue.title}</span>
            <span className="text-faint">#{issue.number}</span>
            {issue.pullCount > 1 && (
              <span className="ml-auto shrink-0 text-xs text-faint">
                1 of {issue.pullCount} pull requests
              </span>
            )}
          </Link>
        )}

        {pull.status === "merged" && (
          <p className="mt-4 flex items-center gap-2.5 rounded-xl border border-merged/40 bg-merged/5 px-4 py-2.5 text-sm">
            <GitMerge size={16} className="shrink-0 text-merged" />
            <span>
              Merged into <span className="font-mono">{defaultBranch}</span> by{" "}
              <span className="font-medium">{pull.mergedBy}</span>{" "}
              {/* Not an account: the repository's settings said to merge it. */}
              {pull.mergedBy === "g1t" && "automatically, once it was ready, "}
              {pull.mergedAt && <TimeAgo at={pull.mergedAt} />}
              {pull.headCommit && (
                <span className="font-mono text-muted"> · {pull.headCommit.slice(0, 7)}</span>
              )}
            </span>
          </p>
        )}
        {pull.supersededBy != null && (
          <p className="mt-4 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-muted">
            Closed because{" "}
            <Link
              to={`${base}/pull/${pull.supersededBy}`}
              className="font-medium text-fg hover:underline"
            >
              #{pull.supersededBy}
            </Link>{" "}
            was merged for this issue instead.
          </p>
        )}

        {collisions.length > 0 && active && (
          <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
            <p className="flex items-center gap-2.5 font-medium">
              <Radar size={16} className="shrink-0 text-info" />
              Other work is changing the same files
            </p>
            <ul className="mt-2 space-y-1.5">
              {collisions.map((other) => (
                <li key={other.number} className="flex flex-wrap items-baseline gap-x-2 text-muted">
                  <Link
                    to={`${base}/pull/${other.number}`}
                    className="font-medium text-fg hover:underline"
                  >
                    {other.title} <span className="font-normal text-faint">#{other.number}</span>
                  </Link>
                  <span className="font-mono text-xs">{other.paths.join(", ")}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-faint">
              Whichever merges second will have to catch up, and may conflict.
            </p>
          </div>
        )}

        <nav className="mt-8 flex gap-6 border-b border-line">
          <TabLink to={here} active={tab === "conversation"}>
            <MessageSquare size={15} />
            Conversation
          </TabLink>
          <TabLink to={here + "?tab=session"} active={tab === "session"}>
            <MessagesSquare size={15} />
            Session
          </TabLink>
          <TabLink to={here + "?tab=changes"} active={tab === "changes"}>
            <FileDiff size={15} />
            Changes
          </TabLink>
        </nav>
        <div className="mt-5">
          {comparison ? (
            <DiffView
              comparison={comparison}
              review={{
                comments: comments.filter((comment) => comment.path),
                canComment: Boolean(viewer),
              }}
            />
          ) : tab === "session" ? (
            session.length === 0 ? (
              <EmptyState title="Nothing recorded yet">
                The agent's prompts, reasoning and tool calls appear here as it
                works.
              </EmptyState>
            ) : (
              <ol className="relative space-y-5 before:absolute before:top-2 before:bottom-2 before:left-3.25 before:w-px before:bg-line">
                {session.map((entry) => (
                  <Entry key={entry.seq} entry={entry} agent={pull.agent} />
                ))}
              </ol>
            )
          ) : (
            <div className="space-y-4">
              <TimelineItem
                author={pull.author.username}
                at={pull.createdAt}
                action={
                  <span>
                    opened this pull request
                    {!pull.branch && (
                      <>
                        {" "}
                        with <span className="font-mono text-xs">{pull.agent}</span>
                      </>
                    )}
                  </span>
                }
              >
                {pull.body ? (
                  <Markdown source={pull.body} repo={{ namespace: params.owner, name: params.repo }} />
                ) : (
                  <p className="text-sm text-muted">
                    {working
                      ? "No description yet. It is written when the pull request is marked ready for review."
                      : "No description."}
                  </p>
                )}
                {canManage && pull.status === "open" && (
                  <details className="mt-3 border-t border-line pt-3 text-sm">
                    <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                      Edit description
                    </summary>
                    <Form method="post" className="mt-3 space-y-2">
                      <Textarea
                        name="summary"
                        rows={6}
                        placeholder="What changed and why"
                        defaultValue={pull.body ?? ""}
                      />
                      <Button type="submit">Save</Button>
                    </Form>
                  </details>
                )}
              </TimelineItem>

              <CommentList comments={comments} review={review} base={base} />

              {(preview || build) && (
                <DeploymentCard preview={preview} build={build} stacked={stacked} base={base} />
              )}

              {pull.status === "draft" && (
                <StatusBox>
                  <StatusRow icon={<Loader size={16} className="text-faint" />} title="This is a draft">
                    It is still being worked on. It can be reviewed and merged once it is
                    marked ready.
                  </StatusRow>
                  {canManage && (
                    <Form method="post" className="space-y-2 px-4 py-3">
                      <Textarea name="summary" rows={3} placeholder="What changed and why" />
                      <Button type="submit">Mark ready for review</Button>
                    </Form>
                  )}
                </StatusBox>
              )}

              {pull.status === "open" && (
                <StatusBox>
                  <ChecksSection
                    run={checks}
                    commands={issue?.checks ?? []}
                    statuses={statuses}
                    jobs={workflowJobs}
                    pull={pull}
                    base={base}
                    earlier={earlierChecks}
                    canRerun={canManage}
                    canRerunWorkflows={canMerge}
                    error={
                      actionData?.action === "recheck" || actionData?.action === "rerun-workflow"
                        ? actionData.error
                        : null
                    }
                  />
                  <StatusRow
                    icon={
                      reviews.some(({ verdict }) => verdict === "request_changes") ? (
                        <CircleSlash size={16} className="text-danger" />
                      ) : reviews.length > 0 ? (
                        <CircleCheck size={16} className="text-accent" />
                      ) : (
                        <MessageSquare size={16} className="text-faint" />
                      )
                    }
                    title={
                      reviews.length === 0
                        ? "No reviews yet"
                        : reviews
                            .map(
                              ({ reviewer, verdict }) =>
                                `${verdict === "approve" ? "Approved by" : "Changes requested by"} ${reviewer}`,
                            )
                            .join(" · ")
                    }
                  >
                    {reviewPending && "A g1t agent is reviewing it now. "}
                    {requiredApprovals > 0 &&
                      `This repository requires ${requiredApprovals} approving ${
                        requiredApprovals === 1 ? "review" : "reviews"
                      } before merging.`}
                  </StatusRow>
                  {landing ? (
                    <StatusRow
                      icon={<Loader size={16} className="animate-spin text-accent" />}
                      title="Merging"
                    >
                      {defaultBranch} has moved, so g1t is bringing this up to date first. It
                      lands as soon as that is done. Watch it in the Session tab.
                    </StatusRow>
                  ) : conflicting ? (
                    <ConflictsSection
                      conflicts={conflicts}
                      pull={pull}
                      owner={params.owner}
                      repo={params.repo}
                      defaultBranch={defaultBranch}
                      changesUrl={here + "?tab=changes"}
                      canResolve={canUpdate && agentsEnabled}
                      resolving={resolving}
                      onResolve={() => setSubmitted("update")}
                      error={actionData?.action === "update" ? actionData.error : null}
                    />
                  ) : probing ? (
                    <MergeabilityRow mergeable={mergeable} defaultBranch={defaultBranch} />
                  ) : behind ? (
                    <StatusRow
                      icon={<GitPullRequestArrow size={16} className="text-info" />}
                      title={`${defaultBranch} has moved since this was made`}
                    >
                      {mergeable === "clean" && "It has no conflicts with it. "}
                      {requireUpToDate
                        ? "This repository requires pull requests to be up to date, so it has to catch up before it can merge."
                        : "That does not stop it merging: it is brought up to date as part of the merge."}
                      {canUpdate && agentsEnabled && (
                        <Form
                          method="post"
                          className="mt-2"
                          onSubmit={() => setSubmitted("update")}
                        >
                          <input type="hidden" name="action" value="update" />
                          <Button variant="quiet" type="submit" disabled={catchingUp}>
                            {catchingUp ? "Catching up…" : `Catch up with ${defaultBranch} now`}
                          </Button>
                        </Form>
                      )}
                      {actionData?.action === "update" && (
                        <ErrorText>{actionData.error}</ErrorText>
                      )}
                    </StatusRow>
                  ) : (
                    pull.headCommit && (
                      <StatusRow
                        icon={<CircleCheck size={16} className="text-accent" />}
                        title={`Up to date with ${defaultBranch}`}
                      />
                    )
                  )}
                  {stalled && !lifecycle && (
                    <StatusRow icon={<Hand size={16} className="text-warn" />} title="Needs you">
                      {stalled}
                    </StatusRow>
                  )}
                  {canMerge && lifecycle?.stage === "queued" && (
                    <Form method="post" className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <ButtonLink to={`${base}/queue`}>
                        <Layers size={15} />
                        See the queue
                      </ButtonLink>
                      <Button variant="quiet" type="submit" name="action" value="unqueue">
                        Remove from the queue
                      </Button>
                    </Form>
                  )}
                  {canMerge && !landing && lifecycle?.stage !== "queued" && (
                    <Form method="post" className="space-y-3 px-4 py-3">
                      {issue?.state === "open" && (
                        <CheckboxOption
                          name="keepIssueOpen"
                          label={`Keep #${issue.number} open. This is only part of the work.`}
                          labelClassName="text-xs text-muted"
                        />
                      )}
                      {unchecked && canIgnoreChecks && (
                        <CheckboxOption
                          name="ignoreChecks"
                          label={`Merge although the checks ${checking ? "have not finished" : "did not pass"}.`}
                          labelClassName="text-xs text-muted"
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          variant="accent"
                          type="submit"
                          name="action"
                          value="merge"
                          disabled={mergeBlocked != null}
                          title={mergeBlocked ?? undefined}
                        >
                          {mergeQueue ? <Layers size={15} /> : <GitMerge size={15} />}
                          {mergeQueue ? "Add to the merge queue" : `Merge into ${defaultBranch}`}
                        </Button>
                        <span className={`text-xs ${mergeBlocked ? "text-danger" : "text-muted"}`}>
                          {mergeBlocked ?? (mergeQueue
                            ? `Tested together with everything ahead of it, then lands on ${defaultBranch}.`
                            : issue?.state === "open"
                              ? `Closes issue #${issue.number}, and any other pull requests still open for it.`
                              : `Lands its commits on ${defaultBranch}.`)}
                        </span>
                      </div>
                      {actionData?.action === "merge" && (
                        <ErrorText>{actionData.error}</ErrorText>
                      )}
                    </Form>
                  )}
                </StatusBox>
              )}

              <CommentForm
                author={viewer?.username ?? null}
                resetKey={comments.length}
                review={review}
              />
              {canManage && active && (
                <Form method="post" className="flex justify-end">
                  <Button variant="quiet" type="submit" name="action" value="close">
                    Close pull request
                  </Button>
                </Form>
              )}
              {actionData &&
                !["merge", "comment", "recheck", "rerun-workflow", "update", "agent-review", "reviewers", "assign"].includes(
                  String(actionData.action),
                ) && <ErrorText>{actionData.error}</ErrorText>}
            </div>
          )}
          {actionData?.action === "comment" && (
            <div className="mt-2">
              <ErrorText>{actionData.error}</ErrorText>
            </div>
          )}
        </div>
      </div>

      <aside className={tab === "changes" ? "hidden" : "space-y-6"}>
        {/* An open pull request shows its checks in full in the merge box. */}
        {pull.status !== "open" && (
          <>
            <ChecksPanel run={checks} commands={issue?.checks ?? []} canRerun={false} />
            <WorkflowStatuses statuses={statuses} />
          </>
        )}
        {affects.length > 0 && (
          <section>
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <Network size={14} className="text-faint" />
              Affects
            </h3>
            <p className="mt-1 text-xs text-muted">Projects that use this one, and so may feel this change:</p>
            <ul className="mt-2 space-y-1 text-sm">
              {affects.map((project) => (
                <li key={project.slug} className="flex items-center justify-between gap-2">
                  <Link to={`/${params.owner}/${project.slug}`} className="hover:underline">
                    {project.name}
                  </Link>
                  {project.as && <code className="font-mono text-xs text-faint">{project.as}</code>}
                </li>
              ))}
            </ul>
            {preview?.branch && canMerge && (
              <Form method="post" className="mt-3">
                <input type="hidden" name="action" value="stack" />
                <input type="hidden" name="branch" value={preview.branch} />
                <button
                  type="submit"
                  className="w-full rounded-md border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  Preview them against this change
                </button>
              </Form>
            )}
            {actionData?.action === "stack" &&
              ("notice" in actionData ? (
                <p className="mt-2 text-xs text-accent">{String(actionData.notice)}</p>
              ) : (
                <ErrorText>{actionData.error}</ErrorText>
              ))}
          </section>
        )}

        <section>
          <h3 className="text-sm font-medium">Reviewers</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {reviewerNames.map((name) => {
              const verdict = reviews.find(({ reviewer }) => reviewer === name)?.verdict;
              const pending = name === "g1t-agent" && reviewPending;
              return (
                <li key={name} className="flex items-center gap-2 px-1">
                  {name === "g1t-agent" ? (
                    <Sparkles size={16} className="shrink-0 text-accent" />
                  ) : (
                    <Avatar name={name} size={20} />
                  )}
                  <span className="grow truncate font-mono text-xs">{name}</span>
                  {pending ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                      Reviewing
                    </span>
                  ) : verdict === "approve" ? (
                    <span className="flex items-center gap-1 text-xs text-accent">
                      <CircleCheck size={13} /> Approved
                    </span>
                  ) : verdict === "request_changes" ? (
                    <span className="flex items-center gap-1 text-xs text-danger">
                      <CircleSlash size={13} /> Changes requested
                    </span>
                  ) : (
                    <span className="text-xs text-faint">Review requested</span>
                  )}
                </li>
              );
            })}
            {reviewerNames.length === 0 && (
              <li className="px-1 text-xs text-faint">No reviews requested yet.</li>
            )}
          </ul>
          {pull.status === "open" && canManage && (
            <div className="mt-3 space-y-2">
              {agentsEnabled && !reviewPending && (
                <Form method="post">
                  <input type="hidden" name="action" value="agent-review" />
                  {pull.reviewers.map((name) => (
                    <input key={name} type="hidden" name="reviewer" value={name} />
                  ))}
                  <div className="*:w-full">
                    <Button variant="quiet" type="submit">
                      <Sparkles size={14} className="text-accent" />
                      Request review from g1t agent
                    </Button>
                  </div>
                </Form>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                  Request review from people
                </summary>
                <Form method="post" className="mt-2 space-y-2" key={pull.reviewers.join()}>
                  <input type="hidden" name="action" value="reviewers" />
                  {pull.reviewers.includes("g1t-agent") && (
                    <input type="hidden" name="reviewer" value="g1t-agent" />
                  )}
                  <PeoplePicker
                    name="reviewer"
                    members={members.filter((name) => name !== pull.author.username)}
                    chosen={pull.reviewers.filter((name) => name !== "g1t-agent")}
                  />
                  <Button variant="quiet" type="submit">
                    Save reviewers
                  </Button>
                </Form>
              </details>
            </div>
          )}
          {["agent-review", "reviewers"].includes(String(actionData?.action)) && (
            <ErrorText>{actionData?.error}</ErrorText>
          )}
        </section>

        <section>
          <h3 className="text-sm font-medium">Assignees</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {pull.assignees.map((name) => (
              <li key={name} className="flex items-center gap-2 px-1">
                <Avatar name={name} size={20} />
                <span className="grow truncate font-mono text-xs">{name}</span>
              </li>
            ))}
            {pull.assignees.length === 0 && (
              <li className="px-1 text-xs text-faint">No one yet.</li>
            )}
          </ul>
          {viewer && canManage && active && (
            <div className="mt-3 space-y-2">
              {!pull.assignees.includes(viewer.username) && (
                <Form method="post">
                  <input type="hidden" name="action" value="assign" />
                  {pull.assignees.map((name) => (
                    <input key={name} type="hidden" name="assignee" value={name} />
                  ))}
                  <input type="hidden" name="assignee" value={viewer.username} />
                  <div className="*:w-full">
                    <Button variant="quiet" type="submit">
                      Assign yourself
                    </Button>
                  </div>
                </Form>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                  Assign people
                </summary>
                <Form method="post" className="mt-2 space-y-2" key={pull.assignees.join()}>
                  <input type="hidden" name="action" value="assign" />
                  <PeoplePicker name="assignee" members={members} chosen={pull.assignees} />
                  <Button variant="quiet" type="submit">
                    Save assignees
                  </Button>
                </Form>
              </details>
            </div>
          )}
          {actionData?.action === "assign" && <ErrorText>{actionData.error}</ErrorText>}
        </section>

        <section>
          <h3 className="text-sm font-medium">Working copy</h3>
          {pull.branch ? (
            <>
              <p className="mt-1 text-xs text-muted">
                <GitBranch size={13} className="mr-1 inline align-[-2px]" />
                Branch <span className="font-mono text-fg">{pull.branch}</span> of this
                repository. Pushes to it show up here.
              </p>
              <div className="mt-2">
                <CopyLine text={`git clone -b ${pull.branch} ${remote}`} />
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">
                This fork belongs to the pull request. Pushes to it show up here.
              </p>
              <div className="mt-2">
                <CopyLine text={`git clone ${remote}`} />
              </div>
            </>
          )}
          <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-faint">
            <GitCommitHorizontal size={13} />
            {pull.headCommit?.slice(0, 12) ?? "no commits pushed yet"}
          </p>
        </section>
      </aside>
    </div>
  );
}

/** Where the pull request's change is live, as GitHub shows a deployment. */
function DeploymentCard({
  preview,
  build,
  stacked,
  base,
}: {
  preview: LiveApp | null;
  build: Deployment | null;
  stacked: { name: string; slug: string; url: string }[];
  base: string;
}) {
  const building = build?.status === "queued" || build?.status === "building";
  const failed = build?.status === "failed";
  return (
    <section className="ml-12 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ${
            failed ? "text-danger ring-danger/40" : building ? "text-warn ring-warn/40" : "text-accent ring-accent/40"
          }`}
        >
          {building ? <Loader size={15} className="animate-spin" /> : <Rocket size={15} />}
        </span>
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">
            {building
              ? preview
                ? "Deploying the latest push. The last preview is still live."
                : "Deploying a preview"
              : failed
                ? "The preview failed to deploy"
                : "This branch is live"}
          </p>
          {preview ? (
            <a href={preview.url} className="mt-0.5 block truncate font-mono text-xs text-muted hover:text-accent">
              {preview.url.replace(/^https?:[/][/]/, "")}
            </a>
          ) : (
            build?.error && <p className="mt-0.5 truncate text-xs text-muted">{build.error}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {build && (
            <Link to={`${base}/deployments/${build.id}`} className="text-xs text-muted hover:text-fg">
              {failed ? "See why" : "Build log"}
            </Link>
          )}
          {preview && (
            <a
              href={preview.url}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
            >
              Visit preview
              <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      </div>
      {preview && (
        <p className="border-t border-line px-4 py-2 text-xs text-faint">
          <span className="font-mono">{preview.commit.slice(0, 7)}</span> · deployed <TimeAgo at={preview.deployedAt} />
          {preview.branch && ` · from ${preview.branch}`}
        </p>
      )}
      {stacked.length > 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <p className="text-xs text-muted">Built against this change:</p>
          <ul className="mt-1.5 space-y-1">
            {stacked.map((entry) => (
              <li key={entry.slug} className="flex items-center gap-2 text-xs">
                <span className="font-medium">{entry.name}</span>
                <a href={entry.url} className="truncate font-mono text-muted hover:text-accent">
                  {entry.url.replace(/^https?:[/][/]/, "")}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
