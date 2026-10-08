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
  Users,
  Wrench,
} from "lucide-react";
import { Suspense } from "react";
import { Await, Form, Link, redirect } from "react-router";

import {
  type Capability,
  type Comparison,
  type Deployment,
  type Job,
  type LiveApp,
  type SessionEntry,
  type Viewer,
  pullComparison,
  workOwner,
} from "@g1t/contracts";

import type { Route } from "./+types/pull";
import { highlightFirstFiles } from "../../lib/highlight.server";
import { excerpt, page } from "../../lib/meta";
import { openedBy } from "../../lib/opened-by";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { DiffView } from "../../components/diff-view";
import { LifecyclePanel } from "../../components/lifecycle";
import { AgentPanel } from "../../components/agents";
import { BaseBranch } from "../../components/base-branch";
import { LabelChip, LabelsBox, MilestoneBox } from "../../components/labels";
import { Markdown } from "../../components/markdown";
import {
  Avatar,
  ButtonLink,
  CopyLine,
  EmptyState,
  ComputeNote,
  ErrorText,
  SubmitButton,
  Textarea,
  TimeAgo,
  usePending,
} from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import { Loading, SkeletonLine } from "../../components/ui/skeleton";
import { TabStrip } from "../../components/ui/tab-strip";
import { WorkflowStatuses } from "../../components/actions";
import { AddCiPrompt } from "../../components/add-ci";
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
import { CatchUpProgress, ChecksSection, ConflictsSection, MergeabilityRow, runIdOf } from "../../components/merge-box";
import { PullCodeOwnersPanel, TeamReviewer } from "../../components/codeowners";
import { CATCH_UP_TIMEOUT_MS } from "../../lib/catch-up";
import { notFound } from "../../lib/not-found.server";
import { computeNoteFor } from "../../lib/compute.server";
import { actions, agents, deployments, identity, inbox, projects, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { accessTo, refusal, repoFor } from "../../lib/access.server";
import { SubscriptionBox } from "../../components/notifications";
import { REFRESH_MS, useRefreshWhile } from "../../lib/refresh";

const EMPTY_COMPARISON: Comparison = { base: null, head: "", files: [], truncated: false };
const TABS = ["conversation", "session", "changes"] as const;
type Tab = (typeof TABS)[number];

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const pull = loaderData?.pull;
  const title = pull ? `${pull.title} · Pull request #${pull.number} · ` : "";
  const state = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" }[pull?.status ?? "open"];
  const body = excerpt(pull?.body);
  const opener = pull ? openedBy(pull) : null;
  return page(args, {
    title: `${title}${params.owner}/${params.repo} · g1t`,
    description: pull
      ? `${state} pull request #${pull.number} on ${params.owner}/${params.repo} by ${opener!.name}${opener!.requestedBy ? `, requested by ${opener!.requestedBy}` : ""}.${body ? ` ${body}` : ""}`
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

  // Members of the workspace pick reviewers and assignees from its people;
  // what the viewer may do here goes by their role on the repository.
  const member = (viewer?.workspaces ?? []).some(
    (membership) => membership.slug === params.owner,
  );
  // Everything starts at once. Only what the viewer's role decides waits
  // for the repository, which the layout is looking up in this request too
  // (lib/access.server.ts), and only what the pull request decides waits
  // for it.
  const ref = { workspace: params.owner, slug: params.repo };
  const access = accessTo(context, params);
  const pullFound = work.getPull(path, number, viewer);
  const deps = projects.dependencies(params.owner, params.repo, viewer);
  // Awaited below, unless the pull request is missing first.
  deps.catch(() => null);
  // Its labels and milestone, with the repository's to choose from.
  const labelsFound = work.listLabels(path, viewer);
  const milestonesFound = work.listMilestones(path, viewer);
  labelsFound.catch(() => null);
  milestonesFound.catch(() => null);
  const [{ can }, found, repo, settings, agentsEnabled, members, computeNote, session, deployed, subscription, runs, teamList] = await Promise.all([
    access,
    pullFound,
    repos.get(path, viewer),
    work.getSettings(path, viewer),
    env.RUNNER.enabled(viewer, path),
    // A member picks reviewers and assignees from the workspace's people.
    member ? identity.listMembers(params.owner, viewer) : null,
    // Before someone asks g1t for something: whether the plan lets it start.
    access.then(({ can }) => (can.run ? computeNoteFor(params.owner, "agent") : null)),
    tab === "session" ? work.readSession(path, number, viewer) : null,
    // Its preview, for people with a role here: beside the rest, not after.
    access.then(({ insider }) => (insider ? deployments.list(ref, viewer).catch(() => null) : null)),
    // Whether the viewer hears of it, for the sidebar's Notifications.
    viewer
      ? repoFor(context, params).then((found) =>
          found.ok ? inbox.subscription(viewer, { repoId: found.value.id, number }).catch(() => null) : null,
        )
      : null,
    // Its agent's latest runs, for the Agent panel: with the page, not after it.
    agents.listRuns(viewer, { repo: path, number, limit: 5 }).catch(() => null),
    // A member asks the workspace's teams to review, and mentions them.
    member ? identity.listTeams(viewer, params.owner).catch(() => null) : null,
  ]);
  if (!found.ok) {
    // Issues and pull requests share numbers; this one may be an issue.
    const issue = await work.getIssue(path, number, viewer);
    if (issue.ok) throw redirect(`/${params.owner}/${params.repo}/issues/${number}`);
    throw notFound("pull");
  }
  const { pull } = found.value;
  const range = pullComparison(pull);
  // The jobs of each workflow run on its head, to list checks job by job.
  // Read as the viewer: a run they cannot see is listed by its status alone.
  // Streamed: the checks show by status first, then job by job.
  const runIds = [...new Set((found.value.statuses ?? []).map(runIdOf).filter((id) => id != null))].slice(0, 10);
  const workflowJobs =
    tab === "conversation" && pull.status === "open" && runIds.length > 0
      ? Promise.all(runIds.map((id) => actions.run(path, viewer, id).catch(() => null))).then((runs) => {
          const jobs: Record<string, Job[]> = {};
          for (const run of runs) if (run?.ok) jobs[run.value.run.id] = run.value.jobs;
          return jobs;
        })
        .catch(() => ({}) as Record<string, Job[]>)
      : Promise.resolve({} as Record<string, Job[]>);
  // No checks at all on an open pull request: whether that is because the
  // repository has no workflows, to offer a starter one.
  const unchecked =
    tab === "conversation" &&
    pull.status === "open" &&
    (found.value.statuses ?? []).length === 0 &&
    (found.value.requiredChecks ?? []).length === 0;
  const [comparison, used, noChecks] = await Promise.all([
    // The first screens of it highlighted here, so their colours do not pop in.
    tab === "changes"
      ? repos
          .compare(range.repoId, viewer, range.base, range.head, range.baseBranch)
          .then(async (found) => (found.ok ? { ok: true as const, value: await highlightFirstFiles(found.value) } : found))
      : null,
    deps,
    unchecked
      ? actions
          .workflows(path, viewer)
          .then((found) => found.ok && found.value.length === 0)
          .catch(() => false)
      : false,
  ]);
  const affects = used.ok ? used.value.usedBy : [];
  const [labels, milestones] = await Promise.all([labelsFound, milestonesFound]);
  const repoDefault = repo.ok ? repo.value.defaultBranch : "main";
  // The default branch's protection covers pull requests into it only.
  const protectedBase = (pull.base ?? repoDefault) === repoDefault;
  return {
    ...found.value,
    labels: labels.ok ? labels.value : [],
    milestones: milestones.ok ? milestones.value : [],
    // Labelling and milestones: Triage and up; its author, its labels.
    canTriage: can.triage,
    // The branch it merges into: Write and up.
    canChangeBase: can.push,
    workflowJobs,
    tab,
    session: session?.ok ? session.value : [],
    // An empty comparison if it could not be made.
    comparison: comparison && (comparison.ok ? comparison.value : EMPTY_COMPARISON),
    viewer,
    // Write and up can merge.
    canMerge: can.merge,
    // Triage and up manage anyone's pull request; its author, their own,
    // and whoever asked g1t for one, that one.
    canManage: can.triage || (viewer != null && viewer.id === workOwner(pull).id),
    // Telling its agent things, and re-running checks, spend compute: Write and up.
    canRun: can.run,
    // A catch-up is pushed as the viewer: a fork takes pushes only from
    // whoever it is for (who asked g1t for it, or its author), a branch
    // from anyone who can push.
    canUpdate: pull.fork ? viewer?.id === workOwner(pull).id : can.push,
    agentsEnabled,
    computeNote,
    subscription,
    // As the project's agents.json has them; left out, the panel fetches them.
    agentRuns: runs?.ok ? { runs: runs.value, member: can.run } : undefined,
    members: members?.ok ? members.value.map((person) => person.username) : [],
    // `workspace/slug` and name of each team the viewer can see.
    teams: teamList?.ok ? teamList.value.map((team) => ({ ref: `${team.workspace}/${team.slug}`, name: team.name })) : [],
    requireUpToDate: protectedBase && settings.ok && settings.value.requireUpToDate,
    mergeQueue: protectedBase && settings.ok && settings.value.mergeQueue,
    requiredApprovals: protectedBase && settings.ok ? settings.value.requiredApprovals : 0,
    canIgnoreChecks: !settings.ok || settings.value.allowIgnoringChecks,
    noChecks,
    // Who may open the pull request that adds CI: anyone who can push.
    canAddCi: can.push,
    // Who may choose the required checks.
    canProtect: can.manage_protection,
    defaultBranch: repo.ok ? repo.value.defaultBranch : "main",
    affects,
    // Streamed: the conversation shows first, the preview card after.
    ...deploymentOf(deployed?.ok ? deployed.value : null, number, params.owner, affects, viewer),
  };
}

/**
 * Where this pull request is live: its preview (or its latest build, while
 * one is going or after one failed), and the previews of the projects
 * that use this one, built against it.
 */
function deploymentOf(
  list: { deployments: Deployment[]; live: LiveApp[] } | null,
  number: number,
  owner: string,
  affects: { slug: string; name: string }[],
  viewer: Viewer,
): { preview: LiveApp | null; build: Deployment | null; stacked: Promise<Stacked[]> } {
  const preview = list?.live.find((app) => app.kind === "preview" && app.number === number) ?? null;
  const build = list?.deployments.find((d) => d.kind === "preview" && d.number === number) ?? null;
  const branch = preview?.branch ?? build?.branch ?? null;
  // Streamed: another lookup per project, shown in the card once known.
  const stacked: Promise<Stacked[]> = branch
    ? Promise.all(
        affects.slice(0, 5).map(async (project) => {
          const theirs = await deployments.list({ workspace: owner, slug: project.slug }, viewer).catch(() => null);
          const app = theirs?.ok ? theirs.value.live.find((a) => a.kind === "preview" && a.branch === branch) : undefined;
          return app ? { name: project.name, slug: project.slug, url: app.url } : null;
        }),
      ).then((found) => found.filter((entry) => entry != null))
    : Promise.resolve([]);
  return { preview, build, stacked };
}

/** A project that uses this one, with its preview built against this change. */
type Stacked = { name: string; slug: string; url: string };

const PULL_NEEDS: Record<string, Capability> = {
  stack: "run",
  "agent-review": "run",
  "rerun-workflow": "run",
  "rerun-failed": "run",
  message: "run",
  merge: "merge",
  unqueue: "merge",
  milestone: "triage",
  base: "push",
};

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const action = form.get("action");
  // What each form needs beyond reading; work checks the rest.
  const needed = typeof action === "string" ? PULL_NEEDS[action] : undefined;
  const refused = needed ? await refusal(context, params, needed) : null;
  if (refused) return { error: refused, action: String(action) };
  const verdict = form.get("verdict");
  const line = Number(form.get("line"));
  /** Names ticked in a people picker, plus those typed beside it. */
  const picked = (field: string) => [
    ...form.getAll(field).map(String),
    // `@acme/backend` is asked as `acme/backend`.
    ...String(form.get("others") ?? "").split(/[\s,]+/).map((name) => name.replace(/^@/, "")),
  ];
  // The projects that use this one, built against this pull request's preview.
  if (action === "stack") {
    const built = await deployments.stack(user, { workspace: params.owner, slug: params.repo }, String(form.get("branch") ?? ""));
    return built.ok
      ? { action, notice: `Building ${built.value.join(", ")} against this preview. They appear on their Deployments pages.` }
      : { action, error: built.error.message };
  }
  // Asking g1t for its review records the request, then starts it.
  if (action === "agent-review") {
    const asked = await work.updatePull(user, path, number, {
      reviewers: [...form.getAll("reviewer").map(String), "g1t"],
    });
    if (!asked.ok) return { error: asked.error.message, action };
  }
  // Its labels, milestone and base, from the sidebar's menus and the header.
  if (action === "labels") {
    const set = await work.setLabels(user, path, number, form.getAll("label").map(String));
    return set.ok ? null : { error: set.error.message, action };
  }
  if (action === "milestone" || action === "base") {
    const changed = await work.updatePull(
      user,
      path,
      number,
      action === "milestone"
        ? { milestone: Number(form.get("milestone")) || 0 }
        : { base: String(form.get("base") ?? "") },
    );
    return changed.ok ? null : { error: changed.error.message, action };
  }
  // Catching up: merged and pushed in seconds when the two sides changed
  // different files; otherwise handed to a sandbox, which takes a minute.
  if (action === "update") {
    const caught = await work.catchUpPull(user, path, number);
    if (!caught.ok) return { action, error: caught.error.message };
    const update = caught.value;
    if (update.outcome !== "needs_agent") {
      return {
        action,
        updated: { commit: update.commit, already: update.outcome === "up_to_date", at: Date.now() },
      };
    }
    const started = await env.RUNNER.update(user, path, number);
    if (!started.ok) return { action, error: started.error.message };
    return { action, agent: { update, startedAt: Date.now() } };
  }
  // A workflow run's failed jobs, run again. Who may is the actions service's call.
  if (action === "rerun-workflow") {
    const rerun = await actions.rerun(user, path, String(form.get("run") ?? ""), true);
    return rerun.ok ? null : { error: rerun.error.message, action };
  }
  // Every failed run on its head, run again: Mission control's quick action.
  if (action === "rerun-failed") {
    const found = await work.getPull(path, number, user);
    if (!found.ok) return { error: found.error.message, action };
    const failed = [
      ...new Set(
        (found.value.statuses ?? [])
          .filter((status) => status.state === "failure" || status.state === "error")
          .map(runIdOf)
          .filter((id) => id != null),
      ),
    ];
    if (failed.length === 0) return { error: "No workflow run failed on its latest commit.", action };
    const reruns = await Promise.all(failed.map((id) => actions.rerun(user, path, id, true)));
    const refused = reruns.find((rerun) => !rerun.ok);
    return refused && !refused.ok ? { error: refused.error.message, action } : null;
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

/** How many, beside a tab's name, when there are any. */
function TabCount({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="rounded-full bg-raised px-1.5 py-px text-xs tabular-nums text-muted ring-1 ring-line">
      {n.toLocaleString("en-US")}
    </span>
  );
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
      aria-current={active ? "page" : undefined}
      className={
        "-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 text-sm whitespace-nowrap transition-colors " +
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
    requiredChecks = [],
    noChecks,
    canAddCi,
    canProtect,
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
    agentRuns,
    members,
    teams,
    codeOwners,
    tab,
    session,
    comparison,
    viewer,
    canMerge,
    canManage,
    canRun,
    defaultBranch: repoDefault,
  } = loaderData;
  // The branch it merges into: what every line below names.
  const defaultBranch = pull.base ?? repoDefault;
  const base = `/${params.owner}/${params.repo}`;
  const here = `${base}/pull/${pull.number}`;
  // g1t, on a pull request it made: the person who asked for it is a line below.
  const opener = openedBy(pull);
  const checksSection = (jobs: Record<string, Job[]>, loading = false) => (
    <ChecksSection
      run={checks}
      required={requiredChecks}
      statuses={statuses}
      jobs={jobs}
      pull={pull}
      base={base}
      earlier={earlierChecks}
      canRerunWorkflows={canMerge}
      settingsUrl={canProtect ? `${base}/settings/branches` : null}
      error={actionData?.action === "rerun-failed" || actionData?.action === "rerun-workflow" ? actionData.error : null}
      loading={loading}
    />
  );
  const addresses = useAddresses();
  const remote = pull.fork
    ? cloneUrl(addresses, `${pull.fork.namespace}/${pull.fork.name}`)
    : cloneUrl(addresses, `${params.owner}/${params.repo}`);
  const active = pull.status === "draft" || pull.status === "open";

  // Follow an agent at work, or checks in progress, without a manual reload.
  const working = pull.status === "draft";
  const checking = statuses.some((status) => status.state === "pending");
  const reviews = verdicts(comments);
  // What stands between this pull request and a merge, if anything: a
  // required check that has not passed, or the merge queue taking it out.
  const unchecked = requiredChecks.some((check) => check.state !== "success") || checks?.status === "failed";
  const requiredFailed = requiredChecks.some((check) => check.state === "failure") || checks?.status === "failed";
  // Pull requests for other issues changing the same files will conflict;
  // ones for the same issue are alternatives, and expected to.
  const collisions = overlaps.filter((other) => other.issue == null || other.issue !== pull.issue);
  const review = {
    changesUrl: here + "?tab=changes",
    // Nobody reviews their own pull request, nor one g1t made for them.
    canJudge: active && viewer != null && viewer.id !== workOwner(pull).id,
  };
  // Everyone whose review was asked for, then anyone who reviewed unasked.
  const reviewerNames = [
    ...new Set([...pull.reviewers, ...reviews.map(({ reviewer }) => reviewer)]),
  ];
  const teamReviewers = pull.teamReviewers ?? [];
  // Teams to ask: the workspace's, and any asked already.
  const teamChoices = [
    ...teams,
    ...teamReviewers.filter((ref) => !teams.some((team) => team.ref === ref)).map((ref) => ({ ref, name: ref })),
  ];
  // Branch protection wants code owners' approval it does not have yet.
  const ownersMissing = codeOwners?.required && codeOwners.missing ? codeOwners.missing : null;
  // A catch-up: the click shows at once; the answer says whether it is
  // done already or a sandbox is on it.
  const catchUpPending = usePending({ action: "update" });
  const catchUp = actionData?.action === "update" ? actionData : null;
  const caughtUp = catchUp && "updated" in catchUp ? catchUp.updated : null;
  const agentCatchUp = catchUp && "agent" in catchUp ? catchUp.agent : null;
  // Pushed already: followed until the pull request's head is the merge,
  // so its checks show starting again, for a minute at most.
  const settling =
    caughtUp != null && !caughtUp.already && pull.headCommit !== caughtUp.commit && Date.now() - caughtUp.at < 60_000;
  // Followed until it is pushed, or for so long, never longer.
  const catchingUp =
    agentCatchUp != null && behind && Date.now() - agentCatchUp.startedAt < CATCH_UP_TIMEOUT_MS + REFRESH_MS;
  // g1t is taking a step of its own accord, so the page will change.
  const moving =
    lifecycle != null && lifecycle.stage !== "ready" && lifecycle.stage !== "needs_you";
  // Whether it merges cleanly is being worked out, so the box will change.
  const probing = active && mergeable === "checking";
  const conflicting = active && mergeable === "conflicting";
  useRefreshWhile(working || checking || reviewPending || catchingUp || settling || moving || landing || probing);
  // Why the merge button cannot be pressed, if it cannot.
  const mergeBlocked = conflicting
    ? "Resolve the conflicts first."
    : probing
      ? "Waiting to find out whether it merges cleanly."
      : behind && requireUpToDate
        ? `This repository requires it to be up to date with ${defaultBranch} first.`
        : unchecked && !canIgnoreChecks
          ? `The checks ${defaultBranch} requires have to pass first.`
          : ownersMissing
            ? "Code owners have to approve first."
            : null;

  return (
    // The changes get the whole width; people and settings are a tab away.
    <div>
      {/* The title and the tabs run the full width; what is happening on
          the pull request sits at the top of Conversation. */}
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <PullState status={pull.status} />
          <span className="flex items-center gap-2">
            <Avatar
              name={(pull.status === "merged" && pull.mergedBy) || opener.name}
              size={18}
            />
            <span>
              <PersonLink
                name={(pull.status === "merged" && pull.mergedBy) || opener.name}
                className="font-medium text-fg hover:underline"
              />{" "}
              {pull.status === "merged" ? "merged" : "wants to merge"}
              {pull.branch && (
                <>
                  {" "}
                  <span className="font-mono text-fg">{pull.branch}</span>
                </>
              )}{" "}
              into{" "}
              <BaseBranch
                base={defaultBranch}
                head={pull.fork ? null : pull.branch}
                canChange={loaderData.canChangeBase && active}
                branchesUrl={`${base}/branches.json`}
              />
            </span>
          </span>
          {(pull.labels ?? []).map((name) => (
            <LabelChip key={name} name={name} color={loaderData.labels.find((label) => label.name === name)?.color} />
          ))}
          {opener.requestedBy && (
            <span className="text-xs">
              requested by{" "}
              <PersonLink name={opener.requestedBy} className="font-medium text-fg-soft hover:underline" />
            </span>
          )}
          {/* A pull request from a branch was made by its author, not an agent;
              one g1t made already says so. */}
          {!pull.branch && !opener.requestedBy && (
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
                  verdict === "approve" ? "text-success" : "text-danger"
                }`}
              >
                {verdict === "approve" ? <CircleCheck size={15} /> : <CircleSlash size={15} />}
                {verdict === "approve" ? "Approved by" : "Changes requested by"}{" "}
                <span className="font-medium">{reviewer}</span>
              </span>
            ))}
          </p>
        )}

        <TabStrip label="Pull request" className="mt-6 items-end gap-1 border-b border-line">
          <TabLink to={here} active={tab === "conversation"}>
            <MessageSquare size={15} />
            Conversation
            <TabCount n={comments.length} />
          </TabLink>
          <TabLink to={here + "?tab=session"} active={tab === "session"}>
            <MessagesSquare size={15} />
            Session
          </TabLink>
          <TabLink to={here + "?tab=changes"} active={tab === "changes"}>
            <FileDiff size={15} />
            Files changed
            <TabCount n={pull.files.length} />
          </TabLink>
          {pull.files.length > 0 && (
            <span className="ml-auto hidden pb-2.5 font-mono text-xs sm:inline">
              <span className="text-success">+{pull.files.reduce((sum, file) => sum + file.additions, 0).toLocaleString("en-US")}</span>{" "}
              <span className="text-danger">−{pull.files.reduce((sum, file) => sum + file.deletions, 0).toLocaleString("en-US")}</span>
            </span>
          )}
        </TabStrip>
      </header>
      <div className={`mt-6 grid gap-8 ${tab === "changes" ? "" : "lg:grid-cols-[1fr_19rem]"}`}>
        <div className="min-w-0">
          {/* What is happening on it now: its stage, its agent, what people told
              the agent, and what else touches the same files. On the conversation,
              so the tabs sit right under the title. */}
          {tab === "conversation" && (
            <div>
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
              {lifecycle && <LifecyclePanel lifecycle={lifecycle} />}
              {/* The agent on it: who, doing what this minute, for how long, at what cost. */}
              <AgentPanel
                owner={params.owner}
                repo={params.repo}
                number={pull.number}
                stage={lifecycle?.stage ?? null}
                confidence={pull.confidence ?? null}
                runs={agentRuns}
              />

              {/* Steering: while its agent works, people can tell it things. */}
              {canRun &&
                pull.runtime === "hosted" &&
                (working || ["working", "revising", "catching_up", "answering"].includes(lifecycle?.stage ?? "")) && (
                  // Keyed by the messages so the box empties once one shows below.
                  <Form method="post" className="mt-4 rounded-2xl bg-surface p-4 ring-1 ring-accent/30" key={messages.length}>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Sparkles size={15} className="text-accent" />
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
                        className="h-9 min-w-0 grow rounded-md bg-bg px-3 text-sm ring-1 ring-line outline-none placeholder:text-faint focus:ring-accent/60"
                      />
                      <SubmitButton match={{ action: "message" }} pending="Sending…">
                        Send
                      </SubmitButton>
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
                          <span className="mt-1 block border-l-2 border-accent/40 pl-2 text-muted">
                            {message.declined ? "Declined: " : "Answer: "}
                            {message.answer}
                          </span>
                        )}
                      </span>
                      <span className={`shrink-0 text-xs ${message.deliveredAt ? "text-success" : "text-faint"}`}>
                        {message.deliveredAt ? "read by the agent" : "waiting for its next step"}
                      </span>
                    </li>
                  ))}
                </ul>
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
            </div>
          )}
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
                  author={opener.name}
                  at={pull.createdAt}
                  action={
                    <span>
                      opened this pull request
                      {opener.requestedBy ? (
                        <>
                          {" "}
                          for{" "}
                          <PersonLink name={opener.requestedBy} className="font-medium text-fg-soft hover:underline" />
                        </>
                      ) : !pull.branch && (
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
                        <input type="hidden" name="action" value="describe" />
                        <Textarea
                          name="summary"
                          rows={6}
                          placeholder="What changed and why"
                          defaultValue={pull.body ?? ""}
                        />
                        <SubmitButton match={{ action: "describe" }} pending="Saving…">
                          Save
                        </SubmitButton>
                      </Form>
                    </details>
                  )}
                </TimelineItem>

                <CommentList comments={comments} review={review} base={base} />

                {(preview || build) && <DeploymentCard preview={preview} build={build} stacked={stacked} stacking={affects.length > 0} base={base} />}

                {pull.status === "draft" && (
                  <StatusBox>
                    <StatusRow icon={<Loader size={16} className="text-faint" />} title="This is a draft">
                      It is still being worked on. It can be reviewed and merged once it is
                      marked ready.
                    </StatusRow>
                    {canManage && (
                      <Form method="post" className="space-y-2 px-4 py-3">
                        <input type="hidden" name="action" value="ready" />
                        <Textarea name="summary" rows={3} placeholder="What changed and why" />
                        <SubmitButton match={{ action: "ready" }} pending="Marking ready…">
                          Mark ready for review
                        </SubmitButton>
                      </Form>
                    )}
                  </StatusBox>
                )}

                {codeOwners && active && (
                  <div className="flex gap-3">
                    <span className="hidden w-8 shrink-0 sm:block" />
                    <div className="min-w-0 grow">
                      <PullCodeOwnersPanel
                        owners={codeOwners}
                        base={base}
                        branch={defaultBranch}
                        errorsHref={canProtect ? `${base}/settings/branches#codeowners` : `${base}/blob/${encodeURIComponent(defaultBranch)}/${codeOwners.path}`}
                      />
                    </div>
                  </div>
                )}

                {pull.status === "open" && (
                  <StatusBox>
                    {/* Checks by status at once; job by job when the runs are read. */}
                    <Suspense fallback={checksSection({}, true)}>
                      <Await resolve={workflowJobs}>{(jobs) => checksSection(jobs)}</Await>
                    </Suspense>
                    {noChecks && <AddCiPrompt owner={params.owner} repo={params.repo} canAdd={canAddCi} compact />}
                    <StatusRow
                      icon={
                        reviews.some(({ verdict }) => verdict === "request_changes") ? (
                          <CircleSlash size={16} className="text-danger" />
                        ) : reviews.length > 0 ? (
                          <CircleCheck size={16} className="text-success" />
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
                      {reviewPending && "g1t is reviewing it now. "}
                      {requiredApprovals > 0 &&
                        `This repository requires ${requiredApprovals} approving ${
                          requiredApprovals === 1 ? "review" : "reviews"
                        } before merging.`}
                    </StatusRow>
                    {codeOwners?.required && (
                      <StatusRow
                        icon={
                          ownersMissing ? (
                            <CircleSlash size={16} className="text-warn" />
                          ) : (
                            <CircleCheck size={16} className="text-success" />
                          )
                        }
                        title={ownersMissing ? "Waiting for code owners" : "Code owners approved"}
                      >
                        {ownersMissing ?? `Every file it changes has its owners' approval.`}{" "}
                        {ownersMissing && "This repository requires their review before merging."}
                      </StatusRow>
                    )}
                    {landing ? (
                      <StatusRow
                        icon={<Loader size={16} className="animate-spin text-accent" />}
                        title="Merging"
                      >
                        {defaultBranch} has moved, so g1t is bringing this up to date first. It
                        lands as soon as that is done. Watch it in the Session tab.
                      </StatusRow>
                    ) : agentCatchUp && behind ? (
                      <CatchUpProgress
                        owner={params.owner}
                        repo={params.repo}
                        number={pull.number}
                        defaultBranch={defaultBranch}
                        behind={behind}
                        update={agentCatchUp.update}
                        startedAt={agentCatchUp.startedAt}
                        retrying={catchUpPending}
                        runs={agentRuns}
                      />
                    ) : conflicting ? (
                      <ConflictsSection
                        conflicts={conflicts}
                        pull={pull}
                        owner={params.owner}
                        repo={params.repo}
                        defaultBranch={defaultBranch}
                        changesUrl={here + "?tab=changes"}
                        canResolve={canUpdate && agentsEnabled}
                        resolving={catchUpPending}
                        error={catchUp && "error" in catchUp ? catchUp.error : null}
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
                        {canUpdate && (
                          <Form method="post" className="mt-2">
                            <input type="hidden" name="action" value="update" />
                            <SubmitButton variant="quiet" match={{ action: "update" }} pending={`Merging ${defaultBranch} in…`}>
                              Catch up with {defaultBranch} now
                            </SubmitButton>
                          </Form>
                        )}
                        {catchUp && "error" in catchUp && <ErrorText>{catchUp.error}</ErrorText>}
                      </StatusRow>
                    ) : (
                      (pull.headCommit || (catchUp && "error" in catchUp)) && (
                        <StatusRow
                          icon={<CircleCheck size={16} className="text-success" />}
                          title={
                            (caughtUp && !caughtUp.already) || agentCatchUp
                              ? `Brought up to date with ${defaultBranch}`
                              : `Up to date with ${defaultBranch}`
                          }
                        >
                          {caughtUp && !caughtUp.already && (
                            <>
                              Merged <span className="font-mono">{defaultBranch}</span> in as{" "}
                              <span className="font-mono text-fg">{caughtUp.commit.slice(0, 7)}</span>. Its checks run
                              again on the new commit.
                            </>
                          )}
                          {agentCatchUp && "g1t merged it in and pushed the result. Its checks run again on the new commit."}
                          {/* A catch-up refused or failed after the pull request stopped being behind. */}
                          {catchUp && "error" in catchUp && <ErrorText>{catchUp.error}</ErrorText>}
                        </StatusRow>
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
                        <SubmitButton variant="quiet" name="action" value="unqueue" pending="Removing…">
                          Remove from the queue
                        </SubmitButton>
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
                            label={`Bypass the required checks: merge although ${requiredFailed ? "one failed" : "they have not all passed"}.`}
                            labelClassName="text-xs text-muted"
                          />
                        )}
                        <div className="flex flex-wrap items-center gap-3">
                          <Hint label={mergeBlocked} disabled={mergeBlocked != null}>
                            <SubmitButton
                              variant="accent"
                              name="action"
                              value="merge"
                              disabled={mergeBlocked != null}
                              pending={mergeQueue ? "Adding to the queue…" : "Merging…"}
                            >
                              {mergeQueue ? <Layers size={15} /> : <GitMerge size={15} />}
                              {mergeQueue ? "Add to the merge queue" : `Merge into ${defaultBranch}`}
                            </SubmitButton>
                          </Hint>
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
                  handles={teams.map((team) => `@${team.ref}`)}
                />
                {canManage && active && (
                  <Form method="post" className="flex justify-end">
                    <SubmitButton variant="quiet" name="action" value="close" pending="Closing…">
                      Close pull request
                    </SubmitButton>
                  </Form>
                )}
                {actionData &&
                  !["merge", "comment", "stack", "rerun-failed", "rerun-workflow", "update", "agent-review", "reviewers", "assign"].includes(
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
          {pull.status !== "open" && <WorkflowStatuses statuses={statuses} />}
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
                  <SubmitButton
                    match={{ action: "stack" }}
                    pending="Starting the builds…"
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50"
                  >
                    Preview them against this change
                  </SubmitButton>
                </Form>
              )}
              {actionData?.action === "stack" &&
                ("notice" in actionData ? (
                  <p className="mt-2 text-xs text-success">{String(actionData.notice)}</p>
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
                const pending = name === "g1t" && reviewPending;
                return (
                  <li key={name} className="flex items-center gap-2 px-1">
                    {name === "g1t" ? (
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
                      <span className="flex items-center gap-1 text-xs text-success">
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
              {teamReviewers.map((team) => (
                <TeamReviewer key={team} team={team} />
              ))}
              {reviewerNames.length === 0 && teamReviewers.length === 0 && (
                <li className="px-1 text-xs text-faint">No reviews requested yet.</li>
              )}
            </ul>
            {pull.status === "open" && canManage && (
              <div className="mt-3 space-y-2">
                {agentsEnabled && !reviewPending && (
                  <Form method="post">
                    <input type="hidden" name="action" value="agent-review" />
                    {[...pull.reviewers, ...teamReviewers].map((name) => (
                      <input key={name} type="hidden" name="reviewer" value={name} />
                    ))}
                    <div className="*:w-full">
                      <SubmitButton variant="quiet" match={{ action: "agent-review" }} pending="Asking g1t…">
                        <Sparkles size={14} className="text-accent" />
                        Request review from g1t
                      </SubmitButton>
                    </div>
                    <ComputeNote note={loaderData.computeNote} />
                  </Form>
                )}
                <details>
                  <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                    {teamChoices.length > 0 ? "Request review from people or teams" : "Request review from people"}
                  </summary>
                  <Form method="post" className="mt-2 space-y-2" key={[...pull.reviewers, ...teamReviewers].join()}>
                    <input type="hidden" name="action" value="reviewers" />
                    {pull.reviewers.includes("g1t") && (
                      <input type="hidden" name="reviewer" value="g1t" />
                    )}
                    <PeoplePicker
                      name="reviewer"
                      members={members.filter((name) => name !== workOwner(pull).username)}
                      chosen={pull.reviewers.filter((name) => name !== "g1t")}
                      placeholder="Other usernames or teams (acme/backend)"
                    />
                    {teamChoices.length > 0 && (
                      <div className="space-y-1.5 border-t border-line pt-2">
                        <p className="text-xs text-faint">Teams</p>
                        {teamChoices.map((team) => (
                          <CheckboxOption
                            key={team.ref}
                            name="reviewer"
                            value={team.ref}
                            defaultChecked={teamReviewers.includes(team.ref)}
                            className="items-center"
                            labelClassName="flex min-w-0 items-center gap-2"
                            label={
                              <>
                                <Users size={14} className="shrink-0 text-faint" />
                                <span className="truncate font-mono text-xs">@{team.ref}</span>
                              </>
                            }
                          />
                        ))}
                      </div>
                    )}
                    <SubmitButton variant="quiet" match={{ action: "reviewers" }} pending="Saving…">
                      Save reviewers
                    </SubmitButton>
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
                      <SubmitButton variant="quiet" name="who" value="self" pending="Assigning…">
                        Assign yourself
                      </SubmitButton>
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
                    <SubmitButton variant="quiet" name="who" value="picked" pending="Saving…">
                      Save assignees
                    </SubmitButton>
                  </Form>
                </details>
              </div>
            )}
            {actionData?.action === "assign" && <ErrorText>{actionData.error}</ErrorText>}
          </section>

          <LabelsBox
            labels={loaderData.labels}
            chosen={pull.labels ?? []}
            canEdit={canManage && active}
            canCreate={loaderData.canTriage}
            manageUrl={loaderData.canTriage ? `${base}/labels` : undefined}
          />
          <MilestoneBox
            milestones={loaderData.milestones}
            current={pull.milestone}
            canEdit={loaderData.canTriage}
            base={base}
          />

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
          {loaderData.viewer && (
            <SubscriptionBox action={`${base}/notifications`} number={pull.number} kind="pull" subscription={loaderData.subscription} />
          )}
        </aside>
      </div>
    </div>
  );
}

/** Where the pull request's change is live, as GitHub shows a deployment. */
function DeploymentCard({
  preview,
  build,
  stacked,
  stacking,
  base,
}: {
  preview: LiveApp | null;
  build: Deployment | null;
  stacked: Promise<Stacked[]>;
  /** Projects use this one, so previews built against it may be on their way. */
  stacking: boolean;
  base: string;
}) {
  const building = build?.status === "queued" || build?.status === "building";
  const failed = build?.status === "failed";
  return (
    <section className="ml-12 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ${
            failed ? "text-danger ring-danger/40" : building ? "text-warn ring-warn/40" : "text-success ring-success/40"
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
      {/* Read after the page: the card's own part shows at once. */}
      <Suspense
        fallback={
          stacking && (
            <Loading className="border-t border-line px-4 py-2.5 text-xs">
              <SkeletonLine className="w-40" />
              <SkeletonLine className="mt-1.5 w-64 max-w-full" />
            </Loading>
          )
        }
      >
        <Await resolve={stacked}>
          {(stacked) =>
            stacked.length > 0 && (
              <div className="animate-fade-in border-t border-line px-4 py-2.5">
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
            )
          }
        </Await>
      </Suspense>
    </section>
  );
}
