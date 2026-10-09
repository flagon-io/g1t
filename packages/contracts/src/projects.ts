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
  /** What a person set it to be; each part null while it is left to detection. */
  setting: ProjectSetting;
  /** What it is: from `setting`, or for what is left out, from its deployments, packages and files. */
  kind: ProjectKind;
  /** Why it is that kind. */
  kindReason: KindReason;
  /**
   * Where it runs: `g1t` when g1t deploys it (Deployments, on g1t.page),
   * `elsewhere` when it is deployed by other means, at `productionUrl`.
   * Null for what is not deployed (a library, a tool) and for an app nobody
   * has said yet while Deployments are off.
   */
  runs: ProjectRuns | null;
  /** Where production is when it runs elsewhere; null when nobody has given one. */
  productionUrl: string | null;
  /** What detection decides, whatever the setting is, to show beside it. */
  detected: { kind: ProjectKind; reason: KindReason };
  /** The ecosystem its files say it publishes to, for how to publish; null when none says. */
  ecosystem: ProjectEcosystem | null;
  /** Its homepage, docs and other links, shown wherever the project is. */
  links: ProjectLinks;
  createdBy: string;
  /** RFC 3339. */
  createdAt: string;
  updatedAt: string;
  /** RFC 3339: when its repository was last pushed to; null until it is, after projects began keeping it. */
  pushedAt: string | null;
  /**
   * How active it is lately: each push, issue or pull request opened or
   * closed, review, comment and deployment counts one, halving every week.
   * 0 for none.
   */
  activity: number;
};

/**
 * What a project is. An app (or a site) runs somewhere and gets a
 * production card; a library is published and installed; a tool, such as
 * a CLI, ships as releases people install; docs are documentation or site
 * content; other is anything else, such as configuration or research.
 */
export type ProjectKind = "app" | "library" | "tool" | "docs" | "other";

/** Every kind, in the order pages offer them. */
export const PROJECT_KINDS: readonly ProjectKind[] = ["app", "library", "tool", "docs", "other"];

/** Where an app or a site runs: deployed by g1t on g1t.page, or deployed by other means. */
export type ProjectRuns = "g1t" | "elsewhere";

/** What a person set; null for each part left to detection. */
export type ProjectSetting = { kind: ProjectKind | null; runs: ProjectRuns | null };

/** One of a project's own links: a label and an http(s) address. */
export type ProjectLink = { label: string; url: string };

export type ProjectLinks = {
  /** Its homepage: its own, or its repository's website while it has none. */
  homepage: string | null;
  /** Whether `homepage` is its repository's website, following it as it changes. */
  homepageInherited: boolean;
  /** Where its documentation is read. */
  docs: string | null;
  /** Any others, in the order given, at most `MAX_PROJECT_LINKS`. */
  custom: ProjectLink[];
};

/** How many links of its own a project keeps besides its homepage and docs. */
export const MAX_PROJECT_LINKS = 10;
/** The longest link label. */
export const MAX_LINK_LABEL = 40;
/** The longest link address. */
export const MAX_LINK_URL = 255;

/** A change to a project; only what is given changes. */
export type ProjectChanges = {
  name?: string;
  /** Null or blank goes back to the repository's. */
  description?: string | null;
  rootDir?: string;
  /** What it is; `auto` leaves it to detection. Anything but an app or docs stops it running anywhere. */
  kind?: ProjectKind | "auto";
  /** Where it runs; `auto` leaves it to Deployments. Setting it makes it an app unless it is docs. */
  runs?: ProjectRuns | "auto";
  /** Production's address when it runs elsewhere; null or blank clears it. */
  productionUrl?: string | null;
  /** Null or blank goes back to the repository's website. */
  homepage?: string | null;
  /** Null or blank clears it. */
  docsUrl?: string | null;
  /** Replaces its other links. */
  links?: ProjectLink[];
};

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

/**
 * What a person keeps at hand in a workspace: the projects they pinned, in
 * their order, then the ones they opened last that they have not pinned.
 * Only projects they can still see.
 */
export type ProjectShortcuts = { pinned: Project[]; recent: Project[] };

export interface ProjectsApi {
  /** A workspace's projects, by name. Members, or anyone for public repositories. */
  list(workspace: string, viewer: Viewer): Promise<Result<Project[]>>;
  get(workspace: string, slug: string, viewer: Viewer): Promise<Result<Project>>;
  /** The projects built from a repository, its primary one first. For services. */
  byRepo(repoId: string): Promise<Project[]>;
  /** Members only. */
  create(actor: User, workspace: string, input: NewProject): Promise<Result<Project>>;
  /**
   * Members with a role that may change its settings. Making it something
   * that does not run (a library, a tool, other) while Deployments are on
   * is refused: they are turned off first.
   */
  update(actor: User, workspace: string, slug: string, changes: ProjectChanges): Promise<Result<Project>>;
  /** For deployments: Deployments were turned on or off for the project. */
  deploymentsChanged(projectId: string, enabled: boolean): Promise<void>;
  /** A person's pinned and recent projects in a workspace. Empty for anyone else. */
  shortcuts(workspace: string, viewer: Viewer): Promise<ProjectShortcuts>;
  /**
   * Pins a project the person can see, at `position` (0 first) or at the
   * end; pinning one already pinned moves it. A person's own, at most 8 a
   * workspace. Returns their pins, in order.
   */
  pin(actor: User, workspace: string, slug: string, position?: number | null): Promise<Result<Project[]>>;
  /** Unpins it. Returns their pins, in order. */
  unpin(actor: User, workspace: string, slug: string): Promise<Result<Project[]>>;
  /** Puts their pins in this order: every pinned project's slug, once. */
  reorderPins(actor: User, workspace: string, slugs: string[]): Promise<Result<Project[]>>;
  /** The person opened the project: it leads their recent ones. */
  visited(actor: User, projectId: string): Promise<void>;
  /**
   * For lists of public repositories, such as Explore: each one's own
   * project's address to show, by `namespace/name` in lower case:
   * production when it is deployed elsewhere, else its homepage, else its
   * docs. Repositories without one are left out. At most 100 asked at once.
   */
  publicLinks(repos: RepoPath[]): Promise<Record<string, string>>;
}
