import type { Project, Result, Viewer } from "@g1t/contracts";

import { shortCache } from "./cache.server";
import { projects } from "./services.server";

/** How long one isolate keeps a person's list of a workspace's projects. */
export const PROJECTS_TTL_MS = 15_000;

/**
 * A workspace's projects as the viewer may see them: one listing, kept for
 * a few seconds per person and workspace (lib/cache.server.ts), so the
 * sidebar, the workspace's tabs and its Projects page share it.
 */
export function workspaceProjects(slug: string, viewer: Viewer): Promise<Result<Project[]>> {
  const workspace = slug.toLowerCase();
  return shortCache(`shell:projects:${viewer?.id ?? "visitor"}:${workspace}`, PROJECTS_TTL_MS, () => projects.list(workspace, viewer));
}

/** What a project is in the sidebar and the command palette. */
export function shortcutOf(project: Project): { namespace: string; name: string; title: string; isPrivate: boolean } {
  return { namespace: project.workspace, name: project.slug, title: project.name, isPrivate: project.private };
}
