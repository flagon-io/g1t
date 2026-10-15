/**
 * Code's Overview data: what needs the viewer, what landed, and the week,
 * across a workspace's projects. Code's Overview
 * (routes/workspace/code-overview.tsx) shows all of it; Home
 * (routes/workspace/home.tsx) takes what needs you from it.
 */
import { type G1tEvent, type Pull, type Repo, type RepoPath, type User, type Viewer, REPO_ROLE_LABELS, workOwner } from "@g1t/contracts";

import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace-choice";
import {
  type ActivityItem,
  type Need,
  TIME,
  actorIds,
  eventItem,
  FEED_EVENT_TYPES,
  groupActivity,
  nameActor,
  rankNeeds,
  readCookie,
  waitedFor,
} from "./mission";
import { G1T_COMMIT_EMAILS, normalizeEmail } from "./commit-people";
import {
  type Fact,
  type Merged,
  type NeedRow,
  type QuickAction,
  dateLine,
  dayKey,
  historyCovers,
  landedToday,
  placePushes,
  pullFacts,
  reachesBack,
  reasonFor,
  summaryLine,
  weekOf,
  who,
  whyFor,
} from "./mission-control";
import { needsYou } from "./inbox";
import { deployments, events as eventLog, identity, inbox, projects as projectsApi, repos as reposApi, work } from "./services.server";
import { roleIn } from "./session.server";
import { runners } from "./runners.server";
import { readableRepos } from "./access.server";

/** The viewer's time zone, which the page sets, so the date fits their day. */
const TZ_COOKIE = "g1t_tz";
/** The most projects whose pull requests and events are read for the page. */
const MAX_PROJECTS = 10;
const EVENTS_PER_PROJECT = 80;
/** How many pull requests work lists at once (`LIST_PAGE` in services/work). */
const PULL_PAGE = 100;
/** Unread inbox items read for the Needs you card, and how many it shows. */
const INBOX_READ = 50;
const INBOX_SHOWN = 4;

/** Where a need came from, so its row can say what is known about it. */
type Extra = Partial<Pick<NeedRow, "repo" | "ref" | "by" | "facts" | "quick" | "link" | "open">>;

/**
 * Push events read per project, a page at a time, back two weeks. Pushes
 * to every branch are in the log, so a fixed count lost a busy week's
 * earlier days to other branches.
 */
const PUSH_PAGE = 200;
const PUSH_PAGES = 5;
/** The first page is smaller: most projects push far less in two weeks. */
const FIRST_PUSH_PAGE = 50;
/**
 * Commits of the default branch read to place each push's commits: a
 * short read first, which covers most projects' fortnight, and the longer
 * one only when it does not reach the oldest push.
 */
const HISTORY_FIRST = 200;
const HISTORY_READ = 1000;

/**
 * The commits people pushed straight to a project's default branch in the
 * last two weeks, each with when its push landed. Merges and g1t's own
 * commits are left out: pull requests count those.
 */
async function directCommits(repo: Repo, viewer: Viewer): Promise<{ hash: string; at: string }[]> {
  const since = Date.now() - 14 * TIME.DAY;
  const pushes: G1tEvent<"git.push">[] = [];
  let before: string | undefined;
  for (let page = 0; page < PUSH_PAGES; page++) {
    const limit = page === 0 ? FIRST_PUSH_PAGE : PUSH_PAGE;
    const batch = await eventLog.list({ repoId: repo.id, types: ["git.push"], limit, ...(before ? { before } : {}) });
    for (const event of batch) {
      if (event.type === "git.push" && event.data.defaultBranch && Date.parse(event.time) >= since) pushes.push(event as G1tEvent<"git.push">);
    }
    const oldest = batch.at(-1);
    if (batch.length < limit || !oldest || Date.parse(oldest.time) < since) break;
    before = oldest.id;
  }
  if (pushes.length === 0) return [];
  // A read of the branch from the newest push back; each push brought
  // what lies between its `after` and its `before` in that history.
  const path = { namespace: repo.namespace, name: repo.name };
  const read = (limit: number) => reposApi.log(path, viewer, pushes[0].data.after, limit).catch(() => null);
  let history = await read(HISTORY_FIRST);
  if (history?.ok && !historyCovers(history.value, pushes, HISTORY_FIRST)) history = await read(HISTORY_READ);
  if (!history?.ok) return [];
  // g1t's own commits are told by their author address, never by name.
  return placePushes(history.value, pushes, (commit) => G1T_COMMIT_EMAILS.has(normalizeEmail(commit.author.email)));
}

export async function loadMissionControl(viewer: User, request: Request, workspace: string | null) {
  const now = Date.now();
  const started = Date.now();
  const times: Record<string, number> = {};
  // Each call is timed, and one that fails leaves its section empty rather
  // than taking the page down.
  const soft = <T,>(name: string, promise: Promise<T>): Promise<T | null> =>
    promise.then(
      (value) => ((times[name] = Date.now() - started), value),
      (error) => {
        console.warn(`overview: ${name} failed`, error);
        times[name] = Date.now() - started;
        return null;
      },
    );
  const okOr = <T,>(result: { ok: true; value: T } | { ok: false } | null): T | null => (result?.ok ? result.value : null);

  const cookies = request.headers.get("cookie");
  const tz = readCookie(cookies, TZ_COOKIE);
  const memberships = viewer.workspaces ?? [];
  // The workspace asked for, else the one you chose, as the sidebar shows it (lib/workspace-choice.ts).
  const slug =
    (workspace && roleIn(viewer, workspace) ? workspace.toLowerCase() : null) ??
    chosenWorkspace(memberships, readCookie(cookies, WORKSPACE_COOKIE))?.slug ??
    null;
  const username = viewer.username;

  const reposP = soft("repos", reposApi.list(viewer, { memberOnly: true }));
  // Workflow jobs stuck waiting for a self-hosted runner that is not there.
  const stuckJobsP = soft("stuck_jobs", runners.stuck(viewer));
  // The chosen workspace's projects: their open and recently merged pull
  // requests, all in one call to work, and their recent events, read as
  // soon as the projects are known.
  const perRepoP = reposP.then(async (repos) => {
    const chosen = (repos ?? [])
      .filter((repo) => slug != null && repo.namespace.toLowerCase() === slug.toLowerCase())
      .slice(0, MAX_PROJECTS);
    const [batch, logs, pushes] = await Promise.all([
      work.pullsForRepos(chosen.map((repo) => repo.id), viewer, PULL_PAGE).catch(() => []),
      Promise.all(chosen.map((repo) => eventLog.list({ repoId: repo.id, types: [...FEED_EVENT_TYPES], limit: EVENTS_PER_PROJECT }).catch(() => null))),
      // People's pushes straight to the default branch, which no pull
      // request counts: the commits each brought, for the week.
      Promise.all(chosen.map((repo) => directCommits(repo, viewer).catch(() => []))),
    ]);
    const byId = new Map(batch.map((entry) => [entry.repoId, entry]));
    return Promise.all(
      chosen.map(async (repo, index) => {
        const found = byId.get(repo.id);
        if (found) return { repo, pulls: found.open.slice(0, 60), closed: found.closed, events: logs[index], direct: pushes[index] ?? [] };
        // A fork, which the batch leaves out: asked on its own.
        const path = { namespace: repo.namespace, name: repo.name };
        const [pulls, closed] = await Promise.all([
          work.listPulls(path, viewer, "open").catch(() => null),
          work.listPulls(path, viewer, "closed").catch(() => null),
        ]);
        return {
          repo,
          pulls: pulls?.ok ? pulls.value.slice(0, 60) : null,
          closed: closed?.ok ? closed.value : null,
          events: logs[index],
          direct: pushes[index] ?? [],
        };
      }),
    );
  });

  const [repos, perRepo, active, profile, overview, projectList, invitations, unread] = await Promise.all([
    reposP,
    soft("projects", perRepoP),
    soft("pulls", work.listActivePulls(viewer)),
    soft("profile", identity.profile(username)),
    slug ? soft("deploys", deployments.overview(slug, viewer)) : null,
    slug ? soft("projectList", projectsApi.list(slug, viewer)) : null,
    // Repositories someone has invited the viewer to.
    soft("invitations", identity.myRepoInvitations(viewer)),
    // What in their inbox is unread: a failure or a warning goes on the Needs you card.
    soft("inbox", inbox.list(viewer, { unread: true, limit: INBOX_READ })),
  ]);

  const repoList = repos ?? [];
  // Each pull request is shown under its repository. Most are in the
  // viewer's own, already listed; the rest are looked up once each.
  const known = new Map<string, Repo>(repoList.map((repo) => [repo.id, repo]));
  const missing = [...new Set((active ?? []).map(({ pull }) => pull.repoId))].filter((id) => !known.has(id));
  for (const repo of await readableRepos(missing, viewer)) known.set(repo.id, repo);
  const pathOf = (repo: Repo): RepoPath => ({ namespace: repo.namespace, name: repo.name });
  const inWorkspace = (repo: RepoPath) => slug != null && repo.namespace.toLowerCase() === slug.toLowerCase();

  const activeList = (active ?? []).flatMap((item) => {
    const repo = known.get(item.pull.repoId);
    return repo ? [{ pull: item.pull, lifecycle: item.lifecycle, repo }] : [];
  });
  const overviewList = okOr(overview ?? null);
  const projectsOk = okOr(projectList ?? null);

  const lower = username.toLowerCase();
  const openPulls = (perRepo ?? []).flatMap(({ repo, pulls }) => (pulls ?? []).map((pull) => ({ pull, repo })));
  // Never your own.
  const reviewRequested = openPulls.filter(
    ({ pull }) =>
      pull.status === "open" &&
      workOwner(pull).username.toLowerCase() !== lower &&
      pull.reviewers.some((name) => name.toLowerCase() === lower),
  );

  // --- Needs you ------------------------------------------------------------
  const needs: Need[] = [];
  const extras = new Map<string, Extra>();
  /** What every pull request's row shares: where it is, who opened it, what is known. */
  const pullExtra = (pull: Pull, repo: Repo): Extra => {
    const base = `/${repo.namespace}/${repo.name}`;
    return {
      repo: pathOf(repo),
      ref: `#${pull.number}`,
      by: who(workOwner(pull).username),
      facts: pullFacts({ checkStatus: pull.checkStatus, files: pull.files }),
      open: pull.issue != null ? `${base}/issues/${pull.issue}` : `${base}/pull/${pull.number}/files`,
    };
  };
  const pullAction = (repo: Repo, pull: Pull, quick: Omit<QuickAction, "to">): QuickAction => ({
    ...quick,
    to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
  });

  for (const invitation of invitations ?? []) {
    if (invitation.status !== "pending") continue;
    const key = `invitation:${invitation.id}`;
    needs.push({
      key,
      kind: "invitation",
      title: `${invitation.invited_by ?? "Someone"} invited you to ${invitation.repo}`,
      detail: `With the ${REPO_ROLE_LABELS[invitation.role]} role. The invitation expires ${new Date(invitation.expires_at).toISOString().slice(0, 10)}.`,
      to: `/${invitation.repo}/invitations`,
      action: "Respond",
      at: Date.parse(invitation.created_at),
      where: invitation.repo,
    });
    const [namespace, name] = invitation.repo.split("/");
    extras.set(key, {
      repo: namespace && name ? { namespace, name } : null,
      by: who(invitation.invited_by),
      facts: [
        { label: "Role", value: REPO_ROLE_LABELS[invitation.role], tone: null },
        { label: "Expires", value: new Date(invitation.expires_at).toISOString().slice(0, 10), tone: null },
      ],
    });
  }
  for (const entry of overviewList ?? []) {
    const latest = entry.latest;
    if (latest?.kind === "production" && latest.status === "failed" && slug) {
      const key = `deploy:${entry.slug}`;
      const to = `/${slug}/${entry.slug}/deployments/${latest.id}`;
      needs.push({
        key,
        kind: "deploy",
        title: `Production build of ${entry.slug} failed`,
        detail: latest.error ?? "The last build of the default branch failed. Production still serves the build before it.",
        to,
        action: "See the build",
        at: Date.parse(latest.finishedAt ?? latest.createdAt),
        where: `${slug}/${entry.slug}`,
      });
      const facts: Fact[] = [
        { label: "Commit", value: latest.commit.slice(0, 7), tone: null },
        {
          label: "Production",
          value: entry.production ? "Serving the build before" : "Not live yet",
          tone: entry.production ? "good" : "warn",
        },
      ];
      extras.set(key, {
        repo: { namespace: slug, name: entry.slug },
        by: who(latest.createdBy),
        facts,
        link: { label: "Deployment settings", to: `/${slug}/${entry.slug}/settings/deployments` },
      });
    }
  }
  for (const { pull, lifecycle, repo } of activeList) {
    if (pull.status !== "open") continue;
    // In this workspace, when the page is for one.
    if (slug && !inWorkspace(repo)) continue;
    const where = `${repo.namespace}/${repo.name}#${pull.number}`;
    const to = `/${repo.namespace}/${repo.name}/pull/${pull.number}`;
    // Your pull request, where its lifecycle says it stands (work keeps it
    // fresh as checks, reviews and pushes arrive): someone has to step in,
    // or everything is met and it lands when you merge it.
    if (lifecycle?.stage === "needs_you") {
      const conflict = /conflict/i.test(lifecycle.detail);
      const key = `pull:${pull.id}`;
      needs.push({ key, kind: conflict ? "conflict" : "stalled", title: pull.title, detail: lifecycle.detail, to, action: conflict ? "Resolve" : "Decide", at: Date.parse(pull.updatedAt), where });
      extras.set(key, { ...pullExtra(pull, repo), quick: null });
      continue;
    }
    if (lifecycle?.stage === "ready") {
      const key = `ready:${pull.id}`;
      needs.push({ key, kind: "ready", title: pull.title, detail: "Ready to land when you merge it.", to, action: "Merge", at: Date.parse(pull.updatedAt), where });
      // Its lifecycle says the required checks passed, which a list's merge-queue status does not.
      const [, ...rest] = pullExtra(pull, repo).facts ?? [];
      extras.set(key, { ...pullExtra(pull, repo), facts: [{ label: "Required checks", value: "Passing", tone: "good" }, ...rest], quick: null });
      continue;
    }
    // Taken out of the merge queue: its change failed combined with what was ahead.
    if (pull.checkStatus !== "failed") continue;
    const key = `pull:${pull.id}`;
    needs.push({
      key,
      kind: "checks",
      title: pull.title,
      detail: "It failed in the merge queue. Push a fix, then merge it again.",
      to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
      action: "See checks",
      at: Date.parse(pull.updatedAt),
      where: `${repo.namespace}/${repo.name}#${pull.number}`,
    });
    extras.set(key, { ...pullExtra(pull, repo), quick: null });
  }
  for (const { pull, repo } of reviewRequested) {
    const key = `review:${pull.id}`;
    needs.push({
      key,
      kind: "review",
      title: pull.title,
      detail: `${workOwner(pull).username} asked for your review.`,
      to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
      action: "Review",
      at: Date.parse(pull.updatedAt),
      where: `${repo.namespace}/${repo.name}#${pull.number}`,
    });
    extras.set(key, {
      ...pullExtra(pull, repo),
      quick: pullAction(repo, pull, { label: "Approve the change", fields: { action: "comment", verdict: "approve", body: "" }, done: "Approved" }),
    });
  }
  for (const job of (await stuckJobsP) ?? []) {
    const key = `runner:${job.id}`;
    const minutes = Math.max(10, Math.round((now - Date.parse(job.queuedAt)) / 60_000));
    const [namespace, name] = job.repo.split("/");
    needs.push({
      key,
      kind: "runner",
      title: `${job.name} is waiting for a self-hosted runner`,
      detail: `No runner with labels ${job.labels} is online. Start one, or change the job's runs-on.`,
      to: `/${job.repo}/actions/runs/${job.runId}`,
      action: "Look",
      at: Date.parse(job.queuedAt),
      where: job.repo,
    });
    extras.set(key, {
      repo: namespace && name ? { namespace, name } : undefined,
      facts: [
        { label: "Labels", value: job.labels, tone: null },
        { label: "Waiting", value: waitedFor(minutes), tone: "warn" },
      ],
      // Runners are the owners' to see to.
      ...(namespace && roleIn(viewer, namespace) === "owner" ? { link: { label: "Runners", to: `/${namespace}/-/runners` } } : {}),
    });
  }

  const needRows: NeedRow[] = rankNeeds(needs).map((need) => {
    const extra = extras.get(need.key) ?? {};
    const reason = reasonFor(need);
    return {
      key: need.key,
      reason,
      repo: extra.repo ?? null,
      ref: extra.ref ?? null,
      title: need.title,
      ask: need.detail,
      by: extra.by ?? null,
      at: need.at,
      to: need.to,
      open: extra.open ?? need.to,
      facts: extra.facts ?? [],
      why: whyFor(reason, need),
      quick: extra.quick ?? null,
      link: extra.link ?? null,
    };
  });

  // --- Landed ---------------------------------------------------------------
  const merged: Merged[] = (perRepo ?? []).flatMap(({ repo, closed }) =>
    (closed ?? []).flatMap((pull) =>
      pull.status === "merged" && pull.mergedAt
        ? [{ repo: pathOf(repo), number: pull.number, title: pull.title, mergedBy: pull.mergedBy, mergedAt: pull.mergedAt, files: pull.files }]
        : [],
    ),
  );
  const twoWeeksAgo = now - 14 * TIME.DAY;
  const complete = perRepo != null && perRepo.every(({ closed }) => closed != null && reachesBack(closed, twoWeeksAgo, PULL_PAGE));
  // Commits pushed straight to the default branch are changes too, on the day they landed.
  const direct = (perRepo ?? []).flatMap(({ direct }) => direct.map((commit) => ({ mergedAt: commit.at })));
  const week = weekOf([...merged, ...direct], now, tz, complete);
  const landed = landedToday(merged, now, tz);

  // --- Activity -------------------------------------------------------------
  const items: ActivityItem[] = [];
  const titles: Record<string, string> = {};
  const titleKey = (repo: RepoPath, number: number) => `${repo.namespace}/${repo.name}#${number}`.toLowerCase();
  for (const { repo, pulls, closed, events } of perRepo ?? []) {
    for (const pull of [...(pulls ?? []), ...(closed ?? [])]) titles[titleKey(repo, pull.number)] = pull.title;
    for (const event of events ?? []) {
      if (event.type === "issue.opened") titles[titleKey(repo, event.data.number)] ??= event.data.title;
      const item = eventItem(event, pathOf(repo));
      if (item) items.push(item);
    }
  }
  // The log names people by account id: their usernames, in one lookup.
  const ids = actorIds(items.map((item) => item.actor));
  const names = ids.length > 0 ? await soft("usernames", identity.usernames(ids)) : {};
  const groups = groupActivity(items.map((item) => ({ ...item, actor: nameActor(item.actor, names) }))).slice(0, 40);
  // Only the titles the feed names travel to the page.
  const shownTitles: Record<string, string> = {};
  for (const group of groups) {
    for (const part of group.parts) {
      for (const number of part.numbers) {
        const key = titleKey(group.repo, number);
        if (titles[key]) shownTitles[key] = titles[key];
      }
    }
  }

  // --- The strip ------------------------------------------------------------
  const month = dayKey(now, tz).slice(0, 7);
  const projectCount = projectsOk?.length ?? (perRepo != null ? perRepo.length : null);
  const projectsThisMonth = projectsOk ? projectsOk.filter((project) => dayKey(Date.parse(project.createdAt), tz).slice(0, 7) === month).length : null;
  const openCount = perRepo != null ? openPulls.filter(({ pull }) => pull.status === "open" || pull.status === "draft").length : null;

  times.total = Date.now() - started;
  const serverTiming = Object.entries(times)
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ");
  return {
    timing: serverTiming,
    value: {
      signedIn: true as const,
      viewer,
      name: profile?.name?.trim() || username,
      date: dateLine(now, tz),
      summary: summaryLine({ total: week.total, needs: needRows.length }),
      workspace: slug,
      repos: repoList.filter((repo) => inWorkspace(repo)).map(pathOf),
      needs: needRows,
      landed,
      perRepoLoaded: perRepo != null,
      stats: {
        projects: projectCount,
        projectsThisMonth,
        openPulls: openCount,
      },
      week,
      groups,
      titles: shownTitles,
      inboxNeeds: needsYou(unread?.items ?? [], INBOX_SHOWN),
    },
  };
}

/** What Code's Overview takes. */
export type Loaded = Awaited<ReturnType<typeof loadMissionControl>>["value"];

/** The cookie that holds the viewer's time zone. */
export { TZ_COOKIE };
