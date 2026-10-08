import { env } from "cloudflare:workers";
import { GitPullRequest, MessageSquare, Milestone as MilestoneIcon, Plus, Sparkles, Tag } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/issues";
import { page } from "../../lib/meta";
import { ButtonLink, ComputeNote, EmptyState, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Checkbox } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import {
  Assignee,
  AssigneeStack,
  IssueIcon,
  StateTabs,
} from "../../components/work";
import { FilterMenu, LabelChip, Swatch } from "../../components/labels";
import { colorsOf, listFilters, withFilter } from "../../lib/labels";
import { computeNoteFor } from "../../lib/compute.server";
import { isWaitingMessage } from "../../lib/compute";
import { work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { accessTo, refusal } from "../../lib/access.server";

/** As many sandboxes as one request may start. */
const MAX_ASSIGNED_AT_ONCE = 10;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Issues · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  // `?label=bug&milestone=3`, or `label:bug milestone:3` written in `q`.
  const { state, label, milestone } = listFilters(new URL(request.url).searchParams);
  // Assigning agents needs Write: Read cannot spend compute. All at once:
  // only the plan's note waits for the viewer's role.
  const access = accessTo(context, params);
  const [{ can }, issues, labels, milestones, agentsEnabled, computeNote] = await Promise.all([
    access,
    work.listIssues(path, viewer, { state, label: label || undefined, milestone: milestone ?? undefined }),
    work.listLabels(path, viewer),
    work.listMilestones(path, viewer, "open"),
    env.RUNNER.enabled(viewer, path),
    // Before a member assigns: whether the workspace's plan lets agents start.
    access.then(({ can }) => (can.run ? computeNoteFor(params.owner, "agent") : null)),
  ]);
  return {
    issues: unwrap(issues),
    labels: unwrap(labels),
    milestones: milestones.ok ? milestones.value : [],
    state,
    label,
    milestone,
    agentsEnabled: agentsEnabled && can.run,
    computeNote,
  } as const;
}

/** Assigns each selected issue to g1t, one run of its own each. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  const numbers = (await request.formData())
    .getAll("issue")
    .map(Number)
    .filter((number) => Number.isInteger(number) && number > 0);
  if (numbers.length === 0) return { error: "Select the issues to assign first." };
  const denied = await refusal(context, params, "run");
  if (denied) return { error: denied };
  if (numbers.length > MAX_ASSIGNED_AT_ONCE) {
    return { error: `Assign at most ${MAX_ASSIGNED_AT_ONCE} issues at a time.` };
  }
  const results = await Promise.all(
    numbers.map((number) => env.RUNNER.run(user, path, number)),
  );
  // Over the workspace's agents-at-once cap, the rest wait in the queue.
  const waiting = results.filter((result) => !result.ok && isWaitingMessage(result.error.message)).length;
  const refused = results.find((result) => !result.ok && !isWaitingMessage(result.error.message));
  const started = results.filter((result) => result.ok).length;
  return {
    started,
    waiting,
    error:
      refused && !refused.ok
        ? `${started} of ${numbers.length} assigned. ${refused.error.message}`
        : null,
  };
}

export default function Issues({ loaderData, actionData, params }: Route.ComponentProps) {
  const { issues, labels, milestones, state, label, milestone, agentsEnabled } = loaderData;
  const repo = `/${params.owner}/${params.repo}`;
  const base = `${repo}/issues`;
  const assignable = agentsEnabled && state === "open" && issues.length > 0;
  const current = new URLSearchParams(useLocation().search);
  const colors = colorsOf(labels);
  const milestoneTitle = milestones.find((m) => m.number === milestone)?.title ?? (milestone ? `#${milestone}` : null);
  const filtered = [label, milestone].some(Boolean);
  // The tabs keep the filters; each filter keeps the state and the other.
  const kept = new URLSearchParams(current);
  kept.delete("state");
  kept.delete("q");

  // An archived repository's issues are locked: no new ones.
  const layout = useRouteLoaderData("routes/repo/layout") as { repo?: { archivedAt?: string | null } } | undefined;
  const archived = Boolean(layout?.repo?.archivedAt);
  // Handed over: the ticks are cleared. Refused: they stay, to try again.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData && !actionData.error) form.current?.reset();
  }, [actionData]);
  return (
    <div>
      <StateTabs
        to={base}
        state={state}
        query={kept.toString()}
        action={
          archived ? undefined : (
            <ButtonLink to={`${base}/new`}>
              <Plus size={15} />
              New issue
            </ButtonLink>
          )
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Label"
          active={label || undefined}
          clearTo={label ? withFilter(base, current, "label", null) : undefined}
          searchPlaceholder="Filter labels"
          emptyText="No label matches."
          options={labels.map((each) => ({
            key: each.name,
            to: withFilter(base, current, "label", each.name),
            keywords: `${each.name} ${each.description}`,
            selected: each.name === label,
            label: (
              <>
                <Swatch color={each.color} />
                <span className="truncate">{each.name}</span>
              </>
            ),
          }))}
        />
        <FilterMenu
          label="Milestone"
          active={milestoneTitle ?? undefined}
          clearTo={milestone ? withFilter(base, current, "milestone", null) : undefined}
          searchPlaceholder="Filter milestones"
          emptyText="No open milestone matches."
          options={milestones.map((each) => ({
            key: String(each.number),
            to: withFilter(base, current, "milestone", String(each.number)),
            keywords: `${each.title} ${each.number}`,
            selected: each.number === milestone,
            label: <span className="truncate">{each.title}</span>,
          }))}
        />
        {filtered && (
          <Link to={state === "closed" ? `${base}?state=closed` : base} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Link
            to={`${repo}/labels`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Tag size={14} />
            Labels
          </Link>
        </span>
      </div>
      <Form ref={form} method="post" className="mt-4">
        {assignable && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-2.5">
            <Sparkles size={15} className="shrink-0 text-accent" />
            <p className="min-w-0 grow text-sm text-muted">
              Tick the issues to hand over. g1t takes each one in a run of its own,
              and they all work at once.
            </p>
            <SubmitButton variant="accent" pending="Starting sandboxes…">
              Assign to g1t
            </SubmitButton>
            {loaderData.computeNote && (
              <div className="basis-full">
                <ComputeNote note={loaderData.computeNote} />
              </div>
            )}
          </div>
        )}
        {actionData?.error ? (
          <div className="mb-3">
            <ErrorText>{actionData.error}</ErrorText>
          </div>
        ) : (
          actionData?.started != null && (
            <p className="mb-3 text-sm text-muted">
              {actionData.started}{" "}
              {actionData.started === 1 ? "agent is" : "agents are"} starting. Each
              issue shows its pull request as it appears.
              {actionData.waiting
                ? ` ${actionData.waiting} more ${actionData.waiting === 1 ? "waits" : "wait"} for a free slot and start by themselves.`
                : ""}
            </p>
          )
        )}
        {issues.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? `No ${state} issues match these filters`
                : state === "open"
                  ? "No open issues"
                  : "No closed issues"
            }
          >
            An issue says what should change: a bug, a feature, a question.
            Agents and people open pull requests against it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {issues.map((issue) => (
              <li key={issue.id} className="flex items-start transition-colors hover:bg-surface">
                {assignable && (
                  <Checkbox
                    name="issue"
                    value={String(issue.number)}
                    // Already being worked on: nothing more to hand over.
                    disabled={issue.agent != null || issue.queued}
                    aria-label={`Select issue #${issue.number}`}
                    className="mt-4 ml-4 disabled:opacity-30"
                  />
                )}
                <Link
                  prefetch="intent"
                  to={`${base}/${issue.number}`}
                  className="flex min-w-0 grow items-start gap-3 px-4 py-3"
                >
                  <span className="mt-0.5">
                    <IssueIcon issue={issue} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{issue.title}</span>
                      {issue.labels.map((name) => (
                        <LabelChip key={name} name={name} color={colors[name]} />
                      ))}
                      {issue.state === "open" && issue.agent && (
                        <Assignee agent={issue.agent} />
                      )}
                      {issue.state === "open" && issue.queued && !issue.agent && (
                        <span className="rounded-full border border-line px-2 py-px text-xs text-muted">
                          queued for g1t
                          {issue.blockedBy.length > 0 &&
                            `, after ${issue.blockedBy.map((number) => `#${number}`).join(", ")}`}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{issue.number} opened <TimeAgo at={issue.createdAt} /> by{" "}
                      {issue.author.username}
                      {issue.requestedBy && <> for {issue.requestedBy.username}</>}
                      {issue.resolvedBy != null && (
                        <span className="text-merged"> · resolved by #{issue.resolvedBy}</span>
                      )}
                      {issue.milestone && (
                        <span className="inline-flex items-center gap-1">
                          {" "}
                          · <MilestoneIcon size={11} className="inline" /> {issue.milestone.title}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-3 text-xs text-muted">
                    <AssigneeStack people={issue.assignees} />
                    {issue.pullCount > 0 && (
                      <Hint label={`${issue.pullCount} pull ${issue.pullCount === 1 ? "request" : "requests"}`}>
                        <span className="flex items-center gap-1">
                          <GitPullRequest size={13} />
                          {issue.pullCount}
                          <span className="sr-only">pull {issue.pullCount === 1 ? "request" : "requests"}</span>
                        </span>
                      </Hint>
                    )}
                    {issue.commentCount > 0 && (
                      <span className="flex items-center gap-1">
                        <MessageSquare size={13} />
                        {issue.commentCount}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Form>
    </div>
  );
}
