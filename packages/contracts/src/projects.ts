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
  /** Whether only the workspace's members can see it: its repository is private. */
  private: boolean;
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
}
