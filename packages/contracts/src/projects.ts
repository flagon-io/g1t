import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Projects: the thing a workspace builds and runs. A project has exactly
 * one source, where its code lives; everything about running it
 * (deployments, environments, domains, secrets and variables) belongs to
 * the project, while branches, pull requests and review stay with the
 * repository. One repository may carry several projects, each from its own
 * root directory. Every repository on g1t gets a project of its own name.
 */

/** Where a project's code lives. */
export type ProjectSource =
  /** A repository hosted on g1t. */
  | { kind: "hosted"; repoId: string; repo: RepoPath; rootDir: string; defaultBranch: string }
  /** Mirrored from another host; coming next. */
  | { kind: "mirror"; provider: "github" | "gitlab" | "bitbucket"; url: string; rootDir: string };

export type Project = {
  id: string;
  /** The workspace's slug. */
  workspace: string;
  /** Unique in its workspace; the project's address is `g1t.sh/<workspace>/<slug>`. */
  slug: string;
  name: string;
  description: string | null;
  source: ProjectSource;
  /** Whether its repository is private: only people with a role on it can see it. */
  private: boolean;
  /** Whether its repository is archived: read-only, kept for reference. */
  archived: boolean;
  /** Whether it is the project its repository's workflows read secrets from. */
  primary: boolean;
  createdBy: string;
  /** RFC 3339. */
  createdAt: string;
  updatedAt: string;
};

export type NewProject = {
  name: string;
  description?: string | null;
  /** The hosted repository it builds from. */
  repo: RepoPath;
  /** Where in the repository it lives; empty for the whole repository. */
  rootDir?: string;
};

/** One end of a dependency, as a page shows it. */
export type DependencyLink = {
  slug: string;
  name: string;
  /** The variable carrying the other project's address, such as `API_URL`. */
  as: string | null;
  /** Declared on the site, or in the project's `.g1t/project.yml`. */
  source: "ui" | "file";
};

/** What a project uses, and what uses it. */
export type Dependencies = { dependsOn: DependencyLink[]; usedBy: DependencyLink[] };

/** A project's dependencies by id, for services. */
export type ProjectGraph = {
  dependsOn: { id: string; slug: string; workspace: string; as: string | null }[];
  usedBy: { id: string; slug: string; workspace: string; as: string | null }[];
};

export interface ProjectsApi {
  /** A workspace's projects, by name. Members, or anyone for public repositories. */
  list(workspace: string, viewer: Viewer): Promise<Result<Project[]>>;
  get(workspace: string, slug: string, viewer: Viewer): Promise<Result<Project>>;
  /** The projects built from a repository, its primary one first. For services. */
  byRepo(repoId: string): Promise<Project[]>;
  /** Members only. */
  create(actor: User, workspace: string, input: NewProject): Promise<Result<Project>>;
  /** Members only. */
  update(
    actor: User,
    workspace: string,
    slug: string,
    changes: { name?: string; description?: string | null; rootDir?: string },
  ): Promise<Result<Project>>;
  /** What a project uses and what uses it. Whoever may see the project. */
  dependencies(workspace: string, slug: string, viewer: Viewer): Promise<Result<Dependencies>>;
  /**
   * `slug` uses `on`, with `as` the variable that carries `on`'s address.
   * Members only; refused if it would make a cycle.
   */
  addDependency(actor: User, workspace: string, slug: string, on: string, as: string | null): Promise<Result<Dependencies>>;
  /** Members only. A dependency from `.g1t/project.yml` is changed there. */
  removeDependency(actor: User, workspace: string, slug: string, on: string): Promise<Result<Dependencies>>;
  /** For services: a project's dependencies by id. */
  graph(projectId: string): Promise<ProjectGraph>;
}
