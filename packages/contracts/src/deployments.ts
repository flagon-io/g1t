import type { User, Viewer } from "./identity";
import type { Result } from "./result";

/**
 * Deployments: a project's production, deployed from its default branch on
 * every push, and a live preview of every branch with an open pull request.
 * Apps run as Workers in a Workers for Platforms namespace, so an app no
 * one visits costs nothing. A paid feature: the workspace turns it on with
 * a monthly plan (see `Feature` in `./billing`), and each project then
 * chooses for itself.
 */

/** The domain apps are served on. Never g1t.sh, so they share no cookies with it. */
export const DEPLOYMENTS_DOMAIN = "g1t.page";

/** A project, as deployments name it. */
export type ProjectRef = { workspace: string; slug: string };

/** A project's deployment settings. */
export type DeploySettings = {
  /** Whether this project deploys at all. Off until someone turns it on. */
  enabled: boolean;
  /** A preview for every branch with an open pull request. */
  previews: boolean;
  /** The default branch deployed to production on every push. */
  production: boolean;
  /** Runs instead of the project's own `build` script. */
  buildCommand: string | null;
  /** What to serve, for a static site; found by itself when null. */
  outputDir: string | null;
  /** A preview no one has visited in this many days is taken down. */
  idleDays: number;
  /** Where production is served. */
  productionUrl: string;
};

export type DeployKind = "preview" | "production";

export type DeployStatus =
  /** Waiting for a sandbox. */
  | "queued"
  | "building"
  | "ready"
  | "failed"
  /** Not built: the workspace's plan is off, or the build was replaced. */
  | "skipped";

/** One build of one commit, and where it went. */
export type Deployment = {
  id: string;
  kind: DeployKind;
  /** For a preview: the branch, or `pr-<n>` for a pull request from a fork. */
  branch: string | null;
  /** For a preview: its pull request. */
  number: number | null;
  commit: string;
  status: DeployStatus;
  url: string;
  /** Why it failed or was skipped. */
  error: string | null;
  /** What the build could not provide, such as bindings not provisioned yet. */
  warnings: string[];
  /** How long the build ran, in seconds; charged at the container price. */
  buildSeconds: number | null;
  createdBy: string;
  /** RFC 3339. */
  createdAt: string;
  finishedAt: string | null;
};

/** An app that is up: production, or one branch's preview. */
export type LiveApp = {
  kind: DeployKind;
  branch: string | null;
  number: number | null;
  url: string;
  commit: string;
  /** RFC 3339: when it was last deployed. */
  deployedAt: string;
};

/** One project at a glance, for the workspace's page. */
export type ProjectDeploys = {
  slug: string;
  enabled: boolean;
  production: LiveApp | null;
  previews: number;
  /** The newest build, whatever its status. */
  latest: Deployment | null;
};

/** What a workspace's apps used this month against its plan. */
export type DeployUsage = {
  /** `YYYY-MM`. */
  month: string;
  requests: number;
  cpuMs: number;
  /** Apps up now, and the most at once this month. */
  apps: number;
  peakApps: number;
  buildSeconds: number;
  /** Charged so far this month for builds, in millionths of a dollar. */
  buildMicros: number;
  /** RFC 3339: when requests and CPU time were last counted. */
  countedAt: string | null;
};

export interface DeploymentsApi {
  /** Members of the workspace only. */
  settings(project: ProjectRef, viewer: Viewer): Promise<Result<DeploySettings>>;
  /** Members only. Turning deployments on needs the workspace's plan. */
  updateSettings(actor: User, project: ProjectRef, changes: Partial<DeploySettings>): Promise<Result<DeploySettings>>;
  /** The newest builds first, and what is up now. Members only. */
  list(project: ProjectRef, viewer: Viewer): Promise<Result<{ deployments: Deployment[]; live: LiveApp[] }>>;
  /** One build, with its log. Members only. */
  get(project: ProjectRef, id: string, viewer: Viewer): Promise<Result<Deployment & { log: string | null }>>;
  /** Builds production (`branch` null), or a branch's preview, again from its head. */
  redeploy(actor: User, project: ProjectRef, branch: string | null): Promise<Result<Deployment>>;
  /**
   * Builds previews of the projects that use this one, under the same
   * branch, each pointed at this branch's preview. Answers at once with the
   * names of the projects being built; the builds go on in the
   * background. Members only.
   */
  stack(actor: User, project: ProjectRef, branch: string): Promise<Result<string[]>>;
  /** Takes production (`branch` null), or a branch's preview, down now. */
  takeDown(actor: User, project: ProjectRef, branch: string | null): Promise<Result<true>>;
  /** Every project of a workspace at a glance. Members only. */
  overview(workspace: string, viewer: Viewer): Promise<Result<ProjectDeploys[]>>;
  /** What the workspace's apps used this month. Members only. */
  usage(workspace: string, viewer: Viewer): Promise<Result<DeployUsage>>;
}
