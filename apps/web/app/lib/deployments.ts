/**
 * Builds as the deployments pages show them: why one failed, in plain
 * words, and a run of the same failure as one row.
 */
import type { Deployment } from "@g1t/contracts";

/** What git says when the commit asked for is not in the repository (as services/deployments/src/retries.ts). */
const MISSING_COMMIT = /reference is not a tree|not our ref|bad object|unknown revision|no such commit/i;

/**
 * Why a build failed or was skipped, as the page says it. A commit that is
 * gone (force-pushed over, or its branch deleted) is said plainly; older
 * builds still carry git's own words, which stay in the build log.
 */
export function buildError(build: Pick<Deployment, "kind" | "number" | "error">): string | null {
  if (!build.error || !MISSING_COMMIT.test(build.error)) return build.error;
  if (build.kind === "preview" && build.number != null) {
    return `This pull request's commit no longer exists. Push again, or close pull request #${build.number}.`;
  }
  if (build.kind === "preview") return "This branch's commit no longer exists. Push to the branch again.";
  return "This commit no longer exists in the repository. Push to the default branch again.";
}

/** A build, and how many times in a row before it its app failed the same way. */
export type BuildGroup<T> = {
  /** The newest of them, the one the row links to. */
  build: T;
  /** 1 for a build on its own. */
  count: number;
  /** When the oldest of them started. */
  firstAt: string;
};

/** The app a build is for: production, or one branch's preview. */
const appOf = (build: Pick<Deployment, "kind" | "branch">) => `${build.kind}/${build.branch ?? ""}`;

/**
 * Folds each run of identical failures of one app (production, or one
 * branch's preview), newest first as listed, into the row of its newest:
 * the same error, with no other outcome for that app in between. Builds
 * of other apps between them do not break the run; any other build of
 * the same app does.
 */
export function groupBuilds<T extends Pick<Deployment, "kind" | "branch" | "number" | "status" | "error" | "createdAt">>(
  builds: T[],
): BuildGroup<T>[] {
  const groups: BuildGroup<T>[] = [];
  // Each app's run still open, by the error it failed with.
  const open = new Map<string, { group: BuildGroup<T>; error: string | null }>();
  for (const build of builds) {
    const app = appOf(build);
    const run = open.get(app);
    const error = buildError(build);
    if (build.status === "failed" && run && run.error === error) {
      run.group.count++;
      run.group.firstAt = build.createdAt;
      continue;
    }
    const group = { build, count: 1, firstAt: build.createdAt };
    groups.push(group);
    if (build.status === "failed") open.set(app, { group, error });
    else open.delete(app);
  }
  return groups;
}
