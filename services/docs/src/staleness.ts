/**
 * Pages that cite code a change touched become possibly out of date
 * (docs/WORKSPACE.md, "Agents and docs"). The events service sends this
 * service `git.push` and `pull.merged` (`SUBSCRIBER_DOCS`,
 * crates/contracts subscribers.rs), and the lifecycle events every
 * subscriber hears.
 *
 * - **What changed** is asked as g1t itself (a system viewer in the
 *   repository's workspace): a merged pull request's files from the work
 *   service, or a push's from comparing it with where the branch was.
 *   Only pushes to the default branch count.
 * - **Cheap when nothing cites the repository:** the citations table is
 *   asked first, and nothing else is.
 * - **Once per page and commit:** a merge is told twice (the push and the
 *   pull request); both land on one row, which the pull request names.
 *   Owners hear of it once, and `doc.page.stale` is published once.
 * - **Privacy:** what is stored is the change itself; what a reader sees
 *   of it (the page, its banner, the inbox) is filtered by whether they can
 *   read the repository.
 */
import {
  currentMovedPath,
  identityClient,
  notifyClient,
  repoMove,
  reposClient,
  staleMovedPaths,
  workClient,
  type G1tEvent,
  type ServiceBinding,
  type User,
} from "@g1t/contracts";

import { touchedPaths } from "./citations.ts";
import type { PageRoom } from "./room.ts";
import { publishDocEvent } from "./events.ts";
import { pageSlug } from "./slugs.ts";

export type StaleEnv = {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  REPOS?: ServiceBinding;
  WORK?: ServiceBinding;
  NOTIFY?: ServiceBinding;
  EVENTS?: ServiceBinding;
  PAGES?: DurableObjectNamespace<PageRoom>;
};

/** What a change touched, as this module records it. */
export type Change = {
  repo: string;
  repo_id: string;
  commit: string;
  pull: { number: number; title: string | null } | null;
  /** Every path the change touched. */
  changed: string[];
  /** Who made it (an account id), for the events it causes. */
  actor: string | null;
};

/** g1t itself, reading in a repository's workspace: how staleness asks what changed. */
export function systemReader(namespace: string): User {
  return { id: "g1t", username: "g1t", kind: "system", verified: true, workspaces: [{ slug: namespace.toLowerCase(), role: "owner" }] };
}

const ZERO = /^0+$/;

async function pathById(repos: ServiceBinding, id: string): Promise<{ namespace: string; name: string } | null> {
  const response = await repos.fetch("https://service/rpc/path_by_id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  if (!response.ok) return null;
  return (await response.json()) as { namespace: string; name: string } | null;
}

/** Whether any live page cites the repository, or any workspace shows its docs. */
async function interested(db: D1Database, repo: string, repoId: string): Promise<{ cited: boolean; spaces: boolean }> {
  const [cited, spaces] = await db.batch<{ yes: number }>([
    db.prepare("SELECT 1 AS yes FROM citations c JOIN pages p ON p.id = c.page_id WHERE c.repo = ? AND p.archived_at IS NULL LIMIT 1").bind(repo),
    db.prepare("SELECT 1 AS yes FROM repo_spaces WHERE repo_id = ? LIMIT 1").bind(repoId),
  ]);
  return { cited: !!cited?.results.length, spaces: !!spaces?.results.length };
}

/** What a push to the default branch changed: the files between where it was and where it is. */
async function pushChange(env: StaleEnv, path: { namespace: string; name: string }, repoId: string, before: string | undefined, after: string): Promise<string[] | null> {
  if (!env.REPOS || !before || ZERO.test(before)) return null;
  const compared = await reposClient(env.REPOS).compare(repoId, systemReader(path.namespace), before, after);
  if (!compared.ok) return null;
  return compared.value.files.map((f) => f.path);
}

/** What a merged pull request changed, and its title; null when it didn't merge into the default branch. */
async function pullChange(env: StaleEnv, path: { namespace: string; name: string }, repoId: string, number: number): Promise<{ title: string; changed: string[] } | null> {
  if (!env.WORK || !env.REPOS) return null;
  const reader = systemReader(path.namespace);
  const [found, repo] = await Promise.all([workClient(env.WORK).getPull(path, number, reader), reposClient(env.REPOS).getById(repoId, reader)]);
  if (!found.ok || !repo.ok) return null;
  const pull = found.value.pull;
  if (pull.base && pull.base !== repo.value.defaultBranch) return null;
  let changed = (pull.files ?? []).map((f) => f.path);
  if (!changed.length && pull.mergeBase && pull.headCommit) {
    const compared = await reposClient(env.REPOS).compare(repoId, reader, pull.mergeBase, pull.headCommit);
    if (compared.ok) changed = compared.value.files.map((f) => f.path);
  }
  return { title: pull.title, changed };
}

type CitedRow = { page_id: string; path: string };
type PageRow = { id: string; workspace_id: string; space_id: string; title: string; space_slug: string };

/**
 * Records a change against every page whose citations it touches.
 * Returns the pages newly made stale by it.
 */
export async function record(env: StaleEnv, change: Change, now = new Date()): Promise<string[]> {
  const db = env.DB;
  const cited = (
    await db
      .prepare("SELECT c.page_id, c.path FROM citations c JOIN pages p ON p.id = c.page_id WHERE c.repo = ? AND p.archived_at IS NULL")
      .bind(change.repo)
      .all<CitedRow>()
  ).results;
  const byPage = new Map<string, CitedRow[]>();
  for (const row of cited) byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), row]);
  const fresh: string[] = [];
  const hits = new Map<string, string[]>();
  for (const [pageId, rows] of byPage) {
    const touched = touchedPaths(rows, change.changed);
    if (!touched.length) continue;
    hits.set(pageId, touched);
    const at = now.toISOString();
    const [inserted] = await db.batch<{ page_id: string }>([
      db
        .prepare(
          "INSERT INTO page_changes (page_id, repo, repo_id, commit_sha, pull_number, pull_title, paths, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (page_id, repo, commit_sha) DO NOTHING RETURNING page_id",
        )
        .bind(pageId, change.repo, change.repo_id, change.commit, change.pull?.number ?? null, change.pull?.title ?? null, JSON.stringify(touched), at),
      ...(change.pull
        ? [
            db
              .prepare("UPDATE page_changes SET pull_number = ?, pull_title = ? WHERE page_id = ? AND repo = ? AND commit_sha = ?")
              .bind(change.pull.number, change.pull.title, pageId, change.repo, change.commit),
          ]
        : []),
    ]);
    if (inserted?.results.length) fresh.push(pageId);
  }
  if (fresh.length) await tellOf(env, change, fresh, hits);
  return fresh;
}

/** Owners hear of pages newly stale, rooms ask their readers to look again, and `doc.page.stale` goes out. */
async function tellOf(env: StaleEnv, change: Change, pageIds: string[], hits: Map<string, string[]>): Promise<void> {
  const db = env.DB;
  const marks = pageIds.map(() => "?").join(",");
  const [pages, owners] = await Promise.all([
    db
      .prepare(`SELECT p.id, p.workspace_id, p.space_id, p.title, s.slug AS space_slug FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id IN (${marks})`)
      .bind(...pageIds)
      .all<PageRow>(),
    db.prepare(`SELECT page_id, principal FROM page_owners WHERE page_id IN (${marks})`).bind(...pageIds).all<{ page_id: string; principal: string }>(),
  ]);
  const workspaceIds = [...new Set(pages.results.map((p) => p.workspace_id))];
  const slugs = await identityClient(env.IDENTITY)
    .usernames(workspaceIds)
    .catch(() => ({}) as Record<string, string>);
  // Which owners can read the repository: they are told which change it was.
  const ownerIds = [...new Set(owners.results.filter((o) => o.principal.startsWith("user:")).map((o) => o.principal.slice(5)))];
  const people = ownerIds.length ? await identityClient(env.IDENTITY).usersForAudience(ownerIds).catch(() => [] as User[]) : [];
  const [namespace, name] = change.repo.split("/") as [string, string];
  const canRead = new Set<string>();
  if (env.REPOS) {
    await Promise.all(
      people.map(async (person) => {
        const found = await reposClient(env.REPOS!)
          .get({ namespace, name }, person)
          .catch(() => null);
        if (found?.ok) canRead.add(person.id);
      }),
    );
  }
  const what = change.pull ? `${change.repo}#${change.pull.number}` : `${change.repo}@${change.commit.slice(0, 7)}`;
  const notify = env.NOTIFY ? notifyClient(env.NOTIFY) : null;
  for (const page of pages.results) {
    const slug = slugs[page.workspace_id];
    if (!slug) continue;
    const href = `/${slug}/-/docs/${page.space_slug}/${pageSlug(page.title, page.id)}`;
    const paths = hits.get(page.id) ?? [];
    const keys = owners.results.filter((o) => o.page_id === page.id).map((o) => o.principal);
    const work: Promise<unknown>[] = [];
    if (notify) {
      for (const key of keys.filter((k) => k.startsWith("user:"))) {
        const id = key.slice(5);
        const known = canRead.has(id);
        work.push(
          notify
            .notify(
              { user_id: id },
              {
                id: `doc-stale:${page.id}:${change.commit}:${id}`,
                kind: "inbox",
                workspace: slug,
                title: `${page.title || "Untitled"} may be out of date`,
                body: known ? `${what} changed ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}` : "A change to code this page cites was merged.",
                href,
                actor: { kind: "system", id: "g1t", name: "g1t", avatar: null, avatar_seed: null },
                created_at: new Date().toISOString(),
              },
            )
            .catch(() => undefined),
        );
      }
    }
    if (env.PAGES) {
      work.push(
        env.PAGES.get(env.PAGES.idFromName(page.id))
          .notice({ type: "page.staleness" })
          .catch(() => undefined),
      );
    }
    work.push(
      publishDocEvent(
        env.EVENTS,
        "doc.page.stale",
        {
          workspace: slug,
          workspaceId: page.workspace_id,
          pageId: page.id,
          spaceId: page.space_id,
          title: page.title,
          path: href,
          repoId: change.repo_id,
          repo: change.repo,
          commit: change.commit,
          pull: change.pull?.number ?? null,
          paths,
          owners: keys,
        },
        change.actor ? `user:${change.actor}` : null,
      ),
    );
    await Promise.all(work);
  }
}

/** A repository moved: rows kept under its old path follow it. */
async function followMove(env: StaleEnv, event: G1tEvent): Promise<void> {
  const move = repoMove(event);
  if (!move || !env.REPOS) return;
  const current = (await currentMovedPath(env.REPOS, move)).toLowerCase();
  const stale = staleMovedPaths(move, current).map((p) => p.toLowerCase());
  if (!stale.length) return;
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];
  for (const old of stale) {
    statements.push(
      db.prepare("UPDATE OR IGNORE citations SET repo = ? WHERE repo = ?").bind(current, old),
      db.prepare("UPDATE OR IGNORE page_changes SET repo = ? WHERE repo = ?").bind(current, old),
      db.prepare("UPDATE OR IGNORE page_projects SET repo = ? WHERE repo = ?").bind(current, old),
      db.prepare("UPDATE OR IGNORE space_projects SET repo = ? WHERE repo = ?").bind(current, old),
      db.prepare("UPDATE repo_spaces SET repo = ? WHERE repo_id = ?").bind(current, move.repoId),
    );
  }
  await db.batch(statements);
}

/** One event, as this service acts on it. `reindex` reads a project's docs again (src/repo-spaces.ts). */
export async function onEvent(env: StaleEnv, event: G1tEvent, reindex: (repoId: string, commit: string) => Promise<void>): Promise<void> {
  if (event.type === "repo.renamed" || event.type === "repo.transferred") return followMove(env, event);
  if (event.type === "repo.purged") {
    await env.DB.prepare("DELETE FROM repo_spaces WHERE repo_id = ?").bind(event.data.repoId).run();
    return;
  }
  if (event.type !== "git.push" && event.type !== "pull.merged") return;
  if (!env.REPOS) return;
  const repoId = event.repoId ?? (event.data as { repoId?: string }).repoId ?? null;
  if (!repoId) return;
  if (event.type === "git.push" && !event.data.defaultBranch) return;
  const path = await pathById(env.REPOS, repoId);
  if (!path) return;
  const repo = `${path.namespace}/${path.name}`.toLowerCase();
  const wants = await interested(env.DB, repo, repoId);
  if (event.type === "git.push") {
    if (wants.spaces) await reindex(repoId, event.data.after);
    if (!wants.cited) return;
    const changed = await pushChange(env, path, repoId, event.data.before, event.data.after);
    if (!changed?.length) return;
    await record(env, { repo, repo_id: repoId, commit: event.data.after, pull: null, changed, actor: event.actor });
    return;
  }
  if (!wants.cited) return;
  const pulled = await pullChange(env, path, repoId, event.data.number);
  if (!pulled?.changed.length) return;
  await record(env, { repo, repo_id: repoId, commit: event.data.commit, pull: { number: event.data.number, title: pulled.title }, changed: pulled.changed, actor: event.actor });
}
