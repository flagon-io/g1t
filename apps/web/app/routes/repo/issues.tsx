import { env } from "cloudflare:workers";
import { GitPullRequest, MessageSquare, Plus, Sparkles, X } from "lucide-react";
import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/issues";
import { page } from "../../lib/meta";
import { Button, ButtonLink, ComputeNote, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Assignee,
  AssigneeStack,
  IssueIcon,
  Label,
  StateTabs,
} from "../../components/work";
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
  const query = new URL(request.url).searchParams;
  const state = query.get("state") === "closed" ? "closed" : "open";
  const label = query.get("label") ?? "";
  // Assigning agents needs Write: Read cannot spend compute.
  const { can } = await accessTo(context, params);
  const [issues, labels, agentsEnabled, computeNote] = await Promise.all([
    work.listIssues(path, viewer, { state, label: label || undefined }),
    work.listLabels(path, viewer),
    env.RUNNER.enabled(viewer, path),
    // Before a member assigns: whether the workspace's plan lets agents start.
    can.run ? computeNoteFor(params.owner, "agent") : null,
  ]);
  return {
    issues: unwrap(issues),
    labels: unwrap(labels),
    state,
    label,
    agentsEnabled: agentsEnabled && can.run,
    computeNote,
  } as const;
}

/** Assigns each selected issue to a g1t agent of its own. */
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
  const { issues, labels, state, label, agentsEnabled } = loaderData;
  const repo = `/${params.owner}/${params.repo}`;
  const base = `${repo}/issues`;
  const stateQuery = state === "closed" ? "state=closed" : "";
  const assignable = agentsEnabled && state === "open" && issues.length > 0;
  const assigning = useNavigation().state === "submitting";
  // An archived repository's issues are locked: no new ones.
  const layout = useRouteLoaderData("routes/repo/layout") as { repo?: { archivedAt?: string | null } } | undefined;
  const archived = Boolean(layout?.repo?.archivedAt);
  return (
    <div>
      <StateTabs
        to={base}
        state={state}
        query={label ? `label=${encodeURIComponent(label)}` : ""}
        action={
          archived ? undefined : (
            <ButtonLink to={`${base}/new`}>
              <Plus size={15} />
              New issue
            </ButtonLink>
          )
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {labels.map((name) => {
          const active = name === label;
          const query = [stateQuery, active ? "" : `label=${encodeURIComponent(name)}`]
            .filter(Boolean)
            .join("&");
          return (
            <Link
              key={name}
              to={`${base}?${query}`}
              className={`flex items-center gap-1 rounded-full transition-opacity ${
                label && !active ? "opacity-45 hover:opacity-100" : ""
              }`}
            >
              <Label name={name} />
              {active && <X size={12} className="text-muted" />}
            </Link>
          );
        })}
      </div>
      <Form method="post" className="mt-4">
        {assignable && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-2.5">
            <Sparkles size={15} className="shrink-0 text-accent" />
            <p className="min-w-0 grow text-sm text-muted">
              Tick the issues to hand over. Each gets a g1t agent of its own,
              and they all work at once.
            </p>
            <Button variant="accent" type="submit" disabled={assigning}>
              {assigning ? "Starting sandboxes…" : "Assign to g1t agent"}
            </Button>
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
              label
                ? `No ${state} issues labelled ${label}`
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
                        <Label key={name} name={name} />
                      ))}
                      {issue.state === "open" && issue.agent && (
                        <Assignee agent={issue.agent} />
                      )}
                      {issue.state === "open" && issue.queued && !issue.agent && (
                        <span className="rounded-full border border-line px-2 py-px text-xs text-muted">
                          queued for g1t-agent
                          {issue.blockedBy.length > 0 &&
                            `, after ${issue.blockedBy.map((number) => `#${number}`).join(", ")}`}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{issue.number} opened <TimeAgo at={issue.createdAt} /> by{" "}
                      {issue.author.username}
                      {issue.resolvedBy != null && (
                        <span className="text-merged"> · resolved by #{issue.resolvedBy}</span>
                      )}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-3 text-xs text-muted">
                    <AssigneeStack people={issue.assignees} />
                    {issue.pullCount > 0 && (
                      <span
                        className="flex items-center gap-1"
                        title={`${issue.pullCount} pull ${issue.pullCount === 1 ? "request" : "requests"}`}
                      >
                        <GitPullRequest size={13} />
                        {issue.pullCount}
                      </span>
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
