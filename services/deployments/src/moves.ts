/**
 * Apps whose project moved: its workspace was renamed, or its repository
 * renamed or transferred, so each app's name (`<project>-<workspace>`, or
 * `<project>-git-<branch>-<workspace>`) is not the one it has now. Each is
 * built again under its new name, from the commit it serves; once that is
 * live, the old name redirects to it.
 *
 * What is stale is read from the rows as they are, not from the event that
 * moved them, so a second delivery, a late one, or the sweep after a
 * rebuild that could not start all end the same: the work left is found
 * and done, and what is done is not done twice.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

export type MoveKind = "production" | "preview";

/** An app row, as far as a move needs it. */
export type MovedApp = {
  script: string;
  project_id: string;
  kind: MoveKind;
  branch: string | null;
  number: number | null;
  commit_sha: string;
  deployed_at: string;
};

/** A build a move dropped (it was under way under the old name). */
export type DroppedBuild = {
  project_id: string;
  kind: MoveKind;
  branch: string | null;
  number: number | null;
  commit_sha: string;
  created_at: string;
};

/** One app to build again under its new name, and the old names it replaces. */
export type MoveTarget = {
  projectId: string;
  kind: MoveKind;
  branch: string | null;
  number: number | null;
  commit: string;
  /** The app's scripts under older names, to redirect once the new one is live. */
  from: string[];
};

/** Production, or one branch's preview, of a project: one app, whatever it is called. */
export function appKey(row: { project_id: string; kind: MoveKind; branch: string | null }): string {
  return `${row.project_id}/${row.kind}/${row.branch ?? ""}`;
}

/**
 * What to build again: one target per app, from its stale rows and the
 * builds a move dropped. The newest commit wins, so a build that was under
 * way (newer than what was up) is the one built again.
 */
export function moveTargets(stale: MovedApp[], dropped: DroppedBuild[] = []): MoveTarget[] {
  const targets = new Map<string, MoveTarget & { at: string }>();
  const consider = (key: string, at: string, row: Omit<MoveTarget, "from">, script: string | null) => {
    const found = targets.get(key);
    if (!found) {
      targets.set(key, { ...row, from: script ? [script] : [], at });
      return;
    }
    if (script && !found.from.includes(script)) found.from.push(script);
    if (at > found.at) Object.assign(found, { commit: row.commit, number: row.number ?? found.number, at });
  };
  for (const app of stale) {
    const { project_id: projectId, kind, branch, number, commit_sha: commit } = app;
    consider(appKey(app), app.deployed_at, { projectId, kind, branch, number, commit }, app.script);
  }
  for (const build of dropped) {
    const { project_id: projectId, kind, branch, number, commit_sha: commit } = build;
    consider(appKey(build), build.created_at, { projectId, kind, branch, number, commit }, null);
  }
  return [...targets.values()].map(({ at: _at, ...target }) => target);
}

/** What asking for a rebuild came to. */
export type RebuildOutcome =
  /** A build is queued or under way under the new name. */
  | "queued"
  /** It was asked for and refused, or failed to reach a sandbox: try again later. */
  | "failed"
  /** Nothing to build: deployments are off for it, or its pull request is closed. */
  | "none";

/**
 * Reads what starting a rebuild returned: a deployment (queued, or one
 * that was skipped or failed at once), nothing to build, or an error.
 */
export function rebuildOutcome(started: { ok: true; value: { status: string } } | { ok: false } | null): RebuildOutcome {
  if (started == null) return "none";
  if (!started.ok) return "failed";
  return started.value.status === "queued" || started.value.status === "building" ? "queued" : "failed";
}

/** Whether a rebuild last tried at `lastTriedAt` may be tried again at `now`. */
export function retryDue(lastTriedAt: string | null, now: number, afterMs: number): boolean {
  return lastTriedAt == null || Date.parse(lastTriedAt) + afterMs <= now;
}

/**
 * The workspace an app belongs to: its project's, as deployments has it
 * now, falling back to the app row's own when the project is unknown. An
 * app left under its old name after a move is the new workspace's; limits
 * and plans are checked there, never against the workspace it moved from.
 */
export function ownerOf(app: { project_id: string; workspace: string }, owners: Map<string, string>): string {
  return owners.get(app.project_id) ?? app.workspace;
}
