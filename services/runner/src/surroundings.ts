/**
 * What an agent run may be told about the projects around its repository:
 * only those the person it acts for can read. Someone who reads every
 * repository in the workspace is told of all of them; anyone else (a member
 * whose base permission is None, an outside collaborator) of the projects
 * the projects service lists for them.
 *
 * Only type imports, so it can be tested on its own.
 */

export type Neighbour = { slug: string; as: string | null };

export type ProjectSurroundings = {
  slug: string;
  name: string;
  dependencies: { dependsOn: Neighbour[]; usedBy: Neighbour[] };
};

/** `projects` with the neighbours not in `visible` left out; null `visible` reads everything. */
export function readableSurroundings(projects: ProjectSurroundings[], visible: Set<string> | null): ProjectSurroundings[] {
  if (!visible) return projects;
  const keep = (list: Neighbour[]) => list.filter((neighbour) => visible.has(neighbour.slug.toLowerCase()));
  return projects.map((project) => ({
    ...project,
    dependencies: { dependsOn: keep(project.dependencies.dependsOn), usedBy: keep(project.dependencies.usedBy) },
  }));
}
