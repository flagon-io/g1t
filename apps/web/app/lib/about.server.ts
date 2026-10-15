/**
 * The Files page's About, streamed in after the files: what the default
 * branch says, stars and releases from repos; how many watch it from the
 * inbox; packages published from it; how many tags it has. Each is its own promise, so a slow
 * one holds up only its own section, and a failure stays in its section
 * rather than failing the page: what the default branch says and the
 * packages say they could not be loaded (lib/partial.ts), and the counts
 * of watchers and tags, which only add to a line, are left out.
 */
import type { PackageSummary, RepoAbout, RepoPath, Viewer } from "@g1t/contracts";

import type { AboutData } from "../components/repo-about";
import { type Failed, part } from "./partial";
import { inbox, packages, repos } from "./services.server";

/** How long a section waits before it shows without its answer. */
const WAIT_MS = 4_000;

function within<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS))]);
}

/** Like `within`, but one that fails or does not answer in time is `Failed`, for its section to say so. */
function partWithin<T>(promise: Promise<T>, what: string): Promise<T | Failed> {
  const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${WAIT_MS} ms`)), WAIT_MS));
  return part(Promise.race([promise, late]), what);
}

export function aboutOf(path: RepoPath, viewer: Viewer): Promise<RepoAbout | null> {
  return repos.about(path, viewer).then((found) => (found.ok ? found.value : null));
}

export function aboutFor(path: RepoPath, viewer: Viewer, repoId: string): AboutData {
  return {
    about: partWithin(aboutOf(path, viewer), "Releases, contributors and languages"),
    watchers: within(inbox.watchers(repoId)),
    packages: partWithin(
      packages.list(path.namespace, viewer, { repoId }).then((found): PackageSummary[] | null => (found.ok ? found.value : null)),
      "Packages",
    ),
    tags: within(repos.tags(path, viewer).then((found) => (found.ok ? found.value.length : null))),
  };
}
