import { Bot, Check, CircleDashed, ExternalLink, GitCommitHorizontal, GitMerge, Lightbulb, Plus, X } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, redirect } from "react-router";

import {
  AGENT_MODES,
  type ItemRepo,
  type LinkRole,
  type Pull,
  PROVIDERS,
  REACTIONS,
  type SuggestedTarget,
  type WorkPull,
  type WorkRepo,
  missingTargets,
  workOwner,
} from "@g1t/contracts";

import type { Route } from "./+types/item";
import { excerpt, page } from "../../../lib/meta";
import { Markdown } from "../../../components/markdown";
import { CopyLine, EmptyState, ErrorText, Input, SubmitButton, TimeAgo } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../../components/ui/dialog";
import { Hint } from "../../../components/ui/hint";
import { SelectField } from "../../../components/ui/select";
import { CheckBadge } from "../../../components/checks";
import { LabelChip, LabelsBox, MilestoneBox } from "../../../components/labels";
import { Assignee, ChangeSize, CommentForm, CommentList, ItemState, PeoplePicker, PersonLink, PullIcon, plainText } from "../../../components/work";
import { AttachImages } from "../../../components/attach-images";
import { RoleBadge } from "../../../components/work-items";
import { DetailsDisclosure, detailsSummary } from "../../../components/details-disclosure";
import { DecisionList, IntegrationFailure, ItemWorkPanel, StartSessionDialog, TimelineSession } from "../../../components/coordination";
import { Reactions } from "../../../components/reactions";
import { SubscriptionBox } from "../../../components/notifications";
import { subscriptionFromForm } from "../../../lib/inbox";
import { Boundary, Unavailable } from "../../../components/boundary";
import { notFound } from "../../../lib/not-found.server";
import { openedBy } from "../../../lib/opened-by";
import { agentSessions, identity, inbox, integrations, repos, work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../../lib/session.server";
import { useRefreshWhile } from "../../../lib/refresh";
import { isFailed, part } from "../../../lib/partial";
import { parseBlockedBy, pullHrefs, resolutionOf } from "../../../lib/coordination";
import { refPath } from "../../../lib/refs.server";
import { itemAbilities } from "../../../lib/work-access";
import { LINK_ROLES, ROLE_LABELS, itemPath, originOf, repoFilter, sessionPath, shortPath, workPath } from "../../../lib/work-items";
import { workspaceProjects } from "../../../lib/workspace-projects.server";
import { workPages } from "../../../lib/repo-live";
import { useWorkspaceLive } from "../../../lib/use-repo-live";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const item = loaderData?.item;
  const title = item ? `${item.title} · Work item #${item.number} · ` : "";
  const state = item?.state === "open" ? "Open" : item?.reason === "not_planned" ? "Closed as not planned" : "Closed";
  const body = excerpt(item?.body);
  return page(args, {
    title: `${title}${params.owner} · g1t`,
    description: item
      ? `${state} work item #${item.number} in ${params.owner}, opened by ${item.author.username}${item.requestedBy ? ` for ${item.requestedBy.username}` : ""}.${body ? ` ${body}` : ""}`
      : null,
    // The card shows the title and the state.
    version: item ? [item.title, item.state, item.reason] : undefined,
    type: "article",
  });
}

/** `owner/name` as a repository path. */
function pathOf(path: string): { namespace: string; name: string } {
  const [namespace = "", name = ""] = path.split("/");
  return { namespace, name };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const number = Number(params.number);
  if (!Number.isInteger(number) || number < 1) throw notFound("page");
  const member = roleIn(viewer, workspace) != null;
  // The item is what the page is about: without it there is no page.
  // Everything beside it is a part (lib/partial.ts), which says it could
  // not be loaded in its own place when its service fails.
  const [found, labels, milestones, members, teams, coordination, ended, agentSetup] = await Promise.all([
    work.getWorkItem(workspace, number, viewer),
    part(work.listLabels(workspace, viewer), "Labels"),
    // Open ones to choose from, and the one it is in, with its progress.
    part(work.listMilestones(workspace, viewer), "Milestones"),
    // A member picks assignees from the workspace's people.
    member ? part(identity.listMembers(workspace, viewer), "The workspace's people") : null,
    // The teams a member can mention, for the comment box: only a
    // suggestion, so the box quietly does without them.
    member ? identity.listTeams(viewer, workspace).catch(() => null) : null,
    // Its repositories with their pull requests and what landed where, who
    // is on it, its sessions, what it waits on, and what it may also need
    // (services/work `get_work`).
    part(work.getWork(workspace, number, viewer), "Work"),
    // Its claims that ended, shown muted under the active ones: history
    // the panel can do without when it cannot be read.
    Promise.all((["released", "expired", "handed_off"] as const).map((state) => work.listClaims(workspace, viewer, { state, item: number }).catch(() => null))),
    // Whether a member can start a session on the workspace's Anthropic
    // account: the button is simply not offered when this cannot be read.
    member ? agentSessions.setup(workspace, viewer).catch(() => null) : null,
  ]);
  if (!found.ok) {
    // Work items and pull requests share the workspace's numbers: this may be a pull request.
    const to = await refPath(viewer, { workspace }, number);
    if (to && to !== itemPath(workspace, number)) throw redirect(to);
    throw notFound("page");
  }
  const { item } = found.value;
  const origin = originOf(item.repos);
  // Who may do what follows the item: the better of their role in the
  // workspace and on its origin repository (lib/work-access.ts).
  const [originRepo, links, subscription, sessionTrees] = await Promise.all([
    origin ? repos.getById(origin.repoId, viewer).catch(() => null) : null,
    // What it is tied to outside g1t. Shown only once the item is known visible.
    part(integrations.links(workspace, number), "Links from outside g1t"),
    // Whether the viewer hears of it, for the sidebar's Notifications.
    viewer ? part(inbox.subscription(viewer, { itemId: item.id, number }), "Notifications") : null,
    // Every session tied to it in its repositories, with their subagents, for the Work panel's trees.
    part(
      Promise.all(item.repos.slice(0, 6).map((linked) => work.listWorkSessions(pathOf(linked.path), viewer, { item: number, subagents: true }))).then((lists) =>
        lists.flatMap((list) => (list.ok ? list.value : [])),
      ),
      "Sessions",
    ),
  ]);
  const ref = originRepo?.ok ? { id: originRepo.value.id, namespace: originRepo.value.namespace, isPrivate: originRepo.value.isPrivate } : null;
  const can = itemAbilities(viewer, workspace, ref);
  // The repositories that can be linked, for whoever may link them.
  const projects = can.triage ? await part(workspaceProjects(workspace, viewer), "Repositories") : null;
  return {
    repos:
      projects == null || isFailed(projects) || !projects.ok
        ? null
        : projects.value
            .filter((p) => p.workspace.toLowerCase() === workspace)
            .map((p) => p.slug)
            .sort(),
    ...found.value,
    workspace,
    viewer,
    member,
    labels: isFailed(labels) ? labels : labels.ok ? labels.value : [],
    milestones: isFailed(milestones) ? milestones : milestones.ok ? milestones.value : [],
    links,
    subscription,
    coordination: isFailed(coordination) ? coordination : coordination.ok ? coordination.value : null,
    sessionTrees,
    // Only when it can start: the button is not shown otherwise.
    agentSetup: agentSetup?.ok && agentSetup.value.available ? agentSetup.value : null,
    endedClaims: ended
      .flatMap((claims) => (claims?.ok ? claims.value : []))
      .sort((a, b) => Date.parse(b.endedAt ?? b.createdAt) - Date.parse(a.endedAt ?? a.createdAt)),
    members: members == null ? [] : isFailed(members) ? members : members.ok ? members.value.map((m) => m.username) : [],
    handles: teams?.ok ? teams.value.map((team) => `@${team.workspace}/${team.slug}`) : [],
    // The author can close and reopen their own work item, and whoever g1t's
    // agent filed one for, that one; Triage and up, anyone's.
    canManage: viewer != null && (viewer.id === workOwner(item).id || can.triage),
    // Maintain and up edit and delete anyone's comments; everyone, their own.
    canModerate: can.manage_settings,
    can,
  };
}

/** The repository a form names, by path, if it is one the item is linked to (or, to link, one of the workspace). */
function formRepo(form: FormData, workspace: string): { namespace: string; name: string } | null {
  return repoFilter(workspace, String(form.get("repo") ?? "").trim());
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const number = Number(params.number);
  const thread = { workspace, number };
  const form = await request.formData();
  const intent = String(form.get("action") ?? "");
  // Subscribing to it, from the sidebar's Notifications (components/notifications.tsx).
  const choice = subscriptionFromForm(form);
  if (choice) {
    const found = await work.getWorkItem(workspace, number, user);
    if (!found.ok) return data({ error: "That work item could not be found." }, { status: 404 });
    const subscription = await inbox.subscribe(user, { itemId: found.value.item.id, number }, choice.subscribed, choice.ignored).catch(() => null);
    return subscription ? { error: null, subscription } : data({ error: "That did not save. Try again in a moment." }, { status: 503 });
  }
  // Who may do each is checked by the work service, against the item's
  // workspace and origin; what it refuses says why.
  switch (intent) {
    case "open-pull": {
      const repo = formRepo(form, workspace);
      if (!repo) return { error: "Choose the repository to open it in.", action: intent };
      const result = await work.openPull(user, repo, { item: number, agent: String(form.get("agent") ?? ""), runtime: "external" });
      if (!result.ok) return { error: result.error.message, action: intent };
      throw redirect(`/${repo.namespace}/${repo.name}/pull/${result.value.number}`);
    }
    // A session on the workspace's Anthropic account, in one of its
    // repositories, which the integrations service checks the person may
    // start; then its page.
    case "start-session": {
      const repo = formRepo(form, workspace);
      if (!repo) return { error: "Link a repository for it to work in first.", action: intent };
      const mode = AGENT_MODES.find((one) => one.mode === form.get("mode"))?.mode ?? "implement";
      const instruction = String(form.get("instruction") ?? "").trim();
      const result = await agentSessions.start(user, repo, { item: number, mode, instruction: instruction || undefined, handoff: false }).catch(() => null);
      if (!result) return { error: "The session could not be started. Try again in a moment.", action: intent };
      if (!result.ok) return { error: result.error.message, action: intent };
      const started = result.value;
      const to = sitePath(started.sessionUrl, request.url) ?? (started.session ? sessionPath(repo.namespace, started.session.id) : null);
      if (!to) return { error: "No session was started.", action: intent };
      throw redirect(to);
    }
    case "comment": {
      const result = await work.addComment(user, thread, { body: String(form.get("body") ?? "") });
      return result.ok ? null : { error: result.error.message };
    }
    // A reaction to the item or one of its comments, or taking one back.
    case "react": {
      const content = REACTIONS.find((one) => one.content === form.get("content"))?.content;
      if (!content) return { error: "Pick a reaction.", action: intent };
      const result = await work.react(user, thread, {
        commentId: String(form.get("comment") ?? "") || undefined,
        content,
        remove: form.get("remove") === "1",
      });
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    case "assign": {
      const result = await work.updateWorkItem(user, workspace, number, {
        assignees: [...form.getAll("assignee").map(String), ...String(form.get("others") ?? "").split(/[\s,]+/)].filter(Boolean),
      });
      return result.ok ? null : { error: result.error.message };
    }
    case "labels": {
      const result = await work.setLabels(user, thread, form.getAll("label").map(String));
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    case "blocked-by": {
      const blockedBy = parseBlockedBy(String(form.get("blocked_by") ?? ""));
      if (!blockedBy) return { error: "List work item numbers, such as #12, #14.", action: intent };
      const result = await work.updateWorkItem(user, workspace, number, { blocked_by: blockedBy });
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    case "milestone": {
      const result = await work.updateWorkItem(user, workspace, number, { milestone: Number(form.get("milestone")) || 0 });
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    // Linking a repository in a role (a suggestion's Add as target is one), or unlinking one.
    case "link":
    case "unlink": {
      const repo = formRepo(form, workspace);
      if (!repo) return { error: "Choose a repository of the workspace.", action: "link" };
      const role = LINK_ROLES.find((one) => one === form.get("role")) ?? "target";
      const result =
        intent === "link" ? await work.linkWorkItem(user, workspace, number, repo, role) : await work.unlinkWorkItem(user, workspace, number, repo);
      return result.ok ? { linked: intent } : { error: result.error.message, action: "link" };
    }
    case "reopen": {
      const result = await work.reopenWorkItem(user, workspace, number);
      return result.ok ? null : { error: result.error.message };
    }
    // A comment's own text, changed or taken away: its author's to do, or
    // a maintainer's, which work checks.
    case "edit-comment":
    case "delete-comment": {
      const id = String(form.get("comment") ?? "");
      const result =
        intent === "edit-comment"
          ? await work.editComment(user, { workspace }, id, String(form.get("body") ?? ""))
          : await work.deleteComment(user, { workspace }, id);
      return result.ok ? null : { error: result.error.message, action: intent, comment: id };
    }
    case "close-completed":
    case "close-not-planned": {
      const result = await work.closeWorkItem(user, workspace, number, intent === "close-not-planned" ? "not_planned" : "completed");
      return result.ok ? null : { error: result.error.message };
    }
  }
  throw data(null, { status: 400 });
}

/** The path of a page of this site an address names, to redirect to; null for none or another site's. */
function sitePath(url: string | null | undefined, here: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, here);
    const own = parsed.origin === new URL(here).origin || parsed.hostname === "g1t.sh";
    return own ? parsed.pathname + parsed.search : null;
  } catch {
    return null;
  }
}

/** What became of a pull request, in a few words. */
function outcome(pull: { status: Pull["status"] } & Partial<Pick<Pull, "mergedBy" | "supersededBy">>): string {
  if (pull.status === "merged") return pull.mergedBy ? `Merged by ${pull.mergedBy}` : "Merged";
  if (pull.supersededBy != null) return `Closed · #${pull.supersededBy} was merged instead`;
  if (pull.status === "closed") return "Closed without merging";
  if (pull.status === "draft") return "Draft · in progress";
  return "Ready for review";
}

/** One of a repository's pull requests for the item, as a line under the repository. */
function RepoPullLine({ repo, pull, full }: { repo: string; pull: WorkPull; full?: Pull }) {
  const merged = pull.status === "merged";
  return (
    <li>
      <Link
        to={`/${repo}/pull/${pull.number}`}
        prefetch="intent"
        className={`flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-raised ${pull.status === "closed" ? "opacity-70" : ""}`}
      >
        <span className="mt-0.5">
          <PullIcon status={pull.status} size={15} />
        </span>
        <span className="min-w-0 grow">
          <span className="block text-sm font-medium wrap-break-word">
            {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className={merged ? "font-medium text-merged" : ""}>
              {outcome({ status: pull.status, mergedBy: full?.mergedBy, supersededBy: full?.supersededBy })}
            </span>
            <span>· {pull.author.username}</span>
            {full && <ChangeSize files={full.files} />}
            <CheckBadge status={pull.checkStatus} />
            {pull.queue && <span>· in the merge queue, {pull.queue.position === 1 ? "next" : `#${pull.queue.position}`}</span>}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * One repository the item is linked to: its path and role, whether what
 * closes the item has landed there (or, for a target, that it is still
 * missing), and its pull requests for it. With Triage, the cross unlinks
 * it (never its origin).
 */
function RepoCard({ repo, pulls, full, canLink }: { repo: ItemRepo; pulls: WorkPull[]; full: Map<string, Pull>; canLink: boolean }) {
  const missing = repo.role === "target" && !repo.landed;
  return (
    <li className="px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        {repo.path && repo.deleted ? (
          // Deleted, and restorable until it is purged: its name, nothing to open.
          <Hint label={`${repo.path} was deleted. It can be restored until it is purged.`}>
            <span className="min-w-0 truncate font-mono text-sm text-muted">
              {repo.path} <span className="font-sans text-xs text-faint">deleted</span>
            </span>
          </Hint>
        ) : repo.path ? (
          <Link to={`/${repo.path}`} className="min-w-0 truncate font-mono text-sm font-medium hover:text-accent">
            {repo.path}
          </Link>
        ) : (
          // Deleted before work items: nothing to link to, and no name kept.
          <span className="min-w-0 truncate text-sm text-muted">A deleted repository</span>
        )}
        <RoleBadge role={repo.role} />
        {repo.legacyNumber != null && (
          <Hint
            label={
              repo.path
                ? `It was ${repo.path}#${repo.legacyNumber} before work items, and that still leads here.`
                : `It was #${repo.legacyNumber} there before work items.`
            }
          >
            <span className="shrink-0 text-xs text-faint">was #{repo.legacyNumber}</span>
          </Hint>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {repo.landed ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-merged">
              <Check size={13} />
              Landed
            </span>
          ) : missing ? (
            <span className="inline-flex items-center gap-1 text-xs text-warn">
              <CircleDashed size={13} />
              Missing
            </span>
          ) : null}
          {canLink && repo.role !== "origin" && (
            <Form method="post">
              <input type="hidden" name="action" value="unlink" />
              <input type="hidden" name="repo" value={repo.path} />
              <Hint label={`Unlink ${repo.path}`}>
                <Button type="submit" variant="ghost" size="icon-xs" aria-label={`Unlink ${repo.path}`} className="max-sm:size-9">
                  <X size={14} />
                </Button>
              </Hint>
            </Form>
          )}
        </span>
      </div>
      {pulls.length > 0 ? (
        <ul className="mt-1.5 -mx-2 space-y-0.5">
          {pulls.map((pull) => (
            <RepoPullLine key={pull.number} repo={repo.path} pull={pull} full={full.get(`${repo.repoId}#${pull.number}`)} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-faint">{repo.role === "touched" ? "Touched by a commit." : "No pull request for it here yet."}</p>
      )}
    </li>
  );
}

/** Link a repository: one of the workspace's, in a role. A sheet from the bottom on a phone. */
function LinkRepository({
  workspace,
  repos,
  linked,
  error,
  wide = false,
}: {
  workspace: string;
  /** The workspace's repositories by name; null when they could not be read. */
  repos: string[] | null;
  linked: string[];
  error?: string | null;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(error));
  const choices = (repos ?? []).filter((name) => !linked.includes(`${workspace}/${name}`.toLowerCase()));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={wide ? "h-11 w-full" : undefined}>
          <Plus size={14} />
          Link a repository
        </Button>
      </DialogTrigger>
      <DialogContent>
        <Form method="post" className="grid gap-5" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="action" value="link" />
          <DialogHeader>
            <DialogTitle>Link a repository</DialogTitle>
            <DialogDescription>
              A target is where the work is meant to land: the item closes once every target has landed. Touched marks one it reached without having to land
              there.
            </DialogDescription>
          </DialogHeader>
          {repos == null ? (
            <Unavailable what="The workspace's repositories" compact />
          ) : (
            <SelectField
              name="repo"
              aria-label="Repository"
              defaultValue={choices[0] ?? ""}
              options={choices.length > 0 ? choices.map((name) => ({ value: name, label: name })) : [{ value: "", label: "No other repository to link" }]}
            />
          )}
          <SelectField
            name="role"
            aria-label="Role"
            defaultValue="target"
            options={(["target", "touched"] as LinkRole[]).map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
          />
          {error && <ErrorText>{error}</ErrorText>}
          <DialogFooter>
            <SubmitButton match={{ action: "link" }} pending="Linking…" className="max-sm:h-11">
              Link
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** A repository the work may also belong in, with why, and Add as target. */
function SuggestionLine({ suggestion, workspace, canLink }: { suggestion: SuggestedTarget; workspace: string; canLink: boolean }) {
  return (
    <li className="flex items-start gap-3 px-3 py-3 sm:px-4">
      <Lightbulb size={15} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 grow">
        <Link to={`/${suggestion.path}`} className="font-mono text-sm font-medium hover:text-accent">
          {shortPath(suggestion.path, workspace)}
        </Link>
        <span className="mt-0.5 block text-xs text-muted">{suggestion.why}</span>
      </span>
      {canLink && (
        <Form method="post" className="shrink-0">
          <input type="hidden" name="action" value="link" />
          <input type="hidden" name="repo" value={suggestion.path} />
          <input type="hidden" name="role" value="target" />
          <SubmitButton variant="outline" size="sm" match={{ action: "link", repo: suggestion.path }} pending="Adding…" className="max-sm:h-10">
            Add as target
          </SubmitButton>
        </Form>
      )}
    </li>
  );
}

export default function WorkItemPage({ loaderData, actionData }: Route.ComponentProps) {
  const { item, pulls, comments, viewer, labels, members, canManage, can, workspace } = loaderData;
  // Its Work, when it could be read; a failure says so in its places.
  const coordination = isFailed(loaderData.coordination) ? null : loaderData.coordination;
  const sessionTrees = isFailed(loaderData.sessionTrees) ? null : loaderData.sessionTrees;
  // What changes to it (comments, labels, links, its pull requests) shows as it happens.
  useWorkspaceLive({ workspace, member: loaderData.member, match: workPages.item(item.number), followBottom: true });
  // Follow pull requests at work without a manual reload.
  useRefreshWhile(pulls.some((pull) => pull.status === "draft" || pull.checkStatus === "queued" || pull.checkStatus === "running"));
  // Claims lapse and sessions go idle with no event to say so: looked at again now and then.
  useRefreshWhile((coordination?.claims.length ?? 0) > 0 || (coordination?.sessions.some((session) => session.state !== "ended") ?? false), 30_000);
  const now = Date.now();

  const open = item.state === "open";
  const reference = `${workspace}#${item.number}`;
  const canLink = can.triage;
  // Each repository with its pull requests for the item: from its work
  // context, else from the item's own pull requests.
  const bySlug = new Map(item.repos.map((repo) => [repo.repoId, repo.path]));
  const full = new Map(pulls.map((pull) => [`${pull.repoId}#${pull.number}`, pull]));
  const repoRows: { repo: ItemRepo; pulls: WorkPull[] }[] = coordination
    ? coordination.repos.map((repo: WorkRepo) => ({ repo, pulls: repo.pulls }))
    : item.repos.map((repo) => ({
        repo,
        pulls: pulls
          .filter((pull) => pull.repoId === repo.repoId)
          .map((pull) => ({
            repo: repo.path,
            number: pull.number,
            title: pull.title,
            status: pull.status,
            branch: pull.branch,
            headCommit: pull.headCommit,
            author: { id: pull.author.id, username: pull.author.username },
            checkStatus: pull.checkStatus,
            requiredChecks: [],
            mergeable: "unknown" as const,
            overlaps: [],
            queue: null,
          })),
      }));
  const missing = coordination?.missing ?? missingTargets(item.repos);
  const suggestions = (coordination?.suggestedTargets ?? []).filter((one) => !item.repos.some((repo) => repo.repoId === one.repoId));
  // Where each session's page is: under the repository it was recorded in.
  const sessionBase = (session: { repoId: string }) => `/${bySlug.get(session.repoId) ?? item.repos[0]?.path ?? workspace}`;
  // Its decisions as a story, oldest first; the failure that still stands, with what answered it.
  const decisions = coordination ? [...coordination.decisions].reverse() : [];
  const failure = coordination?.lastIntegrationFailure ?? null;
  const resolution = failure ? resolutionOf(coordination!.decisions, failure) : null;
  // A decision or the merge queue names a pull request by number: link it in the repository that has it, or not at all.
  const pullHref = pullHrefs(repoRows.map(({ repo, pulls: repoPulls }) => ({ path: repo.path, pulls: repoPulls })));
  const failureBase = `/${originOf(item.repos)?.path || workspace}`;
  // Where a pull request or a session would be opened: a target still missing, else where it was filed.
  // A deleted repository takes no pull request.
  const openable = item.repos.filter((repo) => repo.path && !repo.deleted);
  const workIn = missing[0] ?? item.repos.find((repo) => repo.role === "target")?.path ?? originOf(item.repos)?.path ?? null;
  const linkError = actionData && "action" in actionData && actionData.action === "link" ? actionData.error : null;
  const sideError = actionData && "action" in actionData && ["blocked-by", "start-session", "react", "link", "open-pull"].includes(String(actionData.action));

  return (
    // On a phone: the title, then the item, its repositories and the
    // conversation, then the sidebar as a Details disclosure; beside it
    // from lg up. Its main actions sit at the bottom, within a thumb's reach.
    <AttachImages to={viewer ? { workspace, number: item.number } : null}>
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[1fr_19rem] lg:grid-rows-[auto_1fr] lg:gap-y-0">
        <header className="min-w-0 lg:col-start-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance wrap-break-word sm:text-2xl">
            {item.title} <span className="font-normal text-faint">#{item.number}</span>
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
            <ItemState item={item} />
            <span className="flex min-w-0 items-center gap-2">
              <Avatar name={item.author.username} size={18} />
              <span className="min-w-0">
                <PersonLink name={item.author.username} className="font-medium text-fg hover:underline" /> opened this{" "}
                {item.requestedBy && (
                  <>
                    for <PersonLink name={item.requestedBy.username} className="font-medium text-fg-soft hover:underline" />{" "}
                  </>
                )}
                <TimeAgo at={item.createdAt} />
              </span>
            </span>
            {item.labels.map((name) => (
              // Without the workspace's labels, a chip still names its label, in the plain color.
              <LabelChip key={name} name={name} color={isFailed(labels) ? undefined : labels.find((label) => label.name === name)?.color} />
            ))}
            {open && item.agent && <Assignee agent={item.agent} />}
          </div>
        </header>

        <div className="min-w-0 max-lg:order-1 lg:col-start-1">
          {item.resolutions.length > 0 && (
            <ul className="space-y-2 lg:mt-5">
              {item.resolutions.map((landed, index) => (
                <li key={`${landed.repo}-${landed.pull ?? landed.commit ?? index}`}>
                  <Link
                    to={landed.pull != null ? `/${landed.repo}/pull/${landed.pull}` : `/${landed.repo}/commit/${landed.commit ?? ""}`}
                    className="flex items-start gap-3 rounded-xl border border-merged/40 bg-merged/5 px-4 py-3 text-sm transition-colors hover:border-merged/70"
                  >
                    {landed.pull != null ? (
                      <GitMerge size={18} className="mt-0.5 shrink-0 text-merged" />
                    ) : (
                      <GitCommitHorizontal size={18} className="mt-0.5 shrink-0 text-merged" />
                    )}
                    <span className="min-w-0">
                      Landed in <span className="font-mono font-medium">{landed.repo}</span> by{" "}
                      {landed.pull != null ? (
                        <span className="font-medium">#{landed.pull}</span>
                      ) : (
                        <span className="font-mono font-medium">{landed.commit?.slice(0, 7)}</span>
                      )}
                      {landed.pushedBy && <span className="text-muted">, pushed by {landed.pushedBy}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {item.body ? (
            <div className={`${item.resolutions.length > 0 ? "mt-5" : "lg:mt-5"} rounded-xl border border-line bg-surface p-4 sm:p-5`}>
              <Markdown source={item.body} workspace={workspace} />
              <Reactions reactions={loaderData.reactions} viewer={viewer?.username ?? null} className="mt-4" />
            </div>
          ) : (
            (loaderData.reactions?.length ?? 0) > 0 && <Reactions reactions={loaderData.reactions} viewer={viewer?.username ?? null} className="mt-3 lg:mt-5" />
          )}

          <section aria-labelledby="repositories" className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="repositories" className="font-semibold tracking-tight">
                Repositories
              </h2>
              <span className="flex items-center gap-3">
                {missing.length > 0 && open && (
                  <span className="text-sm text-muted">
                    {missing.length} {missing.length === 1 ? "target" : "targets"} still to land
                  </span>
                )}
                {canLink && (
                  <span className="max-sm:hidden">
                    <LinkRepository
                      workspace={workspace}
                      repos={loaderData.repos}
                      linked={item.repos.map((repo) => repo.path.toLowerCase())}
                      error={linkError}
                    />
                  </span>
                )}
              </span>
            </div>
            {isFailed(loaderData.coordination) && (
              <div className="mt-2">
                <Unavailable what="Each repository's pull requests" compact />
              </div>
            )}
            {repoRows.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="No repository yet">
                  Filed in the workspace itself. Link the repositories it should land in, and it closes once each of them has.
                </EmptyState>
              </div>
            ) : (
              <Card asChild divided className="mt-3">
                <ul>
                  {repoRows.map(({ repo, pulls: repoPulls }) => (
                    <RepoCard key={repo.repoId} repo={repo} pulls={repoPulls} full={full} canLink={canLink} />
                  ))}
                </ul>
              </Card>
            )}
            {suggestions.length > 0 && open && (
              <>
                <h3 className="mt-5 text-sm font-medium">Suggested</h3>
                <p className="mt-0.5 text-xs text-muted">Repositories it may also need, and why.</p>
                <Card asChild divided className="mt-2">
                  <ul>
                    {suggestions.map((suggestion) => (
                      <SuggestionLine key={suggestion.repoId} suggestion={suggestion} workspace={workspace} canLink={canLink} />
                    ))}
                  </ul>
                </Card>
              </>
            )}
            {linkError && (
              <div className="mt-2">
                <ErrorText>{linkError}</ErrorText>
              </div>
            )}
          </section>

          {pulls.length === 0 && open && (
            <div className="mt-6">
              <EmptyState title="Nobody has worked on this yet">
                Point your own agent at <code className="font-mono">{reference}</code>.
              </EmptyState>
            </div>
          )}

          {failure && (
            <IntegrationFailure className="mt-4" failure={failure} base={failureBase} pullHref={pullHref} fixed={resolution?.passed ?? resolution?.fix} />
          )}

          {isFailed(loaderData.coordination) ? (
            <>
              <h2 className="mt-10 font-semibold tracking-tight">Decisions</h2>
              <div className="mt-3">
                <Unavailable what="Its decisions" />
              </div>
            </>
          ) : (
            decisions.length > 0 && (
              <>
                <div className="mt-10 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="font-semibold tracking-tight">Decisions</h2>
                  <p className="text-sm text-muted">Why the work is the way it is, and how sure that is</p>
                </div>
                <div className="mt-3">
                  <DecisionList decisions={decisions} base={failureBase} pullHref={pullHref} />
                </div>
              </>
            )
          )}

          <h2 className="mt-10 font-semibold tracking-tight">Discussion</h2>
          <div className="mt-3">
            <div className="space-y-4">
              {isFailed(loaderData.sessionTrees) && <Unavailable what="Its sessions" compact />}
              <CommentList
                comments={comments}
                workspace={workspace}
                viewerId={viewer?.id ?? null}
                viewerName={viewer?.username ?? null}
                extra={(sessionTrees ?? [])
                  .filter((session) => !session.parentId)
                  .map((session) => ({ id: session.id, at: session.startedAt, node: <TimelineSession session={session} base={sessionBase(session)} /> }))}
                canModerate={loaderData.canModerate}
                failed={actionData && "comment" in actionData ? { comment: String(actionData.comment), error: actionData.error } : null}
              />
              <div id="comment">
                <CommentForm author={viewer?.username ?? null} resetKey={comments.length} handles={loaderData.handles} />
              </div>
              {canManage && (
                <Form method="post" className="flex flex-wrap justify-end gap-2 max-sm:hidden">
                  {open ? (
                    <>
                      <SubmitButton variant="outline" name="action" value="close-not-planned" pending="Closing…">
                        Close as not planned
                      </SubmitButton>
                      <SubmitButton variant="outline" name="action" value="close-completed" pending="Closing…">
                        Close work item
                      </SubmitButton>
                    </>
                  ) : (
                    <SubmitButton variant="outline" name="action" value="reopen" pending="Reopening…">
                      Reopen work item
                    </SubmitButton>
                  )}
                </Form>
              )}
            </div>
          </div>
          <div className="mt-2">
            {/* A refused comment edit says so under the comment; the sidebar's own say so there. */}
            {!(actionData && ("comment" in actionData || sideError)) && <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>}
          </div>

          {/* On a phone, its main actions at the bottom, above the tab bar and clear of the keyboard. */}
          {(canManage || canLink) && (
            <div className="sticky bottom-(--tabbar-h) z-10 -mx-4 mt-6 flex items-center gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur in-data-[keyboard=open]:hidden sm:hidden">
              {canLink && (
                <div className="min-w-0 grow">
                  <LinkRepository workspace={workspace} repos={loaderData.repos} linked={item.repos.map((repo) => repo.path.toLowerCase())} error={null} wide />
                </div>
              )}
              {canManage && (
                <Form method="post" className="min-w-0 grow *:h-11 *:w-full">
                  {open ? (
                    <SubmitButton variant="outline" name="action" value="close-completed" pending="Closing…">
                      Close
                    </SubmitButton>
                  ) : (
                    <SubmitButton variant="outline" name="action" value="reopen" pending="Reopening…">
                      Reopen
                    </SubmitButton>
                  )}
                </Form>
              )}
            </div>
          )}
        </div>

        <DetailsDisclosure
          className="max-lg:order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          summary={detailsSummary([
            [coordination?.claims.length ?? 0, "claim", "claims"],
            [item.assignees.length, "assignee", "assignees"],
            [item.labels.length, "label", "labels"],
            [item.milestone ? 1 : 0, "milestone", "milestones"],
          ])}
        >
          {isFailed(loaderData.coordination) ? (
            <section>
              <h3 className="text-sm font-medium">Work</h3>
              <div className="mt-2">
                <Unavailable what="Who is on it" compact />
              </div>
            </section>
          ) : (
            coordination && (
              <Boundary what="Work" fallback={<Unavailable what="Who is on it" compact />}>
                <ItemWorkPanel
                  work={coordination}
                  ended={loaderData.endedClaims}
                  base={sessionBase}
                  now={now}
                  canEdit={canManage}
                  error={actionData && "action" in actionData && actionData.action === "blocked-by" ? actionData.error : null}
                  sessions={sessionTrees}
                  start={
                    loaderData.agentSetup && open && workIn ? (
                      <StartSessionDialog
                        setup={loaderData.agentSetup}
                        repo={workIn}
                        error={actionData && "action" in actionData && actionData.action === "start-session" ? actionData.error : null}
                      />
                    ) : undefined
                  }
                />
              </Boundary>
            )
          )}
          {isFailed(loaderData.links) ? (
            <section>
              <h3 className="text-sm font-medium">From outside g1t</h3>
              <div className="mt-2">
                <Unavailable what="Its links" compact />
              </div>
            </section>
          ) : (
            loaderData.links.length > 0 && (
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
            )
          )}
          <section>
            <h3 className="text-sm font-medium">Assignees</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {item.assignees.map((name) => (
                <li key={name} className="flex items-center gap-2 px-1">
                  <Avatar name={name} size={20} agent={name === "g1t"} />
                  <span className="grow truncate font-mono text-xs">{name === "g1t" ? "g1t" : <PersonLink name={name} className="hover:underline" />}</span>
                </li>
              ))}
              {item.assignees.length === 0 && <li className="px-1 text-xs text-faint">Nobody yet</li>}
            </ul>
            {!coordination && item.blockedBy.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                Depends on{" "}
                {item.blockedBy.map((number, index) => (
                  <span key={number}>
                    {index > 0 && ", "}
                    <Link to={itemPath(workspace, number)} className="font-medium text-fg hover:underline">
                      #{number}
                    </Link>
                  </span>
                ))}
                {open ? ", which has to land first." : "."}
              </p>
            )}
            {viewer && can.triage && open && (
              <div className="mt-3 space-y-2">
                {/* g1t takes it on in a session on the workspace's Claude, as whoever assigned it. */}
                {loaderData.agentSetup && !item.assignees.includes("g1t") && (
                  <Form method="post">
                    <input type="hidden" name="action" value="assign" />
                    {item.assignees.map((name) => (
                      <input key={name} type="hidden" name="assignee" value={name} />
                    ))}
                    <input type="hidden" name="assignee" value="g1t" />
                    <div className="*:w-full">
                      <SubmitButton variant="outline" name="who" value="g1t" pending="Assigning…">
                        <Bot size={14} />
                        Assign to g1t
                      </SubmitButton>
                    </div>
                  </Form>
                )}
                {!item.assignees.includes(viewer.username) && (
                  <Form method="post">
                    <input type="hidden" name="action" value="assign" />
                    {item.assignees.map((name) => (
                      <input key={name} type="hidden" name="assignee" value={name} />
                    ))}
                    <input type="hidden" name="assignee" value={viewer.username} />
                    <div className="*:w-full">
                      <SubmitButton variant="outline" name="who" value="self" pending="Assigning…">
                        Assign yourself
                      </SubmitButton>
                    </div>
                  </Form>
                )}
                <details className="group">
                  <summary className="cursor-pointer text-xs text-faint hover:text-fg">Assign people</summary>
                  <Form method="post" className="mt-2 space-y-2" key={item.assignees.join()}>
                    <input type="hidden" name="action" value="assign" />
                    {/* Without the workspace's people the picker still holds who is
                        assigned now, so saving never clears them. */}
                    {isFailed(members) && <Unavailable what="The workspace's people" compact />}
                    <PeoplePicker name="assignee" members={isFailed(members) ? [] : members} chosen={item.assignees} />
                    <SubmitButton variant="outline" name="who" value="picked" pending="Saving…">
                      Save assignees
                    </SubmitButton>
                  </Form>
                </details>
              </div>
            )}
          </section>

          {/* Another way to start the work: not once a pull request is doing it. */}
          {open && !pulls.some((pull) => pull.status === "open" || pull.status === "draft") && (
            <Card asChild className="p-4">
              <section>
                <h3 className="text-sm font-medium">Bring your own agent</h3>
                <p className="mt-1 text-xs text-muted">With g1t connected to your agent, ask it to work on this work item.</p>
                <div className="mt-3">
                  <CopyLine text={reference} />
                </div>
                {viewer && openable.length > 0 ? (
                  <Form method="post" className="mt-4 space-y-2 border-t border-line pt-4">
                    <input type="hidden" name="action" value="open-pull" />
                    <p className="text-xs text-muted">Or open a draft pull request yourself and get a fork to push to.</p>
                    <SelectField
                      name="repo"
                      aria-label="Repository"
                      defaultValue={openable.some((repo) => repo.path === workIn) ? workIn! : openable[0]!.path}
                      options={openable.map((repo) => ({ value: repo.path, label: `${repo.path} (${ROLE_LABELS[repo.role].toLowerCase()})` }))}
                    />
                    <Input name="agent" placeholder="Who is working, e.g. claude-code" maxLength={60} />
                    <div className="*:w-full">
                      <SubmitButton match={{ action: "open-pull" }} pending="Opening…">
                        Open pull request
                      </SubmitButton>
                    </div>
                    {actionData && "action" in actionData && actionData.action === "open-pull" && <ErrorText>{actionData.error}</ErrorText>}
                    {workIn && (
                      <p className="text-xs text-muted">
                        Already pushed a branch?{" "}
                        <Link to={`/${workIn}/pulls/new?item=${item.number}`} className="text-fg underline underline-offset-4">
                          Open a pull request from it
                        </Link>
                        .
                      </p>
                    )}
                  </Form>
                ) : (
                  !viewer && (
                    <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
                      <Link to="/login" className="text-fg underline underline-offset-4">
                        Sign in
                      </Link>{" "}
                      to open a pull request.
                    </p>
                  )
                )}
              </section>
            </Card>
          )}

          {isFailed(labels) ? (
            <SideUnavailable heading="Labels" what="Labels" />
          ) : (
            <LabelsBox
              labels={labels}
              chosen={item.labels}
              canEdit={canManage}
              canCreate={can.manage_labels}
              manageUrl={can.manage_labels ? workPath(workspace, "labels") : undefined}
            />
          )}
          {isFailed(loaderData.milestones) ? (
            <SideUnavailable heading="Milestone" what="Milestones" />
          ) : (
            <MilestoneBox milestones={loaderData.milestones} current={item.milestone} canEdit={can.triage} base={workPath(workspace)} />
          )}
          {viewer &&
            (isFailed(loaderData.subscription) ? (
              <SideUnavailable heading="Notifications" what="Your notification settings" />
            ) : (
              <SubscriptionBox action={itemPath(workspace, item.number)} number={item.number} kind="item" subscription={loaderData.subscription} />
            ))}
        </DetailsDisclosure>
      </div>
    </AttachImages>
  );
}

/** A sidebar section, under its usual heading, that could not be loaded. */
function SideUnavailable({ heading, what }: { heading: string; what: string }) {
  return (
    <section>
      <h3 className="text-sm font-medium">{heading}</h3>
      <div className="mt-2">
        <Unavailable what={what} compact />
      </div>
    </section>
  );
}
