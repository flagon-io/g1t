import { env } from "cloudflare:workers";
import { Bot, ExternalLink, GitCommitHorizontal, GitMerge, Play, Sparkles } from "lucide-react";
import { Form, Link, redirect } from "react-router";

import { type Pull, PROVIDERS, workOwner } from "@g1t/contracts";

import type { Route } from "./+types/issue";
import { excerpt, page } from "../../lib/meta";
import { Markdown } from "../../components/markdown";
import { AgentStepLine } from "../../components/agents";
import {
  Avatar,
  CopyLine,
  EmptyState,
  ComputeNote,
  ErrorText,
  Input,
  SubmitButton,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { CheckBadge } from "../../components/checks";
import { LabelChip, LabelsBox, MilestoneBox } from "../../components/labels";
import {
  Assignee,
  AssigneeStack,
  ChangeSize,
  CommentForm,
  CommentList,
  PeoplePicker,
  IssueState,
  PersonLink,
  PullIcon,
  plainText,
} from "../../components/work";
import { notFound } from "../../lib/not-found.server";
import { openedBy } from "../../lib/opened-by";
import { computeNoteFor } from "../../lib/compute.server";
import { agents, identity, inbox, integrations, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { accessTo, refusal, repoFor } from "../../lib/access.server";
import { SubscriptionBox } from "../../components/notifications";
import { useRefreshWhile } from "../../lib/refresh";
import { DetailsDisclosure, detailsSummary } from "../../components/details-disclosure";


export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const issue = loaderData?.issue;
  const title = issue ? `${issue.title} · Issue #${issue.number} · ` : "";
  const state = issue?.state === "open" ? "Open" : issue?.reason === "not_planned" ? "Closed as not planned" : "Closed";
  const body = excerpt(issue?.body);
  return page(args, {
    title: `${title}${params.owner}/${params.repo} · g1t`,
    description: issue
      ? `${state} issue #${issue.number} on ${params.owner}/${params.repo}, opened by ${issue.author.username}${issue.requestedBy ? ` for ${issue.requestedBy.username}` : ""}.${body ? ` ${body}` : ""}`
      : null,
    // The card shows the title and the state.
    version: issue ? [issue.title, issue.state, issue.reason] : undefined,
    type: "article",
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  // At once: only the plan's note waits for the viewer's role. Putting an
  // agent on it needs Write: Read cannot spend compute.
  const access = accessTo(context, params);
  const [{ can }, found, labels, milestones, agentsEnabled, members, links, computeNote, subscription, active, teams] = await Promise.all([
    access,
    work.getIssue(path, number, viewer),
    work.listLabels(path, viewer),
    // Open ones to choose from, and the one it is in, with its progress.
    work.listMilestones(path, viewer),
    env.RUNNER.enabled(viewer, path),
    // A member picks assignees from the workspace's people.
    roleIn(viewer, params.owner) ? identity.listMembers(params.owner, viewer) : null,
    // What it is tied to outside g1t. Shown only once the issue is known visible.
    integrations.links(path, number).catch(() => []),
    // Before a member assigns g1t: whether the workspace's plan lets it start.
    access.then(({ can }) => (can.run ? computeNoteFor(params.owner, "agent") : null)),
    // Whether the viewer hears of it, for the sidebar's Notifications.
    viewer
      ? repoFor(context, params).then((repo) =>
          repo.ok ? inbox.subscription(viewer, { repoId: repo.value.id, number }).catch(() => null) : null,
        )
      : null,
    // The project's agents at work, for the line under the pull request
    // one is on for this issue: with the page, not after it.
    agents.listRuns(viewer, { repo: path, active: true, limit: 50 }).catch(() => null),
    // The teams a member can mention, for the comment box.
    roleIn(viewer, params.owner) ? identity.listTeams(viewer, params.owner).catch(() => null) : null,
  ]);
  if (!found.ok) {
    // Issues and pull requests share numbers; this one may be a pull request.
    const pull = await work.getPull(path, number, viewer);
    if (pull.ok) throw redirect(`/${params.owner}/${params.repo}/pull/${number}`);
    throw notFound("issue");
  }
  const { issue } = found.value;
  return {
    ...found.value,
    viewer,
    labels: labels.ok ? labels.value : [],
    milestones: milestones.ok ? milestones.value : [],
    agentsEnabled,
    computeNote,
    links,
    subscription,
    // As the project's agents.json has them; left out, the line fetches them.
    activeRuns: active?.ok ? { runs: active.value, member: can.run } : undefined,
    members: members?.ok ? members.value.map((member) => member.username) : [],
    handles: teams?.ok ? teams.value.map((team) => `@${team.workspace}/${team.slug}`) : [],
    // The author can close and reopen their own issue, and whoever g1t's
    // agent filed one for, that one; Triage and up, anyone's.
    canManage: viewer != null && (viewer.id === workOwner(issue).id || can.triage),
    // Maintain and up edit and delete anyone's comments; everyone, their own.
    canModerate: can.manage_settings,
    can,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  // What each form needs; closing your own issue is checked by work.
  // Labels: its author may use the repository's on their own issue, and
  // work says so; anyone else, and every milestone, needs Triage.
  const needed =
    form.get("action") === "run-hosted"
      ? "run"
      : form.get("action") === "assign" || form.get("action") === "milestone"
        ? "triage"
        : null;
  const refused = needed ? await refusal(context, params, needed) : null;
  if (refused) return { error: refused, action: String(form.get("action")) };

  switch (form.get("action")) {
    case "run-hosted": {
      const result = await env.RUNNER.run(user, path, number, {
        instructions: String(form.get("instructions") ?? ""),
      });
      return result.ok ? null : { error: result.error.message, action: "run-hosted" };
    }
    case "open-pull": {
      const result = await work.openPull(user, path, {
        issue: number,
        agent: String(form.get("agent") ?? ""),
        runtime: "external",
      });
      if (!result.ok) return { error: result.error.message };
      throw redirect(`/${params.owner}/${params.repo}/pull/${result.value.number}`);
    }
    case "comment": {
      const result = await work.addComment(user, path, number, {
        body: String(form.get("body") ?? ""),
      });
      return result.ok ? null : { error: result.error.message };
    }
    case "assign": {
      const result = await work.updateIssue(user, path, number, {
        assignees: [
          ...form.getAll("assignee").map(String),
          ...String(form.get("others") ?? "").split(/[\s,]+/),
        ],
      });
      return result.ok ? null : { error: result.error.message };
    }
    case "labels": {
      const result = await work.setLabels(user, path, number, form.getAll("label").map(String));
      return result.ok ? null : { error: result.error.message, action: "labels" };
    }
    case "milestone": {
      const result = await work.updateIssue(user, path, number, { milestone: Number(form.get("milestone")) || 0 });
      return result.ok ? null : { error: result.error.message, action: "milestone" };
    }
    case "reopen": {
      const result = await work.reopenIssue(user, path, number);
      return result.ok ? null : { error: result.error.message };
    }
    // A comment's own text, changed or taken away: its author's to do, or
    // a maintainer's, which work checks.
    case "edit-comment":
    case "delete-comment": {
      const action = String(form.get("action"));
      const id = String(form.get("comment") ?? "");
      const result =
        action === "edit-comment"
          ? await work.editComment(user, path, id, String(form.get("body") ?? ""))
          : await work.deleteComment(user, path, id);
      return result.ok ? null : { error: result.error.message, action, comment: id };
    }
    default: {
      const result = await work.closeIssue(
        user,
        path,
        number,
        form.get("action") === "close-not-planned" ? "not_planned" : "completed",
      );
      return result.ok ? null : { error: result.error.message };
    }
  }
}

/** What became of a pull request, in a few words. */
function outcome(pull: Pull): string {
  if (pull.status === "merged") return `Merged by ${pull.mergedBy ?? "someone"}`;
  if (pull.supersededBy != null) return `Closed · #${pull.supersededBy} was merged instead`;
  if (pull.status === "closed") return "Closed without merging";
  if (pull.status === "draft") return "Draft · in progress";
  return "Ready for review";
}

function PullRow({ pull, base }: { pull: Pull; base: string }) {
  const merged = pull.status === "merged";
  const opener = openedBy(pull);
  return (
    <li>
      <Link
        to={`${base}/pull/${pull.number}`}
        className={`block rounded-xl border p-4 transition-colors ${
          merged
            ? "border-merged/40 bg-merged/5 hover:border-merged/70"
            : "border-line bg-surface hover:border-line-strong"
        } ${pull.status === "closed" ? "opacity-70" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PullIcon status={pull.status} />
          <span className="font-medium">
            {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
          </span>
          {pull.status === "draft" && (
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          )}
          <span className="ml-auto flex items-center gap-3 text-xs text-faint">
            <ChangeSize files={pull.files} />
            <CheckBadge status={pull.checkStatus} />
            <span className="flex items-center gap-1 font-mono">
              <GitCommitHorizontal size={13} />
              {pull.headCommit?.slice(0, 7) ?? "no commits"}
            </span>
            <TimeAgo at={pull.updatedAt} />
          </span>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className={merged ? "font-medium text-merged" : ""}>{outcome(pull)}</span>
          <span className="text-faint">·</span>
          <span className="flex items-center gap-1 font-mono">
            <Bot size={12} />
            {pull.agent}
          </span>
          {opener.requestedBy ? (
            <span className="text-faint">· requested by {opener.requestedBy}</span>
          ) : (
            <>
              {pull.runtime === "hosted" && <span className="text-faint">on g1t</span>}
              <span className="text-faint">· opened by {opener.name}</span>
            </>
          )}
        </p>
        {pull.body && (
          <p className="mt-2 line-clamp-2 text-sm text-muted">{plainText(pull.body)}</p>
        )}
      </Link>
    </li>
  );
}

export default function IssuePage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { issue, pulls, comments, viewer, labels, agentsEnabled, members, canManage, can } = loaderData;

  // Follow agents at work without a manual reload.
  const running = pulls.some(
    (pull) =>
      pull.status === "draft" ||
      pull.checkStatus === "queued" ||
      pull.checkStatus === "running",
  );
  // The pull request g1t's agent has in progress for this issue, if any.
  const assigned = [...pulls]
    .reverse()
    .find(
      (pull) =>
        pull.agent === "g1t" &&
        pull.runtime === "hosted" &&
        (pull.status === "draft" || pull.status === "open"),
    );
  useRefreshWhile(Boolean(running || assigned));

  // A refusal to start g1t shows by its button; every other error below the discussion.
  const runError = actionData && "action" in actionData && actionData.action === "run-hosted";
  const base = `/${params.owner}/${params.repo}`;
  const open = issue.state === "open";
  const reference = `${params.owner}/${params.repo}#${issue.number}`;
  const resolver = pulls.find((pull) => pull.number === issue.resolvedBy);
  // The merged pull request first, then the ones still in play, then the rest.
  const rank = { merged: 0, open: 1, draft: 2, closed: 3 } as const;
  const ordered = [...pulls].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.number - b.number,
  );

  return (
    // On a phone: the title, then the sidebar as a Details disclosure, then
    // the issue; beside it from lg up.
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[1fr_19rem] lg:grid-rows-[auto_1fr] lg:gap-y-0">
      <header className="min-w-0 lg:col-start-1">
        <h2 className="text-xl font-semibold tracking-tight text-balance wrap-break-word sm:text-2xl">
          {issue.title} <span className="font-normal text-faint">#{issue.number}</span>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <IssueState issue={issue} />
          <span className="flex items-center gap-2">
            <Avatar name={issue.author.username} size={18} />
            <span>
              <PersonLink name={issue.author.username} className="font-medium text-fg hover:underline" /> opened this{" "}
              {issue.requestedBy && (
                <>
                  for{" "}
                  <PersonLink name={issue.requestedBy.username} className="font-medium text-fg-soft hover:underline" />{" "}
                </>
              )}
              <TimeAgo at={issue.createdAt} />
            </span>
          </span>
          {issue.labels.map((name) => (
            <LabelChip key={name} name={name} color={labels.find((label) => label.name === name)?.color} />
          ))}
          {open && issue.agent && <Assignee agent={issue.agent} />}
        </div>
      </header>

      <div className="min-w-0 max-lg:order-1 lg:col-start-1">

        {issue.resolvedBy != null && (
          <Link
            to={`${base}/pull/${issue.resolvedBy}`}
            className="flex lg:mt-5 items-center gap-3 rounded-xl border border-merged/40 bg-merged/5 px-4 py-3 text-sm transition-colors hover:border-merged/70"
          >
            <GitMerge size={18} className="shrink-0 text-merged" />
            <span>
              Resolved by{" "}
              <span className="font-medium">
                {resolver?.title ?? "pull request"} #{issue.resolvedBy}
              </span>
              {resolver?.mergedBy && (
                <span className="text-muted">
                  , merged by {resolver.mergedBy}{" "}
                  {resolver.mergedAt && <TimeAgo at={resolver.mergedAt} />}
                </span>
              )}
            </span>
          </Link>
        )}

        {issue.body && (
          <div className={`${issue.resolvedBy != null ? "mt-5" : "lg:mt-5"} rounded-xl border border-line bg-surface p-4 sm:p-5`}>
            <Markdown source={issue.body} repo={{ namespace: params.owner, name: params.repo }} />
          </div>
        )}

        <div className="mt-10 flex items-baseline justify-between">
          <h3 className="font-semibold tracking-tight">Pull requests</h3>
          <p className="text-sm text-muted">
            {pulls.length === 0
              ? "None yet"
              : `${pulls.length} for this issue${
                  pulls.some((pull) => pull.status === "merged") ? "" : ", none merged"
                }`}
          </p>
        </div>
        <div className="mt-3">
          {pulls.length === 0 ? (
            <EmptyState title="Nobody has worked on this yet">
              Put g1t on it, or point your own agent at{" "}
              <code className="font-mono">{reference}</code>.
            </EmptyState>
          ) : (
            <ol className="space-y-3">
              {ordered.map((pull) => (
                <PullRow key={pull.id} pull={pull} base={base} />
              ))}
            </ol>
          )}
        </div>

        <h3 className="mt-10 font-semibold tracking-tight">Discussion</h3>
        <div className="mt-3">
          <div className="space-y-4">
            <CommentList
              comments={comments}
              base={base}
              viewerId={viewer?.id ?? null}
              canModerate={loaderData.canModerate}
              failed={actionData && "comment" in actionData ? { comment: String(actionData.comment), error: actionData.error } : null}
            />
            <CommentForm author={viewer?.username ?? null} resetKey={comments.length} handles={loaderData.handles} />
            {canManage && (
              <Form method="post" className="flex flex-wrap justify-end gap-2">
                {open ? (
                  <>
                    <SubmitButton variant="quiet" name="action" value="close-not-planned" pending="Closing…">
                      Close as not planned
                    </SubmitButton>
                    <SubmitButton variant="quiet" name="action" value="close-completed" pending="Closing…">
                      Close issue
                    </SubmitButton>
                  </>
                ) : (
                  <SubmitButton variant="quiet" name="action" value="reopen" pending="Reopening…">
                    Reopen issue
                  </SubmitButton>
                )}
              </Form>
            )}
          </div>
        </div>
        <div className="mt-2">
          {/* A refused comment edit says so under the comment. */}
          {!runError && !(actionData && "comment" in actionData) && <ErrorText>{actionData?.error}</ErrorText>}
        </div>
      </div>

      <DetailsDisclosure
        className="lg:col-start-2 lg:row-span-2 lg:row-start-1"
        summary={detailsSummary([
          [issue.assignees.length, "assignee", "assignees"],
          [issue.labels.length, "label", "labels"],
          [issue.milestone ? 1 : 0, "milestone", "milestones"],
        ])}
      >
        {loaderData.links.length > 0 && (
          <section>
            <h3 className="text-sm font-medium">From outside g1t</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {loaderData.links.map((link) => (
                <li key={`${link.connectionId}-${link.key}`}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 transition-colors hover:border-line-strong"
                  >
                    <span className="min-w-0 grow">
                      <span className="block truncate font-medium">
                        {PROVIDERS[link.provider].label} <span className="font-mono text-muted">{link.key}</span>
                      </span>
                      <span className="block text-xs text-faint">
                        {link.count > 1 ? `Seen ${link.count} times, last ` : "Linked "}
                        <TimeAgo at={link.count > 1 ? link.lastSeen : link.firstSeen} />
                      </span>
                    </span>
                    <ExternalLink size={13} className="shrink-0 text-faint group-hover:text-fg" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="text-sm font-medium">Assignees</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {open && assigned && (
              <li>
                <Link
                  to={`${base}/pull/${assigned.number}`}
                  className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-2 transition-colors hover:border-accent/60"
                >
                  <Sparkles size={15} className="shrink-0 text-accent" />
                  <span className="min-w-0 grow">
                    <span className="block font-mono text-xs font-medium">g1t</span>
                    <span className="block truncate text-xs text-muted">
                      {assigned.status === "draft"
                        ? "Making the change"
                        : "Seeing it through checks and review"}{" "}
                      · #{assigned.number}
                    </span>
                    <AgentStepLine owner={params.owner} repo={params.repo} number={assigned.number} runs={loaderData.activeRuns} />
                  </span>
                  <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                </Link>
              </li>
            )}
            {issue.assignees.map((name) => (
              <li key={name} className="flex items-center gap-2 px-1">
                <Avatar name={name} size={20} />
                <span className="grow truncate font-mono text-xs">
                  <PersonLink name={name} className="hover:underline" />
                </span>
              </li>
            ))}
            {open && issue.queued && !assigned && (
              <li className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
                <Sparkles size={15} className="shrink-0 text-faint" />
                <span className="min-w-0 grow">
                  <span className="block font-mono text-xs font-medium">g1t</span>
                  <span className="block text-xs text-muted">
                    {issue.blockedBy.length > 0
                      ? "Queued. Starts when what this depends on has merged."
                      : "Queued. Starts as soon as there is room."}
                  </span>
                </span>
              </li>
            )}
            {!open && resolver && resolver.agent === "g1t" && (
              <li>
                <Link
                  to={`${base}/pull/${resolver.number}`}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 transition-colors hover:border-line-strong"
                >
                  <Sparkles size={15} className="shrink-0 text-accent" />
                  <span className="min-w-0 grow">
                    <span className="block font-mono text-xs font-medium">g1t</span>
                    <span className="block truncate text-xs text-muted">
                      Resolved it with #{resolver.number}
                    </span>
                  </span>
                </Link>
              </li>
            )}
            {issue.assignees.length === 0 &&
              !(open && (assigned || issue.queued)) &&
              !(!open && resolver?.agent === "g1t") && (
                <li className="px-1 text-xs text-faint">No one yet.</li>
              )}
          </ul>
          {issue.blockedBy.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Depends on{" "}
              {issue.blockedBy.map((number, index) => (
                <span key={number}>
                  {index > 0 && ", "}
                  <Link
                    to={`${base}/issues/${number}`}
                    className="font-medium text-fg hover:underline"
                  >
                    #{number}
                  </Link>
                </span>
              ))}
              {open ? ", which has to merge first." : "."}
            </p>
          )}

          {open && agentsEnabled && can.run && !assigned && !issue.queued && (
            <Form method="post" className="mt-3 space-y-2">
              <input type="hidden" name="action" value="run-hosted" />
              <div className="*:w-full">
                <SubmitButton variant="accent" match={{ action: "run-hosted" }} pending="Starting a sandbox…">
                  <Sparkles size={14} />
                  Assign to g1t
                </SubmitButton>
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                  Add guidance for this run
                </summary>
                <div className="mt-2">
                  <Textarea
                    name="instructions"
                    rows={2}
                    placeholder="On top of the issue's description"
                  />
                </div>
              </details>
              <p className="text-xs text-muted">
                It opens a pull request and sees it through checks, a review by another
                agent and fixes. You get it back ready to merge.
              </p>
              <ComputeNote note={loaderData.computeNote} />
              {runError && <ErrorText>{actionData.error}</ErrorText>}
            </Form>
          )}

          {open && !agentsEnabled && can.run && !assigned && !issue.queued && (
            // Where g1t's agent would be, and what makes it appear.
            <div className="mt-3 rounded-lg border border-dashed border-line p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium">
                <Sparkles size={14} className="text-accent" />
                g1t
              </p>
              <p className="mt-1 text-xs text-muted">
                Connect a model provider and g1t can take this issue: it opens a pull request and sees it
                through checks, review and fixes. Agents run on a paid workspace, or on the free trial.
              </p>
              <Link
                to={`/${params.owner}/-/integrations/models`}
                className="mt-2 inline-block text-xs text-accent hover:underline"
              >
                Connect a model
              </Link>
            </div>
          )}

          {viewer && can.triage && open && (
            <div className="mt-3 space-y-2">
              {!issue.assignees.includes(viewer.username) && (
                <Form method="post">
                  <input type="hidden" name="action" value="assign" />
                  {issue.assignees.map((name) => (
                    <input key={name} type="hidden" name="assignee" value={name} />
                  ))}
                  <input type="hidden" name="assignee" value={viewer.username} />
                  <div className="*:w-full">
                    <SubmitButton variant="quiet" name="who" value="self" pending="Assigning…">
                      Assign yourself
                    </SubmitButton>
                  </div>
                </Form>
              )}
              <details className="group">
                <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                  Assign people
                </summary>
                <Form method="post" className="mt-2 space-y-2" key={issue.assignees.join()}>
                  <input type="hidden" name="action" value="assign" />
                  <PeoplePicker name="assignee" members={members} chosen={issue.assignees} />
                  <SubmitButton variant="quiet" name="who" value="picked" pending="Saving…">
                    Save assignees
                  </SubmitButton>
                </Form>
              </details>
            </div>
          )}
        </section>

        {/* Another way to start the work: not once a pull request is doing it. */}
        {open && !pulls.some((pull) => pull.status === "open" || pull.status === "draft") && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-medium">Bring your own agent</h3>
            <p className="mt-1 text-xs text-muted">
              With g1t connected to your agent, ask it to work on this issue.
            </p>
            <div className="mt-3">
              <CopyLine text={reference} />
            </div>
            {viewer ? (
              <Form method="post" className="mt-4 space-y-2 border-t border-line pt-4">
                <input type="hidden" name="action" value="open-pull" />
                <p className="text-xs text-muted">
                  Or open a draft pull request yourself and get a fork to push to.
                </p>
                <Input name="agent" placeholder="Who is working, e.g. claude-code" maxLength={60} />
                <div className="*:w-full">
                  <SubmitButton match={{ action: "open-pull" }} pending="Opening…">
                    Open pull request
                  </SubmitButton>
                </div>
                <p className="text-xs text-muted">
                  Already pushed a branch?{" "}
                  <Link
                    to={`${base}/pulls/new?issue=${issue.number}`}
                    className="text-fg underline underline-offset-4"
                  >
                    Open a pull request from it
                  </Link>
                  .
                </p>
              </Form>
            ) : (
              <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
                <Link to="/login" className="text-fg underline underline-offset-4">
                  Sign in
                </Link>{" "}
                to open a pull request.
              </p>
            )}
          </section>
        )}

        <LabelsBox
          labels={labels}
          chosen={issue.labels}
          canEdit={loaderData.canManage}
          canCreate={can.manage_labels}
          manageUrl={can.manage_labels ? `${base}/labels` : undefined}
        />
        <MilestoneBox
          milestones={loaderData.milestones}
          current={issue.milestone}
          canEdit={can.triage}
          base={base}
        />

        {viewer && (
          <SubscriptionBox action={`${base}/notifications`} number={issue.number} kind="issue" subscription={loaderData.subscription} />
        )}
      </DetailsDisclosure>
    </div>
  );
}
