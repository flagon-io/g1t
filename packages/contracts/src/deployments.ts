import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Deployments: every pull request gets a live preview on g1t.page, and the
 * default branch goes to production on each push. Apps run as Workers in a
 * Workers for Platforms namespace, so an app no one visits costs nothing.
 * A paid feature: the workspace turns it on with a monthly plan (see
 * `Feature` in `./billing`), and each repository then chooses for itself.
 */

/** The domain apps are served on. Never g1t.sh, so they share no cookies with it. */
export const DEPLOYMENTS_DOMAIN = "g1t.page";

/** A repository's deployment settings. */
export type DeploySettings = {
  /** Whether this repository deploys at all. Off until someone turns it on. */
  enabled: boolean;
  /** A preview for every open pull request. */
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
  /** For a preview: the pull request. */
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

/** An app that is up: production, or one pull request's preview. */
export type LiveApp = {
  kind: DeployKind;
  number: number | null;
  url: string;
  commit: string;
  /** RFC 3339: when it was last deployed. */
  deployedAt: string;
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
  settings(repo: RepoPath, viewer: Viewer): Promise<Result<DeploySettings>>;
  /** Members of the workspace only. Turning deployments on needs the plan. */
  updateSettings(actor: User, repo: RepoPath, changes: Partial<DeploySettings>): Promise<Result<DeploySettings>>;
  /** The newest deployments first, and what is up now. */
  list(repo: RepoPath, viewer: Viewer): Promise<Result<{ deployments: Deployment[]; live: LiveApp[] }>>;
  /** One deployment, with its build log. */
  get(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<Deployment & { log: string | null }>>;
  /** Builds production, or a pull request's preview, again from its current head. */
  redeploy(actor: User, repo: RepoPath, number: number | null): Promise<Result<Deployment>>;
  /** Takes production, or a pull request's preview, down now. */
  takeDown(actor: User, repo: RepoPath, number: number | null): Promise<Result<true>>;
  /** What the workspace's apps used this month. Members only. */
  usage(workspace: string, viewer: Viewer): Promise<Result<DeployUsage>>;
}
