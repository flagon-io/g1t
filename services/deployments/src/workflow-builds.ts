/**
 * Builds opened from a g1t Actions job (`start_from_workflow`): who may
 * open one, what the run builds, and whether it is trusted with the
 * project's build secrets. Pure, so it is tested apart from the service.
 *
 * The job builds in its own checkout and pays for its own time; the
 * service only opens the build (its row, its token, the commit's status
 * and what the project's settings give it) and puts what the job sends.
 */

import { isManagedWorkflow, tokenAllows, type RepoPath, type User } from "@g1t/contracts";

/** The run a job token was made for, as far as these rules read it. */
export type RunFacts = {
  event: string;
  ref: string;
  sha: string;
  pull: number | null;
  status: string;
};

/** What a run deploys: production, a branch's preview, or a pull request's (its branch looked up). */
export type RunTarget = { kind: "production" } | { kind: "branch"; branch: string } | { kind: "pull"; number: number } | { error: string };

/** Why a token that cannot write deployments is refused, where nothing lets it through. */
export const NEEDS_WRITE = "The job's token needs `deployments: write` in the workflow's or job's `permissions:`.";

/**
 * The run and job a caller's token was made for, if it is a workflow job's
 * token for `repo`; otherwise why not. `writes` says whether it may write
 * deployments: one that may not is let through only by `readOnlyAllowed`.
 */
export function jobOf(actor: User | null | undefined, repo: RepoPath): { runId: string; jobId: string; writes: boolean } | { error: string } {
  const token = actor?.token;
  if (!token?.job?.run_id || !token.job.job_id) {
    return { error: "Only a g1t Actions job's token (G1T_TOKEN) can open a g1t.page build." };
  }
  const own = `${repo.namespace}/${repo.name}`.toLowerCase();
  if (!token.repo || token.repo.toLowerCase() !== own) {
    return { error: `This job's token is for ${token.repo ?? "another repository"}, not ${repo.namespace}/${repo.name}.` };
  }
  return { runId: token.job.run_id, jobId: token.job.job_id, writes: tokenAllows(token.scopes, "deployments:write") };
}

/**
 * Whether a job whose token may not write deployments may still open a
 * build: only a preview, from the deploy workflow g1t manages for the
 * project (a run of `managed/…`). A pull request from a fork runs with a
 * read-only token, as on GitHub, and still gets the preview g1t.page has
 * always built for it, without the project's build secrets.
 */
export function readOnlyAllowed(run: { path?: string | null }, target: RunTarget): boolean {
  return isManagedWorkflow(run.path ?? "") && "kind" in target && target.kind !== "production";
}

/**
 * What a run builds. A run for a pull request builds that pull request's
 * preview; a run on the project's production branch (a push, a dispatch
 * or a schedule there) builds production; a run on any other branch
 * builds that branch's preview. A tag deploys nothing: give the branch.
 */
export function targetOf(run: Pick<RunFacts, "event" | "ref" | "pull">, productionBranch: string): RunTarget {
  if (run.pull != null && run.event.startsWith("pull_request")) return { kind: "pull", number: run.pull };
  const ref = run.ref.trim();
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref.startsWith("refs/") ? null : ref;
  if (!branch) {
    return { error: `This run is for ${ref || "no ref"}: g1t.page deploys branches and pull requests. Run the workflow on a branch.` };
  }
  return branch === productionBranch ? { kind: "production" } : { kind: "branch", branch };
}

/**
 * Whether a run's build gets the project's build secrets: never for a
 * pull request from a fork, one whose author could not push here, or a
 * run that had to be approved to start. A run on a branch of the
 * repository is trusted: only people who can push make one.
 */
export function runTrusted(input: {
  approval: { state: string } | null | undefined;
  pull: { fork?: RepoPath | null } | null;
  /** Whether whoever the pull request is for can push to the repository. */
  insider: boolean;
}): boolean {
  if (input.approval) return false;
  if (input.pull) return !input.pull.fork && input.insider;
  return true;
}

/** The commit to build: the one given (a whole or abbreviated hex id), else the run's. */
export function commitOf(given: unknown, run: Pick<RunFacts, "sha">): string | { error: string } {
  if (given == null || given === "") return run.sha;
  if (typeof given !== "string" || !/^[0-9a-f]{7,64}$/i.test(given.trim())) {
    return { error: "`sha` is a commit's id, in hex." };
  }
  return given.trim().toLowerCase();
}

/**
 * Why a build its workflow job left open failed, from how the job ended
 * (its conclusion: `cancelled`, `failure`, `success`, …).
 */
export function jobEndedMessage(conclusion: string): string {
  switch (conclusion) {
    case "cancelled":
      return "The workflow job was cancelled before the build finished.";
    case "failure":
      return "The workflow job failed before the build finished.";
    case "timed_out":
      return "The workflow job timed out before the build finished.";
    default:
      return "The workflow job ended without finishing the build.";
  }
}

/**
 * The project to build: the one named, or the repository's one project
 * with Deployments on when none is named.
 */
export function projectNamed<P extends { slug: string }>(
  projects: P[],
  enabled: (project: P) => boolean,
  slug: string | null | undefined,
): P | { error: string; code: "not_found" | "invalid" | "conflict" } {
  const wanted = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  if (wanted) {
    return projects.find((p) => p.slug.toLowerCase() === wanted) ?? { error: `This repository has no project ${wanted}.`, code: "not_found" };
  }
  const on = projects.filter(enabled);
  if (on.length === 1) return on[0];
  if (on.length === 0) return { error: "No project of this repository has Deployments on.", code: "conflict" };
  return { error: `Name the project to build: ${on.map((p) => p.slug).join(", ")}.`, code: "invalid" };
}

/**
 * What `start_from_workflow` answers, in `snake_case` as the API sends it:
 * the build's id and token for `g1t-runner deploy`, what it is, where it
 * will be served, and what the project gives its build.
 */
export type WorkflowBuild = {
  deploy_id: string;
  /** For this build alone, until it finishes: `DEPLOY_TOKEN`. */
  token: string;
  kind: "production" | "preview";
  project: string;
  branch: string | null;
  number: number | null;
  commit: string;
  /** The app's address on g1t.page. */
  url: string;
  /** Whether the build got the project's build secrets. */
  trusted: boolean;
  /** The project's settings, for a build that names none of its own. */
  root_dir: string;
  build_command: string | null;
  output_dir: string | null;
  /** What it is built as (`auto`, `static`, `workers` or `docker`), and its Dockerfile's path when set. */
  build_as: string;
  dockerfile: string | null;
  /** The variables builds of this kind get. */
  build_env: Record<string, string>;
  /** The secrets builds of this kind get; empty for an untrusted run. */
  build_secrets: Record<string, string>;
};
