/**
 * A project's docs in Docs: a repository's `docs/` folder and its
 * README.md, read from the default branch into D1 so the sidebar lists
 * them and search finds them beside the workspace's pages. Read when the
 * folder is added, and again on every push to the default branch
 * (src/staleness.ts `onEvent`); only files whose blob changed are read
 * again. Read-only here: changes go through the repository.
 *
 * Who sees one is decided when it is read: the viewer must be able to read
 * the repository (`ReposApi.readable`), whoever added it.
 */
import { reposClient, type ServiceBinding } from "@g1t/contracts";

import { searchText } from "./markdown.ts";
import { pickRepoDocs, repoDocTitle } from "./repo-docs.ts";

export { isRepoDoc, pickRepoDocs, repoDocTitle } from "./repo-docs.ts";

/** A file larger than this is listed but not read. */
const MAX_FILE_BYTES = 512 * 1024;

export type RepoSpaceRow = {
  id: string;
  workspace_id: string;
  repo_id: string;
  repo: string;
  default_branch: string;
  commit_sha: string | null;
  indexed_at: string | null;
  added_by: string;
  added_at: string;
};

function decodeBase64(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a repository's docs again into one space: lists the default
 * branch, reads the files whose blob changed, drops the ones gone. Asks
 * repos without a viewer (`listFiles`, `rawBlobs`), so callers check the
 * repository can be read first, as adding one does.
 */
export async function indexRepoSpace(env: { DB: D1Database; REPOS: ServiceBinding }, space: RepoSpaceRow, now = new Date()): Promise<{ files: number; read: number }> {
  const db = env.DB;
  const repos = reposClient(env.REPOS);
  const listing = await repos.listFiles(space.repo_id, null, 10_000);
  const wanted = pickRepoDocs(listing.files.filter((f): f is { path: string; hash: string } => !!f.hash));
  const kept = new Map(
    (await db.prepare("SELECT path, hash FROM repo_files WHERE space_id = ?").bind(space.id).all<{ path: string; hash: string }>()).results.map((r) => [r.path, r.hash]),
  );
  const changed = wanted.filter((f) => kept.get(f.path) !== f.hash);
  const blobs = new Map<string, string | null>();
  for (let i = 0; i < changed.length; i += 100) {
    const batch = changed.slice(i, i + 100);
    for (const blob of await repos.rawBlobs(space.repo_id, [...new Set(batch.map((f) => f.hash))], MAX_FILE_BYTES)) blobs.set(blob.hash, blob.data);
  }
  const statements: D1PreparedStatement[] = [];
  const gone = [...kept.keys()].filter((path) => !wanted.some((f) => f.path === path));
  for (const path of gone) {
    statements.push(db.prepare("DELETE FROM repo_files WHERE space_id = ? AND path = ?").bind(space.id, path));
    statements.push(db.prepare("DELETE FROM repo_files_fts WHERE space_id = ? AND path = ?").bind(space.id, path));
  }
  for (const file of changed) {
    const data = blobs.get(file.hash);
    const markdown = data ? decodeBase64(data) : `_This file is too large to show here._ Open it in Code.\n`;
    const title = repoDocTitle(file.path, markdown);
    statements.push(
      db
        .prepare("INSERT INTO repo_files (space_id, path, hash, title, markdown) VALUES (?, ?, ?, ?, ?) ON CONFLICT (space_id, path) DO UPDATE SET hash = excluded.hash, title = excluded.title, markdown = excluded.markdown")
        .bind(space.id, file.path, file.hash, title, markdown),
    );
    statements.push(db.prepare("DELETE FROM repo_files_fts WHERE space_id = ? AND path = ?").bind(space.id, file.path));
    statements.push(db.prepare("INSERT INTO repo_files_fts (space_id, path, title, body) VALUES (?, ?, ?, ?)").bind(space.id, file.path, title, searchText(markdown)));
  }
  statements.push(db.prepare("UPDATE repo_spaces SET commit_sha = ?, indexed_at = ? WHERE id = ?").bind(listing.commit, now.toISOString(), space.id));
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return { files: wanted.length, read: changed.length };
}

/** Every space showing a repository's docs, read again after a push. Never throws for one space's sake. */
export async function reindexRepo(env: { DB: D1Database; REPOS: ServiceBinding }, repoId: string): Promise<void> {
  const spaces = (await env.DB.prepare("SELECT * FROM repo_spaces WHERE repo_id = ?").bind(repoId).all<RepoSpaceRow>()).results;
  for (const space of spaces) {
    try {
      await indexRepoSpace(env, space);
    } catch (error) {
      console.error("docs could not read a project's docs", space.repo, String(error));
    }
  }
}
