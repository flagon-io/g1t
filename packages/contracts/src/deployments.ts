import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
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
  /**
   * Whether it builds through the deploy workflow g1t manages for it, a
   * workflow run on each push and pull request like any other, rather
   * than through Deployments' own build.
   */
  viaWorkflow?: boolean;
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
   * project (it has a Workers config), a static site its build wrote,
   * plain HTML served as it is, or a container. Null until a build has
   * finished. Read-only.
   */
  detected: DetectedKind | null;
  /**
   * What the last finished build found it built with: a framework's id
   * (`astro`…), or for a container `dockerfile` or the server g1t wrote a
   * Dockerfile for (`flask`…). See `FRAMEWORK_NAMES`. Read-only.
   */
  framework?: string | null;
  /** What it is built as: found from its files (`auto`), or as the project says. */
  buildAs?: BuildAs;
  /** Its Dockerfile, relative to the project, when not `Dockerfile` or `Containerfile`. */
  dockerfile?: string | null;
  /** The size its container runs at (`APP_INSTANCES`), when it is one. */
  instanceType?: string;
  /** Whether g1t.page runs containers here yet, and what each size costs. Read-only. */
  containers?: ContainerOffer;
};

export type DetectedKind = "workers" | "static" | "html" | "container";

/**
 * What a project is built as. `auto` finds it from its files: a Wrangler
 * config is Workers, a framework that builds a static site or a Worker is
 * that, a framework that needs a server or a project with a Dockerfile
 * (or a server g1t can write one for) is a container.
 */
export type BuildAs = "auto" | "static" | "workers" | "docker";

export const BUILD_AS: readonly BuildAs[] = ["auto", "static", "workers", "docker"];

/**
 * A size a container app runs at: one of Cloudflare Containers' instance
 * types. Memory and disk are paid for while it is awake, CPU as it is
 * used, and its image can be as large as its disk.
 */
export type AppInstance = { type: string; vcpu: number; memoryGib: number; diskGb: number };

/** Cloudflare Containers' instance types, smallest first. */
export const APP_INSTANCES: readonly AppInstance[] = [
  { type: "lite", vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 },
  { type: "basic", vcpu: 1 / 4, memoryGib: 1, diskGb: 4 },
  { type: "standard-1", vcpu: 1 / 2, memoryGib: 4, diskGb: 8 },
  { type: "standard-2", vcpu: 1, memoryGib: 6, diskGb: 12 },
  { type: "standard-3", vcpu: 2, memoryGib: 8, diskGb: 16 },
  { type: "standard-4", vcpu: 4, memoryGib: 12, diskGb: 20 },
];

/** What a container app runs at unless its project says: the smallest. */
export const DEFAULT_APP_INSTANCE = "lite";

/** A container app sleeps after this long with no request, and costs nothing while asleep. */
export const CONTAINER_SLEEP_MINUTES = 5;

/** An instance type by name; the default one for anything else. */
export function appInstance(type: string | null | undefined): AppInstance {
  return APP_INSTANCES.find((instance) => instance.type === type) ?? APP_INSTANCES[0];
}

/** What container apps cost g1t, in millionths of a dollar, from the price book. */
export type ContainerCosts = {
  vcpuSecond: number;
  memoryGibSecond: number;
  diskGbSecond: number;
  /** The Durable Object in front of each instance, billed while the instance runs. */
  instanceSecond: number;
  egressGb: number;
};

/**
 * What one second awake of `instance` costs g1t at most: its memory, disk
 * and Durable Object, and every vCPU busy. Cloudflare bills CPU as it is
 * used, so an app that is mostly waiting costs g1t less; g1t charges the
 * whole vCPU while it is awake, so it never sells below cost.
 */
export function containerSecondMicros(instance: AppInstance, costs: ContainerCosts): number {
  return (
    instance.vcpu * costs.vcpuSecond +
    instance.memoryGib * costs.memoryGibSecond +
    instance.diskGb * costs.diskGbSecond +
    costs.instanceSecond
  );
}

/** One size as Settings, Deployments shows it: what an hour awake is charged, the margin included. */
export type ContainerPrice = AppInstance & { hourlyMicros: number };

export type ContainerOffer = {
  /** False until Docker deployments are switched on for g1t.page. */
  available: boolean;
  prices: ContainerPrice[];
  /** What one GB a container sends is charged, the margin included. */
  egressGbMicros: number;
  sleepMinutes: number;
};

/**
 * What a build found a project built with, by the id `g1t-runner detect`
 * prints as `framework`, for people.
 */
export const FRAMEWORK_NAMES: Record<string, string> = {
  vite: "Vite",
  "vite-react": "React (Vite)",
  "vite-vue": "Vue (Vite)",
  "vite-svelte": "Svelte (Vite)",
  "vite-solid": "Solid (Vite)",
  "vite-preact": "Preact (Vite)",
  astro: "Astro",
  nextjs: "Next.js",
  sveltekit: "SvelteKit",
  nuxt: "Nuxt",
  "react-router": "React Router",
  remix: "Remix",
  gatsby: "Gatsby",
  docusaurus: "Docusaurus",
  eleventy: "Eleventy",
  angular: "Angular",
  "create-react-app": "Create React App",
  hugo: "Hugo",
  jekyll: "Jekyll",
  mdbook: "mdBook",
  dockerfile: "Dockerfile",
  node: "Node.js",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  python: "Python",
  go: "Go",
  rails: "Rails",
  rack: "Rack",
  laravel: "Laravel",
  php: "PHP",
  rust: "Rust",
};

/** A framework id a build reported, if it is one g1t knows. */
export function frameworkId(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(FRAMEWORK_NAMES, value) ? value : null;
}

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
  /** What the build found it to be and built with, once it has finished (see `DeploySettings`). */
  detected?: DetectedKind | null;
  framework?: string | null;
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

/** What a workspace's apps used this month. Every request, CPU millisecond and build second is metered; apps are not. */
export type DeployUsage = {
  /** `YYYY-MM`. */
  month: string;
  requests: number;
  cpuMs: number;
  /** Apps up now (production and previews), and the most at once this month: for information, never charged. */
  apps: number;
  peakApps: number;
  buildSeconds: number;
  /** Charged so far this month for builds, in millionths of a dollar. */
  buildMicros: number;
  /** Seconds container apps have been awake this month, and what that has cost g1t so far (charged when the month closes). */
  containerSeconds?: number;
  containerMicros?: number;
  /** RFC 3339: when requests and CPU time last went up. */
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
  /** What one custom domain costs a month on the plan, in millionths of a dollar: g1t's cost plus 20%. */
  monthlyMicros: number;
  /** The workspace's custom domains now. */
  used: number;
};

// ---- A repository's deployments, wherever they run ---------------------
//
// Every deployment of a repository, in one model: g1t.page builds (read
// from the builds above, never copied), deployments g1t Actions makes for
// a job with an `environment:`, and deployments any other system reports
// through the API. These travel in `snake_case` between services too, as
// the API shows them, so a deployment's `payload` reaches the API with its
// keys as they were given.

/** Where a deployment is, as its latest status says. */
export type DeploymentState = "queued" | "in_progress" | "success" | "failure" | "error" | "inactive";

export const DEPLOYMENT_STATES: readonly DeploymentState[] = ["queued", "in_progress", "success", "failure", "error", "inactive"];

/**
 * What made a deployment: `api` (reported with a token), `actions` (a g1t
 * Actions job with an `environment:`) or `g1t_page` (a build on g1t.page).
 */
export type DeploymentSource = "api" | "actions" | "g1t_page";

/** One deployment of one commit to one environment. */
export type RepoDeployment = {
  /** `dep_…` for a reported deployment, `dpl_…` for a g1t.page build. */
  id: string;
  /** Such as `production`, `staging` or `preview`. */
  environment: string;
  /** The branch, tag or commit asked for. */
  ref: string;
  sha: string;
  /** What kind of deployment: `deploy` unless given, such as `deploy:migrations`. */
  task: string;
  description: string | null;
  /** Whatever the reporter attached, as given. */
  payload: Record<string, unknown>;
  /** An environment that goes away, such as a pull request's preview. */
  transient_environment: boolean;
  /** An environment people use directly. */
  production_environment: boolean;
  /** Its latest status's state. */
  state: DeploymentState;
  /** Where it is served, from its latest status that gave one. */
  environment_url: string | null;
  /** Where its output can be read, from its latest status that gave one. */
  log_url: string | null;
  /** The username that created it, or `g1t`. */
  creator: string;
  source: DeploymentSource;
  /** For `actions`: the workflow run, and its address on the site. */
  run_id: string | null;
  run_url: string | null;
  /** For `g1t_page`: the project it built, and a preview's pull request. */
  project: string | null;
  number: number | null;
  /** RFC 3339. */
  created_at: string;
  /** RFC 3339: its latest status. */
  updated_at: string;
};

/** One status of a deployment: what it said, and when. */
export type DeploymentStatus = {
  id: string;
  deployment_id: string;
  state: DeploymentState;
  description: string | null;
  environment_url: string | null;
  log_url: string | null;
  creator: string;
  /** RFC 3339. */
  created_at: string;
};

/** A deployment with every status it has had, oldest first. */
export type DeploymentDetail = RepoDeployment & { statuses: DeploymentStatus[] };

/** An environment: a name deployments go to, made by the first. */
export type DeploymentEnvironment = {
  name: string;
  /** Where its current deployment is served. */
  url: string | null;
  production_environment: boolean;
  transient_environment: boolean;
  /** How many deployments it has had. */
  deployments_count: number;
  /** Its newest deployment, whatever its state. */
  latest: RepoDeployment | null;
  /** The newest deployment that succeeded and is still active: what it serves. */
  current: RepoDeployment | null;
  /** RFC 3339: its newest deployment's latest status. */
  updated_at: string;
};

/** A repository's environments, production first, and its count of deployments. */
export type DeploymentEnvironments = {
  /** Deployments across every environment. */
  total_count: number;
  environments: DeploymentEnvironment[];
};

/** Which deployments to list. Every field narrows the list. */
export type DeploymentFilter = {
  environment?: string | null;
  ref?: string | null;
  sha?: string | null;
  task?: string | null;
  state?: DeploymentState | null;
  source?: DeploymentSource | null;
  creator?: string | null;
  /** From 1. */
  page?: number | null;
  /** 1 to 100; 30 unless given. */
  per_page?: number | null;
};

/** One page of deployments, newest first. */
export type DeploymentPage = {
  deployments: RepoDeployment[];
  total_count: number;
  page: number;
  per_page: number;
};

/** What `create_deployment` takes, as the API does. */
export type NewDeployment = {
  ref: string;
  /** The commit; resolved from `ref` when left out. */
  sha?: string | null;
  environment?: string | null;
  task?: string | null;
  description?: string | null;
  payload?: Record<string, unknown> | null;
  transient_environment?: boolean | null;
  production_environment?: boolean | null;
  /** The state of its first status: `queued` unless given. */
  state?: DeploymentState | null;
  environment_url?: string | null;
  log_url?: string | null;
};

/** What `create_deployment_status` takes. */
export type NewDeploymentStatus = {
  state: DeploymentState;
  description?: string | null;
  environment_url?: string | null;
  log_url?: string | null;
  /**
   * On a success: the environment's older deployments that succeeded get
   * an `inactive` status. True unless given.
   */
  auto_inactive?: boolean | null;
};

/**
 * Whether a change that landed on a default branch is live in production:
 * shipped by a production deployment that succeeded (`live`), not yet
 * deployed (`waiting`), on its way (`deploying`), or the production
 * deployment after it failed and none has shipped it since (`failed`).
 */
export type ShipState = "live" | "waiting" | "deploying" | "failed";

/** One change asked about: its commit on the default branch, and when it landed there. */
export type ShippedAsk = { sha: string; landed_at: string };

/** A change's ship state, from what deployments recorded when production deployed. */
export type ShippedCommit = {
  sha: string;
  state: ShipState;
  /** RFC 3339: when the deployment that shipped it went live; null until then. */
  deployed_at: string | null;
  /** Where that deployment is on the site (or the failed or running one, for `failed` and `deploying`). */
  url: string | null;
  /** The environment it went to, such as `production`. */
  environment: string | null;
};

/** A repository's answer: whether it deploys to production at all, and each change asked about. */
export type ShippedRepo = { repo_id: string; deploys: boolean; commits: ShippedCommit[] };

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
  /** A repository's deployments, newest first, filtered. Anyone who can read it. */
  repoDeployments(repo: RepoPath, viewer: Viewer, filter?: DeploymentFilter): Promise<Result<DeploymentPage>>;
  /** One deployment with its statuses, oldest first. Anyone who can read the repository. */
  repoDeployment(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<DeploymentDetail>>;
  /** A repository's environments with their current and latest deployments. Anyone who can read it. */
  environments(repo: RepoPath, viewer: Viewer): Promise<Result<DeploymentEnvironments>>;
  /** Reports a deployment. Takes the Write role. */
  createDeployment(actor: User, repo: RepoPath, input: NewDeployment): Promise<Result<DeploymentDetail>>;
  /** Adds a status to a reported deployment. Takes the Write role. */
  createDeploymentStatus(actor: User, repo: RepoPath, id: string, input: NewDeploymentStatus): Promise<Result<DeploymentStatus>>;
  /**
   * Whether changes that landed on default branches went live, and when:
   * read from what was recorded as each production deployment succeeded
   * (src/shipped.ts). Members of the workspace only; at most 20
   * repositories and 300 commits a call.
   */
  shipped(workspace: string, viewer: Viewer, repos: { repo_id: string; commits: ShippedAsk[] }[]): Promise<Result<ShippedRepo[]>>;
}
