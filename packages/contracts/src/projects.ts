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
  /** The project's own description, or its repository's while it has none. */
  description: string | null;
  /** Whether `description` is its repository's, following it as it changes. */
  descriptionInherited: boolean;
  source: ProjectSource;
  /** Whether its repository is private: only people with a role on it can see it. */
  private: boolean;
  /** Whether its repository is archived: read-only, kept for reference. */
  archived: boolean;
  /** Whether it is the project its repository's workflows read secrets from. */
  primary: boolean;
  /** Whether it deploys, as set in its settings: `auto` decides from the project itself. */
  deploys: DeploysSetting;
  /** What it is, from `deploys`, or for `auto` from its deployments, packages and files. */
  kind: ProjectKind;
  /** Why it is that kind. */
  kindReason: KindReason;
  /** What `auto` decides, whatever the setting is, to show beside it. */
  detected: { kind: ProjectKind; reason: KindReason };
  /** The ecosystem its files say it publishes to, for how to publish; null when none says. */
  ecosystem: ProjectEcosystem | null;
  createdBy: string;
  /** RFC 3339. */
  createdAt: string;
  updatedAt: string;
};

/** Whether a project deploys: decided from the project, or set by a person. */
export type DeploysSetting = "auto" | "yes" | "no";

/**
 * An app deploys and gets production, previews and domains; a library (or
 * a tool) is published and installed, so its pages offer releases and
 * packages instead.
 */
export type ProjectKind = "app" | "library";

/**
 * What decided the kind: the setting, Deployments being on, a package its
 * repository publishes, its files, or nothing (an app, by default).
 * `detail` says it in a sentence.
 */
export type KindReason = { by: "set" | "deployments" | "packages" | "files" | "default"; detail: string };

/** Where a library's files say it is published. */
export type ProjectEcosystem = "composer" | "npm" | "cargo" | "go" | "python";

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
  /** Members only. A null or blank description goes back to the repository's. */
  update(
    actor: User,
    workspace: string,
    slug: string,
    changes: { name?: string; description?: string | null; rootDir?: string; deploys?: DeploysSetting },
  ): Promise<Result<Project>>;
  /** For deployments: Deployments were turned on or off for the project. */
  deploymentsChanged(projectId: string, enabled: boolean): Promise<void>;
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
