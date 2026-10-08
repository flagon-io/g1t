/**
 * The Files page's About, streamed in after the files: what the default
 * branch says, stars and releases from repos; how many watch it from the
 * inbox; packages published from it. Each is its own promise, so a slow
 * one holds up only its own section, and a failure shows the section
 * without it rather than failing the page.
 */
import type { PackageSummary, RepoAbout, RepoPath, Viewer } from "@g1t/contracts";

import type { AboutData } from "../components/repo-about";
import { inbox, packages, repos } from "./services.server";

/** How long a section waits before it shows without its answer. */
const WAIT_MS = 4_000;

function within<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS))]);
}

export function aboutOf(path: RepoPath, viewer: Viewer): Promise<RepoAbout | null> {
  return repos.about(path, viewer).then((found) => (found.ok ? found.value : null));
}

export function aboutFor(path: RepoPath, viewer: Viewer, repoId: string): AboutData {
  return {
    about: within(aboutOf(path, viewer)),
    watchers: within(inbox.watchers(repoId)),
    packages: within(
      packages.list(path.namespace, viewer, { repoId }).then((found): PackageSummary[] | null => (found.ok ? found.value : null)),
    ),
  };
}
