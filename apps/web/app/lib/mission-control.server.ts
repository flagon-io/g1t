/**
 * Mission control's data: what needs the viewer, what waits on agents, what
 * landed, and the week, across a workspace's projects. Code's Overview
 * (routes/workspace/code-overview.tsx) shows all of it; Home
 * (routes/workspace/home.tsx) takes what needs you from it.
 */
import { env } from "cloudflare:workers";

import {
  type Confidence,
  type G1tEvent,
  type Lifecycle,
  type Pull,
  type Repo,
  type RepoPath,
  type User,
  type Viewer,
  REPO_ROLE_LABELS,
  isActiveRun,
  workOwner,
} from "@g1t/contracts";

import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace-choice";
import {
  type ActivityItem,
  type Need,
  TIME,
  actorIds,
  agentHours,
  dailyBuckets,
  eventItem,
  FEED_EVENT_TYPES,
  greetingFor,
  groupActivity,
  hourIn,
  isAgent,
  nameActor,
  rankNeeds,
  readCookie,
  stuckMinutes,
  waitedFor,
} from "./mission";
import { G1T_COMMIT_EMAILS, normalizeEmail } from "./commit-people";
import {
  type Fact,
  type Merged,
  placePushes,
  type NeedRow,
  type QuickAction,
  RUN_LABEL,
  confidenceAsk,
  dateLine,
  dayKey,
  landedToday,
  needPathKey,
  pullFacts,
  reachesBack,
  reasonFor,
  summaryLine,
  usd,
  waitingRows,
  weekOf,
  historyCovers,
  who,
  whyFor,
  withConfidence,
} from "./mission-control";
import { needsYou } from "./inbox";
import {
  agents,
  billing,
  deployments,
  events as eventLog,
  identity,
  inbox,
  projects as projectsApi,
  repos as reposApi,
  work,
} from "./services.server";
import { roleIn } from "./session.server";
import { runners } from "./runners.server";
import { readableRepos } from "./access.server";

/** The viewer's time zone, which mission control sets, so the greeting fits their day. */
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
type Extra = Partial<Pick<NeedRow, "repo" | "ref" | "by" | "for" | "facts" | "quick" | "link" | "open">> & {
  /** How sure g1t is of the agent's change, for a pull request. */
  confidence?: Confidence | null;
};

/** What the composer said back, when the issue opened but the agent did not start, or nothing opened. */
/**
 * Push events read per project, a page at a time, back two weeks. Pushes
 * to every branch are in the log, so a fixed count (it was 40) lost a busy
 * week's earlier days to agents' branches.
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
 * last two weeks, each with when its push landed. Merges and agents'
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
  const weekAgo = now - 7 * TIME.DAY;
  const started = Date.now();
  const times: Record<string, number> = {};
  // Each call is timed, and one that fails leaves its section empty rather
  // than taking the page down.
  const soft = <T,>(name: string, promise: Promise<T>): Promise<T | null> =>
    promise.then(
      (value) => ((times[name] = Date.now() - started), value),
      (error) => {
        console.warn(`home: ${name} failed`, error);
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

  const [repos, perRepo, active, models, profile, runs, overview, usage, projectList, memories, invitations, tokens, myTokens, unread] = await Promise.all([
    reposP,
    soft("projects", perRepoP),
    soft("pulls", work.listActivePulls(viewer)),
    slug ? soft("models", env.RUNNER.modelAccess(slug)) : null,
    soft("profile", identity.profile(username)),
    slug ? soft("runs", agents.listRuns(viewer, { workspace: slug, limit: 150 })) : null,
    slug ? soft("deploys", deployments.overview(slug, viewer)) : null,
    slug ? soft("usage", billing.usage(slug, viewer, new Date(weekAgo - TIME.DAY).toISOString())) : null,
    slug ? soft("projectList", projectsApi.list(slug, viewer)) : null,
    slug ? soft("memories", agents.listMemories(viewer, slug, null)) : null,
    // Repositories someone has invited the viewer to.
    soft("invitations", identity.myRepoInvitations(viewer)),
    // Model tokens over the last six weeks: the workspace's, and yours.
    slug ? soft("tokens", billing.tokenUsage(slug, viewer)) : null,
    slug ? soft("my_tokens", billing.tokenUsage(slug, viewer, { person: username })) : null,
    // What in their inbox is unread: an agent waiting on them, or a failure, goes on the Needs you card.
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
    return repo ? [{ ...item, repo }] : [];
  });
  const runList = okOr(runs ?? null) ?? [];
  const liveRuns = runList.filter((run) => isActiveRun(run.status));
  const overviewList = okOr(overview ?? null);
  const projectsOk = okOr(projectList ?? null);
  const runsOn = (repo: RepoPath, number: number) =>
    runList.filter(
      (run) => run.number === number && `${run.repo.namespace}/${run.repo.name}`.toLowerCase() === `${repo.namespace}/${repo.name}`.toLowerCase(),
    );

  const lower = username.toLowerCase();
  const openPulls = (perRepo ?? []).flatMap(({ repo, pulls }) => (pulls ?? []).map((pull) => ({ pull, repo })));
  // Never your own, nor one g1t made for you.
  const reviewRequested = openPulls.filter(
    ({ pull }) =>
      pull.status === "open" &&
      workOwner(pull).username.toLowerCase() !== lower &&
      pull.reviewers.some((name) => name.toLowerCase() === lower),
  );

  // --- Needs you ------------------------------------------------------------
  const needs: Need[] = [];
  const extras = new Map<string, Extra>();
  /** What every pull request's row shares: where it is, who is on it, what is known. */
  const pullExtra = (pull: Pull, repo: Repo, lifecycle: Lifecycle | null): Extra => {
    const base = `/${repo.namespace}/${repo.name}`;
    const agentWork = isAgent(pull.agent);
    return {
      repo: pathOf(repo),
      ref: `#${pull.number}`,
      by: agentWork ? who(pull.agent) : who(pull.author.username),
      for: agentWork ? workOwner(pull).username : null,
      facts: pullFacts({
        checkStatus: pull.checkStatus,
        files: pull.files,
        lifecycle,
        runs: runsOn(repo, pull.number),
        confidence: pull.confidence,
      }),
      open: pull.issue != null ? `${base}/issues/${pull.issue}` : `${base}/pull/${pull.number}?tab=changes`,
      confidence: pull.confidence ?? null,
    };
  };
  const pullAction = (repo: Repo, pull: Pull, quick: Omit<QuickAction, "to">): QuickAction => ({
    ...quick,
    to: `/${repo.namespace}/${repo.name}/pull/${pull.number}`,
  });
  const approve = (repo: Repo, pull: Pull) =>
    pullAction(repo, pull, {
      label: isAgent(pull.agent) ? "Approve the agent's change" : "Approve the change",
      fields: { action: "comment", verdict: "approve", body: "" },
      done: "Approved",
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
    const where = `${repo.namespace}/${repo.name}#${pull.number}`;
    const to = `/${repo.namespace}/${repo.name}/pull/${pull.number}`;
    const key = `pull:${pull.id}`;
    const extra = pullExtra(pull, repo, lifecycle);
    // Held for its low confidence: the ask says so in a sentence of its own.
    const lowConfidence = pull.confidence?.level === "low" ? pull.confidence : null;
    if (lifecycle?.stage === "needs_you") {
      const held = lowConfidence != null && /confidence in this change is low/i.test(lifecycle.detail);
      const conflict = !held && /conflict/i.test(lifecycle.detail);
      const need: Need = {
        key,
        kind: conflict ? "conflict" : "stalled",
        title: pull.title,
        detail: held && lowConfidence ? confidenceAsk(lowConfidence) : lifecycle.detail,
        to,
        action: conflict ? "Resolve" : "Decide",
        at: Date.parse(pull.updatedAt),
        where,
      };
      needs.push(need);
      const reason = held ? "low_confidence" : reasonFor(need);
      extras.set(key, {
        ...extra,
        quick:
          reason === "needs_review" || reason === "low_confidence"
            ? approve(repo, pull)
            : /required checks? .*still fails?\b/i.test(lifecycle.detail)
              ? pullAction(repo, pull, { label: "Re-run failed jobs", fields: { action: "rerun-failed" }, done: "Re-running" })
              : null,
        link: reason === "outside_guardrails" ? { label: "Raise the cap", to: `/${repo.namespace}/${repo.name}/settings/guardrails` } : null,
      });
    } else if (lifecycle?.stage === "ready") {
      needs.push({
        key,
        kind: "ready",
        title: pull.title,
        detail: lowConfidence ? confidenceAsk(lowConfidence) : "Its required checks passed and it was approved. It lands when you merge it.",
        to,
        action: "Merge",
        at: Date.parse(pull.updatedAt),
        where,
      });
      extras.set(key, {
        ...extra,
        quick: pullAction(repo, pull, {
          label: isAgent(pull.agent) ? "Merge the agent's change" : "Merge it",
          fields: { action: "merge" },
          done: "Merging",
        }),
      });
    } else if (!lifecycle && pull.status === "open" && pull.checkStatus === "failed") {
      // Taken out of the merge queue: its change failed combined with what was ahead.
      needs.push({ key, kind: "checks", title: pull.title, detail: "It failed in the merge queue. Push a fix, then merge it again.", to, action: "See checks", at: Date.parse(pull.updatedAt), where });
      extras.set(key, { ...extra, quick: null });
    }
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
    extras.set(key, { ...pullExtra(pull, repo, null), quick: approve(repo, pull) });
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
  for (const run of liveRuns) {
    const minutes = stuckMinutes(run, now);
    if (minutes == null) continue;
    const key = `run:${run.id}`;
    needs.push({
      key,
      kind: "stuck",
      title: run.title ?? `${run.agent}'s run`,
      detail: `${run.agent} has reported nothing for ${waitedFor(minutes)}${run.step ? `. Last: ${run.step}` : ""}.`,
      to: `/${run.repo.namespace}/${run.repo.name}/agents/runs/${run.id}`,
      action: "Look",
      at: Date.parse(run.updatedAt),
      where: `${run.repo.namespace}/${run.repo.name}${run.number != null ? `#${run.number}` : ""}`,
    });
    extras.set(key, {
      repo: run.repo,
      ref: run.number != null ? `#${run.number}` : null,
      by: who(run.agent),
      facts: [
        { label: "Run", value: RUN_LABEL[run.kind], tone: null },
        { label: "Quiet for", value: waitedFor(minutes), tone: "warn" },
        { label: "Steps so far", value: String(run.stepCount), tone: null },
        ...(run.costUsd != null ? [{ label: "Cost so far", value: usd(run.costUsd), tone: null }] : []),
      ],
      open: run.number != null ? `/${run.repo.namespace}/${run.repo.name}/pull/${run.number}` : undefined,
    });
  }

  const needRows: NeedRow[] = rankNeeds(needs).map((need) => {
    const extra = extras.get(need.key) ?? {};
    const reason = withConfidence(reasonFor(need), extra.confidence);
    return {
      key: need.key,
      reason,
      repo: extra.repo ?? null,
      ref: extra.ref ?? null,
      title: need.title,
      ask: need.detail,
      by: extra.by ?? null,
      for: extra.for ?? null,
      at: need.at,
      to: need.to,
      open: extra.open ?? need.to,
      facts: extra.facts ?? [],
      why: whyFor(reason, need, extra.confidence),
      quick: extra.quick ?? null,
      link: extra.link ?? null,
    };
  });

  // --- Waiting on agents ----------------------------------------------------
  const needKeys = new Set(
    needRows.flatMap((row) => (row.repo && row.ref ? [needPathKey(row.repo, Number(row.ref.slice(1)))] : [])),
  );
  const waiting = waitingRows({
    active: activeList.filter(({ repo }) => inWorkspace(repo)).map(({ pull, lifecycle, repo }) => ({ pull, lifecycle, repo: pathOf(repo) })),
    live: liveRuns,
    drafts: openPulls.filter(({ pull }) => pull.status === "draft").map(({ pull, repo }) => ({ ...pull, repo: pathOf(repo) })),
    needKeys,
  });

  // --- Landed ---------------------------------------------------------------
  const merged: Merged[] = (perRepo ?? []).flatMap(({ repo, closed }) =>
    (closed ?? []).flatMap((pull) =>
      pull.status === "merged" && pull.mergedAt
        ? [
            {
              repo: pathOf(repo),
              number: pull.number,
              title: pull.title,
              agent: pull.agent,
              // Who wrote it, not who merged it: a person's change that g1t
              // auto-merged is still theirs.
              authoredByAgent: pull.author.kind === "agent" || isAgent(pull.author.username),
              mergedBy: pull.mergedBy,
              mergedAt: pull.mergedAt,
              files: pull.files,
            },
          ]
        : [],
    ),
  );
  const twoWeeksAgo = now - 14 * TIME.DAY;
  const complete = perRepo != null && perRepo.every(({ closed }) => closed != null && reachesBack(closed, twoWeeksAgo, PULL_PAGE));
  // A person's commits pushed straight to the default branch are their own
  // changes too, on the day they landed.
  const direct = (perRepo ?? []).flatMap(({ direct }) =>
    direct.map((commit) => ({ mergedAt: commit.at, mergedBy: null, authoredByAgent: false })),
  );
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
  // Production deploys come from the log too (deployment_status.created),
  // wherever they ran: g1t.page, g1t Actions or the API.
  for (const memory of okOr(memories ?? null)?.workspace ?? []) {
    const repo = memory.repo ?? memory.source.repo;
    if (!repo || !slug) continue;
    items.push({
      id: `memory:${memory.id}`,
      at: Date.parse(memory.createdAt),
      repo,
      actor: memory.createdBy,
      verb: "learned",
      number: null,
      text: memory.text.length > 90 ? `${memory.text.slice(0, 88)}…` : memory.text,
      to: `/${slug}/-/memory`,
    });
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
  const usageOk = okOr(usage ?? null);
  const costPoints = usageOk
    ? usageOk.byDay.map((slice) => ({ at: Date.parse(`${slice.key.split("/")[0]}T12:00:00Z`), value: slice.micros / 1_000_000 }))
    : runList.filter((run) => run.costUsd != null).map((run) => ({ at: Date.parse(run.createdAt), value: run.costUsd ?? 0 }));
  const weekCost = dailyBuckets(costPoints, 7, now).reduce((sum, v) => sum + v, 0);
  const month = dayKey(now, tz).slice(0, 7);
  const projectCount = projectsOk?.length ?? (perRepo != null ? perRepo.length : null);
  const projectsThisMonth = projectsOk ? projectsOk.filter((project) => dayKey(Date.parse(project.createdAt), tz).slice(0, 7) === month).length : null;

  const models_ = models ?? null;
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
      greeting: greetingFor(hourIn(now, tz)),
      date: dateLine(now, tz),
      summary: summaryLine({
        total: week.total,
        byAgents: week.byAgents,
        agentChanges: week.agentChanges,
        people: week.people,
        live: liveRuns.length,
        needs: needRows.length,
      }),
      workspace: slug,
      repos: repoList.filter((repo) => inWorkspace(repo)).map(pathOf),
      canRunAgents: models_ == null || models_.hosted || models_.own != null,
      trial: models_?.own == null ? (models_?.trial ?? null) : null,
      handedOff: activeList.length > 0 || runList.length > 0 || merged.length > 0,
      needs: needRows,
      waiting,
      landed,
      liveTotal: liveRuns.length,
      runsLoaded: runs != null && runs.ok,
      perRepoLoaded: perRepo != null,
      stats: {
        projects: projectCount,
        projectsThisMonth,
        agentHours: agentHours(runList, weekAgo, now),
        weekCost,
      },
      week,
      tokens: { workspace: okOr(tokens), mine: okOr(myTokens) },
      groups,
      titles: shownTitles,
      inboxNeeds: needsYou(unread?.items ?? [], INBOX_SHOWN),
      // A run that is going makes the page worth refreshing on its own.
      changing:
        liveRuns.length > 0 ||
        activeList.some((item) => item.lifecycle && item.lifecycle.stage !== "needs_you" && item.lifecycle.stage !== "ready"),
    },
  };
}

/** What Mission control's panels take. */
export type Loaded = Awaited<ReturnType<typeof loadMissionControl>>["value"];

/** The cookie that holds the viewer's time zone. */
export { TZ_COOKIE };
