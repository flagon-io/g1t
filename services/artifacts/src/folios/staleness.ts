/**
 * Folios that cite code a change touched become possibly out of date, as
 * Docs' pages do (src/staleness.ts, which calls this with the same change
 * after recording pages). Once per folio and commit; the owner hears of
 * it (which change, only if they can read the repository); open rooms
 * ask their readers to look again; `folio.stale` goes out with a title
 * only when the whole workspace can read the folio.
 */
import { identityClient, notifyClient, reposClient, type User } from "@g1t/contracts";

import { touchedPaths } from "../citations.ts";
import type { Change, StaleEnv } from "../staleness.ts";
import { slugOf } from "./list.ts";
import { workspaceReadable } from "./access-store.ts";
import { publishFolioEvent } from "./events.ts";
import type { FolioRoom } from "./room.ts";

export type FolioStaleEnv = StaleEnv & { FOLIOS?: DurableObjectNamespace<FolioRoom> };

/** Whether any live folio cites the repository. */
export async function foliosCite(db: D1Database, repo: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS yes FROM folio_citations c JOIN folios f ON f.id = c.folio_id WHERE c.repo = ? AND f.trashed_at IS NULL LIMIT 1").bind(repo).first<{ yes: number }>();
  return !!row;
}

/** Records a change against every folio whose citations it touches; returns the folios newly made stale. */
export async function recordFolioChanges(env: FolioStaleEnv, change: Change, now = new Date()): Promise<string[]> {
  const db = env.DB;
  const cited = (
    await db
      .prepare("SELECT c.folio_id, c.path FROM folio_citations c JOIN folios f ON f.id = c.folio_id WHERE c.repo = ? AND f.trashed_at IS NULL")
      .bind(change.repo)
      .all<{ folio_id: string; path: string }>()
  ).results;
  const byFolio = new Map<string, { path: string }[]>();
  for (const row of cited) byFolio.set(row.folio_id, [...(byFolio.get(row.folio_id) ?? []), row]);
  const fresh: string[] = [];
  const hits = new Map<string, string[]>();
  for (const [folioId, rows] of byFolio) {
    const touched = touchedPaths(rows, change.changed);
    if (!touched.length) continue;
    hits.set(folioId, touched);
    const [inserted] = await db.batch<{ folio_id: string }>([
      db
        .prepare(
          "INSERT INTO folio_changes (folio_id, repo, repo_id, commit_sha, pull_number, pull_title, paths, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (folio_id, repo, commit_sha) DO NOTHING RETURNING folio_id",
        )
        .bind(folioId, change.repo, change.repo_id, change.commit, change.pull?.number ?? null, change.pull?.title ?? null, JSON.stringify(touched), now.toISOString()),
      ...(change.pull
        ? [db.prepare("UPDATE folio_changes SET pull_number = ?, pull_title = ? WHERE folio_id = ? AND repo = ? AND commit_sha = ?").bind(change.pull.number, change.pull.title, folioId, change.repo, change.commit)]
        : []),
    ]);
    if (inserted?.results.length) fresh.push(folioId);
  }
  if (fresh.length) await tellOf(env, change, fresh, hits);
  return fresh;
}

type Row = { id: string; workspace_id: string; kind: "doc" | "slides" | "design" | "dashboard"; space_id: string | null; title: string; owner: string };

async function tellOf(env: FolioStaleEnv, change: Change, ids: string[], hits: Map<string, string[]>): Promise<void> {
  const db = env.DB;
  const rows = (await db.prepare("SELECT id, workspace_id, kind, space_id, title, owner FROM folios WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>()).results;
  const slugs = await identityClient(env.IDENTITY)
    .usernames([...new Set(rows.map((r) => r.workspace_id))])
    .catch(() => ({}) as Record<string, string>);
  const ownerIds = [...new Set(rows.map((r) => r.owner).filter((k) => k.startsWith("user:")).map((k) => k.slice(5)))];
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
  for (const row of rows) {
    const slug = slugs[row.workspace_id];
    if (!slug) continue;
    const href = `/${slug}/-/artifacts/${slugOf(row.title, row.id)}`;
    const paths = hits.get(row.id) ?? [];
    const work: Promise<unknown>[] = [];
    if (notify && row.owner.startsWith("user:")) {
      const id = row.owner.slice(5);
      const known = canRead.has(id);
      work.push(
        notify
          .notify(
            { user_id: id },
            {
              id: `folio-stale:${row.id}:${change.commit}:${id}`,
              kind: "inbox",
              workspace: slug,
              title: `${row.title || "Untitled"} may be out of date`,
              body: known ? `${what} changed ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}` : "A change to code this cites was merged.",
              href,
              actor: { kind: "system", id: "g1t", name: "g1t", avatar: null, avatar_seed: null },
              created_at: new Date().toISOString(),
            },
          )
          .catch(() => undefined),
      );
    }
    if (env.FOLIOS) {
      work.push(
        env.FOLIOS.get(env.FOLIOS.idFromName(row.id))
          .notice({ type: "folio.staleness" })
          .catch(() => undefined),
      );
    }
    const open = await workspaceReadable(db, row.id).catch(() => false);
    work.push(
      publishFolioEvent(
        env.EVENTS,
        "folio.stale",
        {
          workspace: slug,
          workspaceId: row.workspace_id,
          folioId: row.id,
          kind: row.kind,
          spaceId: row.space_id,
          title: open ? row.title : null,
          repo: change.repo,
          commit: change.commit,
          pull: change.pull?.number ?? null,
          paths,
          owners: [row.owner],
        },
        change.actor ? `user:${change.actor}` : null,
      ),
    );
    await Promise.all(work);
  }
}
