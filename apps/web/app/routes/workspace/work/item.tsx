import { ChevronDown, ExternalLink, MessagesSquare, FolderKanban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, data, redirect, useFetcher, useLocation, useNavigate } from "react-router";

import { AGENT_MODES, type ItemRepo, PROVIDERS, REACTIONS, type WorkPull, type WorkRepo, missingTargets, workOwner } from "@g1t/contracts";

import type { Route } from "./+types/item";
import { excerpt, page } from "../../../lib/meta";
import { ErrorText, TimeAgo } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { PersonLink, ItemState } from "../../../components/work";
import { AttachImages } from "../../../components/attach-images";
import { inTextField } from "../../../components/command-palette";
import { ActivityStream, DecisionsFold, activityLine } from "../../../components/item-activity";
import { ItemCrumbs, ItemBody, ItemMenu, ItemStepper, ItemTitle, OpenPullDialog, StartAgentButton, type EditFetcher } from "../../../components/item-header";
import {
  AgentProperty,
  AssigneeProperty,
  BlockedByProperty,
  CycleProperty,
  LabelsProperty,
  MilestoneProperty,
  ParentPicker,
  PlanProperty,
  ProjectProperty,
  PropertyRow,
  ReposProperty,
  StageProperty,
} from "../../../components/item-properties";
import { ItemWorkSection } from "../../../components/item-work";
import { SubscriptionBox } from "../../../components/notifications";
import { CloseDialog, SubItemsSection } from "../../../components/sub-items";
import { Unavailable } from "../../../components/boundary";
import { blockerDetail } from "../../../components/coordination";
import { subscriptionFromForm } from "../../../lib/inbox";
import { notFound } from "../../../lib/not-found.server";
import { taskCheckOf } from "../../../lib/task-check";
import { agentSessions, identity, inbox, integrations, repos, work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../../lib/session.server";
import { useRefreshWhile } from "../../../lib/refresh";
import { isFailed, part } from "../../../lib/partial";
import { feedLine, harnessName, mergeSessions, parseBlockedBy, pullHrefs, resolutionOf } from "../../../lib/coordination";
import { cn } from "../../../lib/cn";
import { planInput } from "../../../lib/plan";
import { projectPath } from "../../../lib/projects";
import { refPath } from "../../../lib/refs.server";
import { itemAbilities } from "../../../lib/work-access";
import { type ItemCommand, type WorkTrail, itemCommandOf, itemStage, neighbours, trailOf, trailState } from "../../../lib/work-item-page";
import {
  LINK_ROLES,
  closeSubItemsOf,
  itemNumberOf,
  itemPath,
  newItemPath,
  originOf,
  repoFilter,
  sessionPath,
  sessionsPath,
  shortPath,
  workPath,
} from "../../../lib/work-items";
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
  const [found, labels, milestones, members, teams, coordination, ended, agentSetup, workProjects, cycles] = await Promise.all([
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
    // The projects it can be put in, and the one it is in.
    part(work.listProjects(workspace, viewer), "Projects"),
    // The current and coming cycles, while the workspace has cycles on.
    part(work.listCycles(workspace, viewer, 0), "Cycles"),
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
  const [originRepo, links, subscription, sessionTrees, progress] = await Promise.all([
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
    // How it stands while it is in Now, as the plan reads it, for the sidebar's Plan: it does without when it cannot be read.
    item.horizon === "now" && item.state === "open"
      ? work
          .getPlan(workspace, viewer)
          .then((plan) => (plan.ok ? (plan.value.progress.find((one) => one.number === number) ?? null) : null))
          .catch(() => null)
      : null,
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
    projects: isFailed(workProjects) ? workProjects : workProjects.ok ? workProjects.value : [],
    // Off (or not readable as a refusal): no Cycle row, as before cycles.
    cycles: isFailed(cycles) ? cycles : cycles.ok && cycles.value.current ? { current: cycles.value.current, next: cycles.value.next ?? null } : null,
    today: new Date().toISOString().slice(0, 10),
    links,
    subscription,
    coordination: isFailed(coordination) ? coordination : coordination.ok ? coordination.value : null,
    sessionTrees,
    progress,
    // Only when it can start: assigning to g1t is not offered otherwise.
    agentSetup: agentSetup?.ok && agentSetup.value.available ? agentSetup.value : null,
    // Starting an agent is offered to every member: on the workspace's account when it is set up, else on their own machine.
    agentSetupInfo: agentSetup?.ok ? agentSetup.value : null,
    // An owner is pointed to where hosted sessions are set up.
    owner: roleIn(viewer, workspace) === "owner",
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
      // On the person's own machine: the Claude Code command to run, and nothing started here.
      const handoff = form.get("where") === "local";
      const result = await agentSessions.start(user, repo, { item: number, mode, instruction: instruction || undefined, handoff }).catch(() => null);
      if (!result)
        return {
          error: handoff ? "The command could not be made. Try again in a moment." : "The session could not be started. Try again in a moment.",
          action: intent,
        };
      if (!result.ok) return { error: result.error.message, action: intent };
      const started = result.value;
      if (handoff)
        return result.value.command
          ? { action: intent, command: result.value.command }
          : { error: "No command came back. Try again in a moment.", action: intent };
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
    // A box of its body's task list, ticked or not (components/markdown.tsx).
    case "check-task": {
      const result = await work.checkWorkItemTask(user, workspace, number, taskCheckOf(form));
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
    // What it is a sub-item of, from the Work panel: empty takes it out.
    case "parent": {
      const parent = itemNumberOf(String(form.get("parent") ?? ""));
      if (parent === undefined) return { error: "Give a work item number, such as #212, or leave it empty for none.", action: intent };
      const result = await work.setWorkItemParent(user, workspace, number, parent);
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    // Its sub-items: one added by number, or taken out (only while this is still its parent).
    case "add-sub-item":
    case "remove-sub-item": {
      const sub = itemNumberOf(String(form.get("sub_item") ?? ""));
      if (!sub) return { error: "Give the work item's number, such as #230.", action: "sub-items" };
      const result =
        intent === "add-sub-item"
          ? await work.setWorkItemParent(user, workspace, sub, number)
          : await work.setWorkItemParent(user, workspace, sub, null, number);
      return result.ok ? null : { error: result.error.message, action: "sub-items" };
    }
    case "milestone": {
      const result = await work.updateWorkItem(user, workspace, number, { milestone: Number(form.get("milestone")) || 0 });
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    // The project it is in, from the sidebar's Project (components/projects.tsx): a slug, or "" for none.
    case "project": {
      const result = await work.updateWorkItem(user, workspace, number, { project: String(form.get("project") ?? "").trim() });
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    // Its cycle, from the panel's Cycle (Y) or Shift Y: current, next or none.
    case "cycle": {
      const choice = form.get("cycle");
      if (choice !== "current" && choice !== "next" && choice !== "none") return { error: "Choose a cycle.", action: intent };
      const result = await work.cycleWorkItem(user, workspace, number, choice);
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    // Its place in the plan, from the sidebar's Plan (components/plan-box.tsx).
    case "plan": {
      const input = planInput(form);
      if (typeof input === "string") return { error: input, action: intent };
      const result = await work.planWorkItem(user, workspace, number, input);
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
    // Its title and description, edited in place (E).
    case "edit": {
      const title = String(form.get("title") ?? "").trim();
      if (!title) return { error: "Give it a title.", action: intent };
      const result = await work.updateWorkItem(user, workspace, number, { title, body: String(form.get("body") ?? "") });
      return result.ok ? { edited: true } : { error: result.error.message, action: intent };
    }
    // Claiming it from the site (I), with no harness: it lapses unless renewed; releasing or handing off your claim.
    case "claim": {
      const result = await work.claimWorkItem(user, workspace, number);
      return result.ok ? { claimed: true } : { error: result.error.message, action: intent };
    }
    case "release": {
      const result = await work.releaseClaim(user, workspace, number);
      return result.ok ? null : { error: result.error.message, action: intent };
    }
    case "handoff": {
      const note = String(form.get("note") ?? "").trim();
      if (!note) return { error: "Say where the work stands, for whoever picks it up.", action: intent };
      const to = String(form.get("to") ?? "")
        .trim()
        .replace(/^@/, "");
      const result = await work.handOffWorkItem(user, workspace, number, note, to || undefined);
      return result.ok ? { handedOff: true } : { error: result.error.message, action: intent };
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
      // With open sub-items, what becomes of them, as the close dialog says (components/sub-items.tsx).
      const subItems = closeSubItemsOf(form);
      if (typeof subItems === "string") return { error: subItems, action: "close", reason: intent };
      const result = await work.closeWorkItem(
        user,
        workspace,
        number,
        intent === "close-not-planned" ? "not_planned" : "completed",
        undefined,
        subItems ?? undefined,
      );
      if (result.ok) return null;
      // Refused for open sub-items nobody said what to do with, or for that choice: the dialog says why, with the choices.
      if (subItems || result.error.code === "conflict") return { error: result.error.message, action: "close", reason: intent };
      return { error: result.error.message };
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

/**
 * The page's keys (lib/work-item-page.ts): never while typing in a field,
 * nor while a dialog, a menu or a picker is open, which take their own.
 */
function useItemKeys(run: (command: ItemCommand) => boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      const command = itemCommandOf(event, inTextField(event.target));
      if (command && run(command)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);
}

/**
 * The list J and K step through: the one the page was opened from, else
 * the plan's order (Now, then Next) while it is in either, read once the
 * page is open.
 */
function useTrail(workspace: string, number: number, inPlan: boolean): WorkTrail | null {
  const location = useLocation();
  const opened = trailOf(location.state);
  const plan = useFetcher<{ plan: number[] | null }>();
  useEffect(() => {
    if (!opened && inPlan && plan.state === "idle" && !plan.data) plan.load(`${workPath(workspace, "items.json")}?plan=1`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per work item
  }, [opened == null, inPlan, workspace, number]);
  if (opened) return opened;
  const numbers = plan.data?.plan;
  return numbers && numbers.includes(number) ? { numbers, label: "Plan", href: workPath(workspace) } : null;
}

export default function WorkItemPage({ loaderData, actionData }: Route.ComponentProps) {
  const { item, pulls, comments, viewer, labels, members, canManage, can, workspace } = loaderData;
  // Its Work, when it could be read; a failure says so in its places.
  const coordination = isFailed(loaderData.coordination) ? null : loaderData.coordination;
  const sessionTrees = isFailed(loaderData.sessionTrees) ? null : loaderData.sessionTrees;
  // What changes to it (comments, labels, links, its pull requests) shows as it happens.
  useWorkspaceLive({ workspace, member: loaderData.member, match: workPages.item(item.number), followBottom: true });
  // Follow pull requests at work without a manual reload: their checks
  // every 10 s while they run; a draft, which can sit for days, each minute.
  const checksGoing = pulls.some((pull) => pull.checkStatus === "queued" || pull.checkStatus === "running");
  useRefreshWhile(checksGoing || pulls.some((pull) => pull.status === "draft"), checksGoing ? 10_000 : 60_000);
  // Claims lapse and sessions go idle (after 15 minutes) with no event to say so: looked at again each minute.
  useRefreshWhile((coordination?.claims.length ?? 0) > 0 || (coordination?.sessions.some((session) => session.state !== "ended") ?? false), 60_000);
  const now = Date.now();
  const navigate = useNavigate();

  const open = item.state === "open";
  const reference = `${workspace}#${item.number}`;
  const canLink = can.triage;
  // Each repository with its pull requests for the item: from its work
  // context, else from the item's own pull requests.
  const bySlug = new Map(item.repos.map((repo) => [repo.repoId, repo.path]));
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
  // Its sessions with their subagents, each once.
  const sessions = mergeSessions(coordination?.sessions, sessionTrees);
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
  const errorFor = (action: string) => (actionData && "action" in actionData && actionData.action === action ? actionData.error : null);
  // Closing refused for its open sub-items: the close dialog it came from says why, with the choices.
  const closeError =
    actionData && "reason" in actionData && (actionData.reason === "close-completed" || actionData.reason === "close-not-planned") ? actionData.error : null;
  const subItems = loaderData.subItems ?? [];
  const progress = item.subItemProgress ?? null;
  const openSubItems = progress ? progress.total - progress.done : subItems.filter((sub) => sub.state === "open").length;
  // A new sub-item is filed under it, from the repository it was filed from when that is the workspace's.
  const filedFrom = originOf(item.repos);
  const originName = filedFrom?.path && !filedFrom.deleted ? shortPath(filedFrom.path, workspace) : null;
  const newSubItem = newItemPath(workspace, originName && !originName.includes("/") ? originName : null, item.number);
  const stage = itemStage(
    item,
    { repos: repoRows.map(({ repo, pulls: repoPulls }) => ({ path: repo.path, pulls: repoPulls })), claims: coordination?.claims, sessions },
    now,
  );
  const memberNames = isFailed(members) ? null : members;
  const mine = viewer ? (coordination?.claims ?? []).some((claim) => claim.actor.id === viewer.id) : false;
  const canStart = loaderData.member && open && workIn != null;
  const canClaim = viewer != null && loaderData.member && open;
  const live = sessions
    .filter((session) => session.state !== "ended" && !session.parentId)
    .map((session) => ({
      id: session.id,
      who: session.harness === "claude_managed_agents" ? "g1t" : session.actor.username,
      harness: session.harness === "claude_managed_agents" ? null : harnessName(session.harness),
      state: session.state as "active" | "idle",
      href: sessionPath(workspace, session.id),
    }));
  const lines = (coordination?.recent ?? []).flatMap((event) => {
    const line = feedLine(event);
    return line && activityLine(line) ? [line] : [];
  });

  // What is open: a property's picker, editing, a dialog.
  const [picker, setPicker] = useState<ItemCommand | "repos" | null>(null);
  const [editing, setEditing] = useState(false);
  const startAsked = Boolean(errorFor("start-session") || (actionData && "command" in actionData));
  const [starting, setStarting] = useState(startAsked);
  useEffect(() => {
    if (startAsked) setStarting(true);
  }, [startAsked, actionData]);
  const [closing, setClosing] = useState(Boolean(closeError));
  useEffect(() => {
    if (closeError) setClosing(true);
  }, [closeError]);
  const [moving, setMoving] = useState(false);
  const [openingPull, setOpeningPull] = useState(Boolean(errorFor("open-pull")));
  // On a phone, the properties fold under the title until opened.
  const [panelOpen, setPanelOpen] = useState(false);
  const edit: EditFetcher = useFetcher();
  const claim = useFetcher<{ error?: string } | null>();
  // Shift Y: shares the Cycle row's fetcher, so the row shows the move at once.
  const cycleMove = useFetcher<{ error?: string } | null>({ key: "item-cycle" });
  const cyclesOn = loaderData.cycles != null && !isFailed(loaderData.cycles);
  const toggle = (command: ItemCommand | "repos") => ({
    open: picker === command,
    onOpenChange: (next: boolean) => setPicker(next ? command : null),
  });

  const trail = useTrail(workspace, item.number, open && (item.horizon === "now" || item.horizon === "next"));
  const at = trail ? neighbours(trail.numbers, item.number) : null;
  const stepState = trailState(trail);
  const go = (number: number | null) => number != null && navigate(itemPath(workspace, number), { state: stepState });

  const run = useCallback(
    (command: ItemCommand): boolean => {
      const pick = (allowed: boolean) => {
        if (!allowed) return false;
        setPanelOpen(true);
        setPicker(command);
        return true;
      };
      switch (command) {
        case "edit":
          if (!canManage) return false;
          setEditing(true);
          return true;
        case "assignee":
          return pick(viewer != null && can.triage && open);
        case "project":
        case "milestone":
          return pick(can.triage);
        case "cycle":
          return pick(cyclesOn && open);
        case "cycle-next":
          if (!cyclesOn || !open || !can.manage_labels || isFailed(loaderData.cycles) || !loaderData.cycles?.next) return false;
          if (item.cycle === loaderData.cycles.next.number) return true;
          cycleMove.submit({ action: "cycle", cycle: "next" }, { method: "post" });
          return true;
        case "plan":
          return pick(can.triage && open);
        case "labels":
        case "blocked":
          return pick(canManage);
        case "agent":
          if (!canStart) return false;
          setStarting(true);
          return true;
        case "claim":
          if (!canClaim) return false;
          claim.submit({ action: "claim" }, { method: "post" });
          return true;
        case "close":
          if (!canManage || !open) return false;
          setClosing(true);
          return true;
        case "next":
          if (!at?.next) return false;
          go(at.next);
          return true;
        case "previous":
          if (!at?.previous) return false;
          go(at.previous);
          return true;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- what the page allows, and where J and K go
    [canManage, can.triage, can.manage_labels, open, viewer, canStart, canClaim, at?.next, at?.previous, item.number, item.cycle, cyclesOn],
  );
  useItemKeys(run);

  const blockers = coordination
    ? coordination.blockedBy.map((one) => ({ number: one.number, title: one.title, state: one.state, detail: blockerDetail(one) }))
    : item.blockedBy.map((number) => ({ number, title: `Work item #${number}`, state: "open" as const }));
  const summary = [stage.label, item.assignees.length > 0 ? item.assignees.join(", ") : null, item.project?.name ?? null].filter(Boolean).join(" · ");
  const claimError = claim.state === "idle" ? (claim.data?.error ?? null) : null;

  return (
    <AttachImages to={viewer ? { workspace, number: item.number } : null}>
      {/* Where it is, the list it came from, and what can be done to it. */}
      <div className="relative mb-5 flex min-h-9 items-center gap-2">
        <ItemCrumbs workspace={workspace} number={item.number} project={item.project} parent={loaderData.parent ?? null} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {at && (
            <ItemStepper
              at={at}
              label={trail!.label}
              href={trail!.href}
              previous={at.previous ? itemPath(workspace, at.previous) : null}
              next={at.next ? itemPath(workspace, at.next) : null}
              state={stepState}
            />
          )}
          {canStart && (
            <StartAgentButton
              setup={loaderData.agentSetupInfo}
              repo={workIn!}
              error={errorFor("start-session")}
              command={actionData && "command" in actionData ? actionData.command : null}
              setupHref={loaderData.owner ? `/${workspace}/-/ai` : null}
              open={starting}
              onOpenChange={setStarting}
              reference={reference}
              onOpenPull={
                viewer && openable.length > 0 && !pulls.some((pull) => pull.status === "open" || pull.status === "draft")
                  ? () => setOpeningPull(true)
                  : undefined
              }
              branchHref={workIn ? `/${workIn}/pulls/new?item=${item.number}` : null}
            />
          )}
          {viewer && (
            <ItemMenu
              open={open}
              canClaim={canClaim}
              claimed={mine}
              canManage={canManage}
              canMove={canManage}
              parent={item.parent ?? null}
              members={memberNames ?? []}
              onClaim={() => claim.submit({ action: "claim" }, { method: "post" })}
              onClose={() => setClosing(true)}
              onMove={() => setMoving(true)}
              claimError={claimError}
            />
          )}
          {canManage && (
            <ParentPicker
              workspace={workspace}
              number={item.number}
              parent={loaderData.parent ?? (item.parent ? { number: item.parent } : null)}
              open={moving}
              onOpenChange={setMoving}
            />
          )}
        </div>
      </div>
      {claimError && (
        <div className="-mt-3 mb-4">
          <ErrorText>{claimError}</ErrorText>
        </div>
      )}

      {/* On a phone: the title, the properties folded under it, then the rest. From lg up, the properties sit at the right. */}
      <div className="grid gap-y-5 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-12 lg:gap-y-0">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <ItemTitle
            fetcher={edit}
            title={item.title}
            body={item.body}
            canEdit={canManage}
            editing={editing}
            onEditingChange={setEditing}
            handles={loaderData.handles}
            aside={
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
                <ItemState item={item} />
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={item.author.username} size={18} agent={item.author.kind === "agent"} />
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
                <span className="font-mono text-xs text-faint">#{item.number}</span>
              </div>
            }
          />
        </div>

        <aside aria-label="Properties" className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <button
            type="button"
            aria-expanded={panelOpen}
            aria-controls="item-properties"
            onClick={() => setPanelOpen(!panelOpen)}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-left text-sm transition-colors hover:border-line-strong lg:hidden"
          >
            <span className="shrink-0 font-medium">Properties</span>
            <span className="min-w-0 grow truncate text-muted">{summary}</span>
            <ChevronDown size={15} className={cn("ml-auto shrink-0 text-faint transition-transform", panelOpen && "rotate-180")} />
          </button>
          <div
            id="item-properties"
            className={cn(
              panelOpen ? "mt-3 block rounded-xl border border-line bg-surface p-3" : "hidden",
              "space-y-1 lg:sticky lg:top-[calc(var(--topbar-h)+1.25rem)] lg:mt-0 lg:block lg:rounded-none lg:border-0 lg:border-l lg:bg-transparent lg:p-0 lg:pl-5",
            )}
          >
            <StageProperty stage={stage} />
            <AssigneeProperty
              assignees={item.assignees}
              members={memberNames}
              viewer={viewer?.username ?? null}
              canEdit={viewer != null && can.triage && open}
              canAssignG1t={loaderData.agentSetup != null}
              {...toggle("assignee")}
            />
            <AgentProperty live={live} agent={open ? item.agent : null} onStart={canStart ? () => setStarting(true) : undefined} />
            {isFailed(loaderData.projects) ? (
              <SideUnavailable label="Project" what="Projects" />
            ) : (
              <ProjectProperty projects={loaderData.projects} current={item.project} canEdit={can.triage} workspace={workspace} {...toggle("project")} />
            )}
            {isFailed(loaderData.cycles) ? (
              <SideUnavailable label="Cycle" what="Cycles" />
            ) : (
              loaderData.cycles && (
                <CycleProperty
                  item={item}
                  cycles={loaderData.cycles}
                  canEdit={can.manage_labels}
                  workspace={workspace}
                  today={loaderData.today}
                  {...toggle("cycle")}
                />
              )
            )}
            <PlanProperty
              item={item}
              workspace={workspace}
              canEdit={can.triage}
              canNow={can.manage_labels}
              progress={loaderData.progress}
              {...toggle("plan")}
            />
            {isFailed(loaderData.milestones) ? (
              <SideUnavailable label="Milestone" what="Milestones" />
            ) : (
              <MilestoneProperty
                milestones={loaderData.milestones}
                current={item.milestone}
                canEdit={can.triage}
                workspace={workspace}
                {...toggle("milestone")}
              />
            )}
            <LabelsProperty
              labels={isFailed(labels) ? null : labels}
              chosen={item.labels}
              canEdit={canManage}
              canCreate={can.manage_labels}
              manageUrl={can.manage_labels ? workPath(workspace, "labels") : undefined}
              {...toggle("labels")}
            />
            {isFailed(loaderData.coordination) && <SideUnavailable label="Blocked by" what="Where what it waits on stands" />}
            <BlockedByProperty
              workspace={workspace}
              number={item.number}
              blockedBy={item.blockedBy}
              blockers={blockers}
              blocks={coordination?.blocks ?? []}
              itemOpen={open}
              canEdit={canManage}
              {...toggle("blocked")}
            />
            <ReposProperty workspace={workspace} repos={item.repos} choices={loaderData.repos} canEdit={canLink} {...toggle("repos")} />

            <div className="space-y-4 border-t border-line pt-4 lg:mt-4">
              <PropertyRow label="Links">
                <ul className="space-y-1 px-2 py-1 text-sm">
                  <li>
                    <Link
                      to={sessionsPath(workspace, { state: "recent", item: String(item.number) })}
                      className="inline-flex items-center gap-1.5 text-fg-soft hover:text-accent"
                    >
                      <MessagesSquare size={14} className="shrink-0 text-faint" />
                      Sessions in Chat
                    </Link>
                  </li>
                  {item.project && (
                    <li>
                      <Link to={projectPath(workspace, item.project.slug)} className="inline-flex items-center gap-1.5 text-fg-soft hover:text-accent">
                        <FolderKanban size={14} className="shrink-0 text-faint" />
                        {item.project.name}
                      </Link>
                    </li>
                  )}
                  {!isFailed(loaderData.links) &&
                    loaderData.links.map((link) => (
                      <li key={`${link.connectionId}-${link.key}`}>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          className="group inline-flex min-w-0 max-w-full items-center gap-1.5 text-fg-soft hover:text-accent"
                        >
                          <ExternalLink size={14} className="shrink-0 text-faint group-hover:text-accent" />
                          <span className="truncate">
                            {PROVIDERS[link.provider].label} <span className="font-mono text-muted">{link.key}</span>
                          </span>
                        </a>
                        <span className="block pl-5 text-xs text-faint">
                          {link.count > 1 ? `Seen ${link.count} times, last ` : "Linked "}
                          <TimeAgo at={link.count > 1 ? link.lastSeen : link.firstSeen} />
                        </span>
                      </li>
                    ))}
                </ul>
                {isFailed(loaderData.links) && (
                  <div className="px-2">
                    <Unavailable what="Its links from outside g1t" compact />
                  </div>
                )}
              </PropertyRow>
              {viewer &&
                (isFailed(loaderData.subscription) ? (
                  <SideUnavailable label="Notifications" what="Your notification settings" />
                ) : (
                  <SubscriptionBox action={itemPath(workspace, item.number)} number={item.number} kind="item" subscription={loaderData.subscription} />
                ))}
            </div>
          </div>
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <div className="mt-5 lg:mt-6">
            <ItemBody
              fetcher={edit}
              workspace={workspace}
              title={item.title}
              body={item.body}
              reactions={loaderData.reactions}
              viewer={viewer?.username ?? null}
              canEdit={canManage}
              editing={editing}
              onEdit={() => setEditing(true)}
            />
          </div>

          {(subItems.length > 0 || (progress?.total ?? 0) > 0 || (canManage && open)) && (
            <SubItemsSection
              workspace={workspace}
              subItems={subItems}
              progress={progress}
              canEdit={canManage}
              newPath={newSubItem}
              error={errorFor("sub-items")}
            />
          )}

          <ItemWorkSection
            workspace={workspace}
            number={item.number}
            open={open}
            repoRows={repoRows}
            pulls={pulls}
            resolutions={item.resolutions}
            missing={missing}
            suggestions={suggestions}
            canLink={canLink}
            workFailed={isFailed(loaderData.coordination)}
            claims={coordination?.claims ?? []}
            ended={loaderData.endedClaims}
            now={now}
            sessions={sessions}
            sessionsFailed={isFailed(loaderData.sessionTrees)}
            base={sessionBase}
            failure={failure}
            fixed={resolution?.passed ?? resolution?.fix}
            failureBase={failureBase}
            pullHref={pullHref}
          />
          {errorFor("link") && (
            <div className="mt-2">
              <ErrorText>{errorFor("link")}</ErrorText>
            </div>
          )}

          <DecisionsFold decisions={decisions} failed={isFailed(loaderData.coordination)} base={failureBase} pullHref={pullHref} />

          <ActivityStream
            workspace={workspace}
            comments={comments}
            sessions={sessions.filter((session) => !session.parentId)}
            sessionsFailed={isFailed(loaderData.sessionTrees)}
            lines={lines}
            sessionBase={sessionBase}
            viewer={viewer ? { id: viewer.id, username: viewer.username } : null}
            canModerate={loaderData.canModerate}
            failed={actionData && "comment" in actionData ? { comment: String(actionData.comment), error: actionData.error } : null}
            handles={loaderData.handles}
          />
          <div className="mt-2">
            {/* What a dialog or a comment refused says so there; anything else, here. */}
            {actionData && "error" in actionData && actionData.error && !("action" in actionData) && !("comment" in actionData) && (
              <ErrorText>{actionData.error}</ErrorText>
            )}
            {errorFor("react") && <ErrorText>{errorFor("react")}</ErrorText>}
            {errorFor("parent") && <ErrorText>{errorFor("parent")}</ErrorText>}
          </div>
        </div>
      </div>

      {canManage && open && (
        <CloseDialog reason="completed" chooseReason openSubItems={openSubItems} error={closeError} open={closing} onOpenChange={setClosing} />
      )}
      {viewer && openable.length > 0 && (
        <OpenPullDialog repos={openable} defaultRepo={workIn} error={errorFor("open-pull")} open={openingPull} onOpenChange={setOpeningPull} />
      )}
    </AttachImages>
  );
}

/** A property that could not be loaded, under its usual name. */
function SideUnavailable({ label, what }: { label: string; what: string }) {
  return (
    <PropertyRow label={label}>
      <div className="px-2 py-1.5">
        <Unavailable what={what} compact />
      </div>
    </PropertyRow>
  );
}
