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
  /**
   * The project's own domain for production, once it is active: the first
   * custom domain added that serves the app rather than redirecting. Null
   * until one is.
   */
  primaryDomain: string | null;
  /**
   * What the last finished build found the project to be: a Workers
   * project (it has a Workers config), a static site its build wrote, or
   * plain HTML served as it is. Null until a build has finished. Read-only.
   */
  detected: DetectedKind | null;
};

export type DetectedKind = "workers" | "static" | "html";

export type DeployKind = "preview" | "production";

export type DeployStatus =
  /** Waiting for a sandbox. */
  | "queued"
  | "building"
  /** What its app serves now. */
  | "ready"
  /** Built and served, until a newer build of the same app replaced it. */
  | "replaced"
  /** Built and served, until its app was taken down. */
  | "down"
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

/** Where custom domains point: a hostname on g1t.page that routes to the dispatcher. */
export const CUSTOM_DOMAIN_TARGET = "domains.g1t.page";

/**
 * A custom domain's state: `pending` until its DNS points at g1t (or its
 * ownership record is found), `verifying` while its certificate is
 * issued, then `active`. `failed` says why in `error`; `removing` is on
 * its way out.
 */
export type DomainStatus = "pending" | "verifying" | "active" | "failed" | "removing";

/** A DNS record the domain's owner adds at their DNS provider. */
export type DomainRecord = {
  /** `ALIAS` stands for a flattened CNAME at the apex, whatever the provider calls it. */
  type: "CNAME" | "TXT" | "ALIAS";
  /** The record's full name. */
  name: string;
  value: string;
  /** What it is for, in a few words. */
  purpose: string;
};

/** A hostname of the project's own, serving its production. */
export type Domain = {
  id: string;
  hostname: string;
  /** What it serves: `production`. */
  target: "production";
  status: DomainStatus;
  /** Cloudflare's state for its certificate, as given. */
  sslStatus: string | null;
  /** Whether it is a registrable domain itself (`example.com`), which needs a flattened CNAME. */
  apex: boolean;
  /** Every record to add: where traffic goes, then any Cloudflare asks for. */
  records: DomainRecord[];
  /** A hostname this one redirects to (308, path and query kept), for a www/apex pair. */
  redirectTo: string | null;
  /** Why it is not active yet, or failed. */
  error: string | null;
  createdBy: string;
  createdAt: string;
  verifiedAt: string | null;
};

export type ProjectDomains = {
  domains: Domain[];
  /** The hostname every domain points at. */
  target: string;
  /** False until custom domains are switched on for g1t.page; `notice` says so. */
  available: boolean;
  notice: string | null;
  /** Custom domains the Deployments plan includes, across the workspace; more are charged by the month. */
  included: number;
  /** The workspace's custom domains now. */
  used: number;
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
  /** The project's custom domains. Members only. */
  domains(project: ProjectRef, viewer: Viewer): Promise<Result<ProjectDomains>>;
  /**
   * Adds a custom domain for production. With `twin`, its www or apex twin
   * is added too, redirecting to it. Members only; needs the Deployments plan.
   */
  addDomain(actor: User, project: ProjectRef, hostname: string, options?: { twin?: boolean }): Promise<Result<Domain[]>>;
  /** Removes a custom domain, and any domain redirecting to it. Members only. */
  removeDomain(actor: User, project: ProjectRef, id: string): Promise<Result<true>>;
  /** Asks Cloudflare to check the domain again now. Members only. */
  refreshDomain(actor: User, project: ProjectRef, id: string): Promise<Result<Domain>>;
}
