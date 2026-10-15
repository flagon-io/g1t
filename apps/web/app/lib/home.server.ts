/**
 * Home's reads: each section's data from its own service, every call on
 * its own so one that fails leaves only its section saying so. The shaping
 * is in ./home.ts.
 */
import { env } from "cloudflare:workers";

import {
  type ActivityDigest,
  type ChatActivity,
  type Commit,
  type Deployment,
  type G1tEvent,
  type InboxItem,
  MAX_DIGEST_REPOS,
  type ProjectDeploys,
  type PullSessions,
  type Repo,
  type RepoPath,
  type ShippedRepo,
  type User,
  type WorkflowRun,
  notifyClient,
  G1T_KEY,
} from "@g1t/contracts";

import {
  type CodePull,
  type CodeWork,
  type DirectPush,
  G1T_ACTOR,
  type LandedChange,
  type RepoRef,
  type Span,
  type Spend,
  deployActorKey,
  shippedAsks,
  spanMonths,
  spendIn,
} from "./home";
import { monthSpan } from "./usage";
import { actions, billing, chat, deployments, events, identity, inbox, repos, work } from "./services.server";

/** Pull requests read per project and list: `LIST_PAGE` in services/work. */
const PULL_PAGE = 100;
/** The most projects whose pull requests are read. */
const MAX_PROJECTS = 50;
/** The most projects whose builds are read for the span. */
const MAX_DEPLOY_PROJECTS = 20;
/** The most projects whose workflow runs are read for Running now: those pushed to most in the span. */
const MAX_WORKFLOW_PROJECTS = 10;
/** Runs read per project: enough to find the ones not finished. */
const WORKFLOW_RUNS = 20;
/** The most member keys named in one lookup. */
const MAX_NAMES = 200;
const DAY = 24 * 60 * 60 * 1000;

const warn = (what: string) => (error: unknown) => {
  console.warn(`home: ${what} failed`, error);
  return null;
};

/**
 * When the viewer was last on this workspace's Home, from notify, where it
 * is kept with them (the same on every device). Null when there is no
 * visit on record; undefined when notify did not answer.
 */
export async function loadLastVisit(viewer: User, slug: string): Promise<number | null | undefined> {
  if (!env.NOTIFY) return undefined;
  const visit = await notifyClient(env.NOTIFY).lastVisit(viewer, slug).catch(warn("last visit"));
  if (!visit) return undefined;
  return visit.seen_at ? Date.parse(visit.seen_at) : null;
}

/** Marks the viewer's visit at `at`, the time the page they looked at loaded. */
export async function markVisit(viewer: User, slug: string, at: number): Promise<boolean> {
  if (!env.NOTIFY) return false;
  const marked = await notifyClient(env.NOTIFY).markVisit(viewer, slug, new Date(at).toISOString()).catch(warn("mark visit"));
  return marked != null;
}

/**
 * The workspace's own repositories the viewer may read (no pull request
 * working copies), as every Code section reads them. Null when repos did
 * not answer.
 */
export async function loadRepos(viewer: User, slug: string): Promise<Repo[] | null> {
  const list = await repos.list(viewer, { namespace: slug }).catch(warn("repos"));
  return list ? list.filter((repo) => !repo.forkOf && repo.namespace.toLowerCase() === slug) : null;
}

/** The repositories by id, as the digest's lines and links need them. */
export function repoRefs(list: Repo[] | null): Record<string, RepoRef> {
  const refs: Record<string, RepoRef> = {};
  for (const repo of list ?? []) refs[repo.id] = { namespace: repo.namespace, name: repo.name, defaultBranch: repo.defaultBranch };
  return refs;
}

/**
 * The workspace's projects' pull requests, open and recently merged or
 * closed, any author's. `complete` when every list reaches back to
 * `reach`. Null when Code did not answer.
 */
export async function loadCodeWork(viewer: User, slug: string, reach: number, owned: Repo[] | null): Promise<CodeWork | null> {
  if (!owned) return null;
  const chosen = owned.slice(0, MAX_PROJECTS);
  const byId = new Map<string, Repo>(chosen.map((repo) => [repo.id, repo]));
  const batch = chosen.length > 0 ? await work.pullsForRepos([...byId.keys()], viewer, PULL_PAGE).catch(warn("pull requests")) : [];
  if (!batch) return null;
  const pulls: CodePull[] = [];
  let complete = owned.length <= MAX_PROJECTS;
  for (const entry of batch) {
    const repo = byId.get(entry.repoId);
    if (!repo) continue;
    const path = { namespace: repo.namespace, name: repo.name };
    for (const pull of [...entry.open, ...entry.closed]) {
      pulls.push({
        repo: path,
        repoId: repo.id,
        mergeCommit: pull.mergeCommit ?? null,
        number: pull.number,
        title: pull.title,
        status: pull.status,
        mergedAt: pull.mergedAt,
        mergedBy: pull.mergedBy,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
        author: { username: pull.author.username, kind: pull.author.kind },
      });
    }
    // A full page that does not reach back far enough may leave some out.
    for (const list of [entry.open, entry.closed]) {
      if (list.length >= PULL_PAGE) {
        const oldest = Math.min(...list.map((pull) => Date.parse(pull.mergedAt ?? pull.updatedAt)));
        if (oldest > reach) complete = false;
      }
    }
  }
  return { pulls, complete };
}

/**
 * What happened in the span, counted by who did it: the events service's
 * digest of the workspace's repositories (the first MAX_DIGEST_REPOS of
 * them; none without Code access) and of its artifacts. Null when events
 * did not answer.
 */
export async function loadActivity(slug: string, span: Pick<Span, "from" | "now">, owned: Repo[] | null): Promise<ActivityDigest | null> {
  const digest = await events
    .activityDigest({
      repo_ids: (owned ?? []).slice(0, MAX_DIGEST_REPOS).map((repo) => repo.id),
      workspace: slug,
      from: new Date(span.from).toISOString(),
      until: new Date(span.now + 1).toISOString(),
    })
    .catch(warn("activity digest"));
  if (!digest) return null;
  // More repositories than the digest reads: it says so.
  return owned && owned.length > MAX_DIGEST_REPOS ? { ...digest, complete: false } : digest;
}

/** What was said in the span where the viewer can read, counted. Null when chat did not answer. */
export async function loadChatActivity(viewer: User, slug: string, span: Pick<Span, "from" | "now">): Promise<ChatActivity | null> {
  const activity = await chat
    .activity(slug, viewer, { from: new Date(span.from).toISOString(), until: new Date(span.now + 1).toISOString() })
    .catch(warn("chat activity"));
  return activity?.ok ? activity.value : null;
}

/** Every member key the digest and chat name. */
export function actorKeys(activity: ActivityDigest | null, chatActivity: ChatActivity | null, deploys?: { projects: { deployments: { createdBy: string }[] }[] } | null): string[] {
  const keys = new Set<string>();
  for (const project of deploys?.projects ?? []) for (const deploy of project.deployments) keys.add(deployActorKey(deploy.createdBy) ?? "");
  for (const repo of activity?.repos ?? []) {
    for (const by of [...repo.pushes.by, ...repo.pushes.default_branch.by]) keys.add(by.actor);
    for (const list of [repo.pulls.opened, repo.pulls.merged, repo.pulls.closed, repo.issues.opened, repo.issues.closed, repo.reviews, repo.comments, repo.deployments.succeeded, repo.deployments.failed]) {
      for (const entry of list) keys.add(entry.actor);
    }
    for (const release of repo.releases) keys.add(release.actor);
    for (const pkg of repo.packages) keys.add(pkg.actor);
  }
  for (const entry of activity?.folios?.created ?? []) keys.add(entry.actor);
  for (const folio of activity?.folios?.edited ?? []) for (const author of folio.authors) keys.add(author);
  for (const author of chatActivity?.authors ?? []) keys.add(author.key);
  keys.delete("");
  return [...keys];
}

/**
 * The names behind member keys: people's usernames from identity (one
 * lookup for them all), g1t as itself. A key identity does not know, and
 * an agent of older rows, is left out, and shows as "someone".
 */
export async function loadNames(keys: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const userIds: string[] = [];
  for (const key of keys.slice(0, MAX_NAMES)) {
    if (key === G1T_ACTOR || key === "user:g1t" || key === G1T_KEY || key.startsWith("user:wsp_")) names[key] = "g1t";
    else if (key.startsWith("agent:") || key.startsWith("user:agt_")) continue;
    else if (key.startsWith("user:")) userIds.push(key.slice("user:".length));
  }
  if (userIds.length > 0) {
    const found = await identity.usernames(userIds).catch(warn("usernames"));
    for (const [id, username] of Object.entries(found ?? {})) names[`user:${id}`] = username;
  }
  return names;
}

/**
 * The newest workflow runs of the projects pushed to most in the span (at
 * most MAX_WORKFLOW_PROJECTS), for the ones still going. A project whose
 * runs could not be read is left out; `complete` says whether every one was.
 */
export async function loadWorkflowRuns(
  viewer: User,
  activity: ActivityDigest | null,
  owned: Repo[] | null,
): Promise<{ projects: { repo: RepoPath; runs: WorkflowRun[] }[]; complete: boolean }> {
  const byId = new Map((owned ?? []).map((repo) => [repo.id, repo]));
  const active = [...(activity?.repos ?? [])]
    .filter((repo) => repo.pushes.count > 0 && byId.has(repo.repo_id))
    .sort((a, b) => b.pushes.count - a.pushes.count || a.repo_id.localeCompare(b.repo_id))
    .slice(0, MAX_WORKFLOW_PROJECTS);
  const lists = await Promise.all(
    active.map((digest) => {
      const repo = byId.get(digest.repo_id)!;
      const path = { namespace: repo.namespace, name: repo.name };
      return actions
        .runs(path, viewer, { limit: WORKFLOW_RUNS })
        .then((result) => (result.ok ? { repo: path, runs: result.value } : null))
        .catch(warn(`workflow runs of ${repo.name}`));
    }),
  );
  const projects = lists.filter((entry) => entry != null);
  return { projects, complete: projects.length === active.length };
}

/**
 * Every project's builds at a glance, and the builds of the projects that
 * deploy, for the span: the projects whose newest build is older than the
 * span are not read again.
 */
export async function loadDeploys(
  viewer: User,
  slug: string,
  from: number,
): Promise<{ overview: ProjectDeploys[]; projects: { slug: string; deployments: Deployment[] }[]; complete: boolean } | null> {
  const overview = await deployments.overview(slug, viewer).catch(warn("deploys overview"));
  if (!overview?.ok) return null;
  const recent = overview.value.filter((project) => project.latest && Date.parse(project.latest.finishedAt ?? project.latest.createdAt) >= from);
  const read = recent.slice(0, MAX_DEPLOY_PROJECTS);
  const lists = await Promise.all(
    read.map((project) =>
      deployments
        .list({ workspace: slug, slug: project.slug }, viewer)
        .then((result) => (result.ok ? { slug: project.slug, deployments: result.value.deployments } : null))
        .catch(warn(`deploys of ${project.slug}`)),
    ),
  );
  const projects = lists.filter((entry) => entry != null);
  return { overview: overview.value, projects, complete: projects.length === recent.length };
}

/**
 * The span's spend from the statements of the months it touches, and the
 * month so far from the usage report Usage reads (`usage.ts` `monthSpan`,
 * at price), so Home's figure is Usage's. Null
 * when billing did not answer; the month alone null when only it did not.
 */
export async function loadSpend(viewer: User, slug: string, span: Pick<Span, "from" | "now">): Promise<Spend | null> {
  const months = spanMonths(span);
  const [statements, month] = await Promise.all([
    Promise.all(months.map((month) => billing.statement(slug, viewer, month, "day").catch(warn(`statement ${month}`)))),
    billing
      .usageReport(slug, viewer, monthSpan(new Date(span.now)))
      .then((result) => (result.ok ? result.value.totals.priceMicros : null))
      .catch(warn("month usage")),
  ]);
  if (statements.some((statement) => !statement?.ok)) return null;
  return spendIn(
    statements.map((statement) => (statement as Extract<typeof statement, { ok: true }>).value),
    span,
    month,
  );
}

/** The most projects whose pushes to the default branch are listed one by one, pushes read per project, and commits read back. */
const MAX_PUSH_PROJECTS = 10;
const PUSHES_READ = 100;
const PUSH_HISTORY = 200;

/**
 * Each person's push to a default branch in the span, for the projects
 * the digest says were pushed to (those pushed to most, at most
 * MAX_PUSH_PROJECTS), with each project's default branch read back from
 * its newest push to place each push's commits. `by` is the pusher's
 * member key, named by the caller. Null when events did not answer.
 */
export async function loadDirectPushes(
  viewer: User,
  activity: ActivityDigest | null,
  owned: Repo[] | null,
  span: Pick<Span, "from" | "now">,
): Promise<{ pushes: (Omit<DirectPush, "by"> & { actorKey: string })[]; history: Record<string, Commit[]>; complete: boolean } | null> {
  if (!activity || !owned) return null;
  const byId = new Map(owned.map((repo) => [repo.id, repo]));
  const pushedTo = activity.repos
    .filter((digest) => digest.pushes.default_branch.count > 0 && byId.has(digest.repo_id))
    .sort((a, b) => b.pushes.default_branch.count - a.pushes.default_branch.count || a.repo_id.localeCompare(b.repo_id));
  const read = pushedTo.slice(0, MAX_PUSH_PROJECTS);
  const lists = await Promise.all(
    read.map(async (digest) => {
      const repo = byId.get(digest.repo_id)!;
      const log = await events.list({ repoId: repo.id, types: ["git.push"], limit: PUSHES_READ }).catch(warn(`pushes of ${repo.name}`));
      if (!log) return null;
      const pushes = log.filter(
        (event): event is G1tEvent<"git.push"> =>
          event.type === "git.push" && (event as G1tEvent<"git.push">).data.defaultBranch && Date.parse(event.time) >= span.from && Date.parse(event.time) <= span.now,
      );
      if (pushes.length === 0) return { repo, pushes, history: [] as Commit[] };
      const path = { namespace: repo.namespace, name: repo.name };
      const history = await repos.log(path, viewer, pushes[0]!.data.after, PUSH_HISTORY).catch(warn(`history of ${repo.name}`));
      return { repo, pushes, history: history?.ok ? history.value : [] };
    }),
  );
  const pushes: (Omit<DirectPush, "by"> & { actorKey: string })[] = [];
  const history: Record<string, Commit[]> = {};
  for (const entry of lists) {
    if (!entry) continue;
    history[entry.repo.id] = entry.history;
    const ref: RepoRef = { namespace: entry.repo.namespace, name: entry.repo.name, defaultBranch: entry.repo.defaultBranch };
    for (const event of entry.pushes) {
      pushes.push({
        repoId: entry.repo.id,
        repo: ref,
        push: { id: event.id, time: event.time, actor: event.actor ?? null, data: event.data },
        actorKey: event.actor ? deployActorKey(event.actor) ?? "" : "",
      });
    }
  }
  return { pushes, history, complete: lists.every((entry) => entry != null) && pushedTo.length <= MAX_PUSH_PROJECTS };
}

/**
 * Whether each merge and push that landed went live, from deployments'
 * record of what each production deployment shipped. Null when
 * deployments did not answer.
 */
export async function loadShipped(viewer: User, slug: string, rows: LandedChange[]): Promise<ShippedRepo[] | null> {
  const asks = shippedAsks(rows).slice(0, 20);
  if (asks.length === 0) return [];
  const answer = await deployments.shipped(slug, viewer, asks).catch(warn("shipped"));
  return answer?.ok ? answer.value : null;
}

/** The harness sessions tied to each merged pull request, per project; null when work did not answer for any. */
export async function loadPullSessions(viewer: User, pulls: CodePull[]): Promise<{ repo: RepoPath; pulls: PullSessions[] }[] | null> {
  const byRepo = new Map<string, { repo: RepoPath; numbers: number[] }>();
  for (const pull of pulls) {
    if (pull.status !== "merged") continue;
    const key = `${pull.repo.namespace}/${pull.repo.name}`.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: pull.repo, numbers: [] };
    entry.numbers.push(pull.number);
    byRepo.set(key, entry);
  }
  if (byRepo.size === 0) return [];
  const lists = await Promise.all(
    [...byRepo.values()].slice(0, MAX_PUSH_PROJECTS).map(({ repo, numbers }) =>
      work
        .pullSessions(repo, viewer, numbers.slice(0, 100))
        .then((result) => (result.ok ? { repo, pulls: result.value } : null))
        .catch(warn(`sessions of ${repo.name}`)),
    ),
  );
  const found = lists.filter((entry) => entry != null);
  return found.length === 0 && lists.length > 0 ? null : found;
}

/** Notifications read for what settled by itself in the span. */
const SETTLED_READ = 100;

/** The viewer's notifications done since the span began, newest activity first; null when the inbox did not answer. */
export async function loadSettled(viewer: User, span: Pick<Span, "from">): Promise<InboxItem[] | null> {
  const page = await inbox.list(viewer, { view: "done", limit: SETTLED_READ }).catch(warn("settled notifications"));
  return page ? page.items.filter((item) => item.doneAt != null && Date.parse(item.doneAt) >= span.from) : null;
}

/** How far back Code is read: 7 days before the span, for the comparison. */
export function reachFor(span: Pick<Span, "from">): number {
  return span.from - 7 * DAY;
}
