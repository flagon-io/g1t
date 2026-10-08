/**
 * Builds as the deployments pages show them: why one failed, in plain
 * words, and a run of the same failure as one row; and a repository's
 * deployments wherever they run: states, environments and the list's filter.
 */
import type {
  Deployment,
  DeploymentEnvironment,
  DeploymentFilter,
  DeploymentSource,
  DeploymentState,
  RepoDeployment,
} from "@g1t/contracts";

/** What git says when the commit asked for is not in the repository (as services/deployments/src/retries.ts). */
const MISSING_COMMIT = /reference is not a tree|not our ref|bad object|unknown revision|no such commit/i;

/**
 * Why a build failed or was skipped, as the page says it. A commit that is
 * gone (force-pushed over, or its branch deleted) is said plainly; older
 * builds still carry git's own words, which stay in the build log.
 */
export function buildError(build: Pick<Deployment, "kind" | "number" | "error">): string | null {
  if (!build.error || !MISSING_COMMIT.test(build.error)) return build.error;
  if (build.kind === "preview" && build.number != null) {
    return `This pull request's commit no longer exists. Push again, or close pull request #${build.number}.`;
  }
  if (build.kind === "preview") return "This branch's commit no longer exists. Push to the branch again.";
  return "This commit no longer exists in the repository. Push to the default branch again.";
}

/** A build, and how many times in a row before it its app failed the same way. */
export type BuildGroup<T> = {
  /** The newest of them, the one the row links to. */
  build: T;
  /** 1 for a build on its own. */
  count: number;
  /** When the oldest of them started. */
  firstAt: string;
};

/** The app a build is for: production, or one branch's preview. */
const appOf = (build: Pick<Deployment, "kind" | "branch">) => `${build.kind}/${build.branch ?? ""}`;

/**
 * Folds each run of identical failures of one app (production, or one
 * branch's preview), newest first as listed, into the row of its newest:
 * the same error, with no other outcome for that app in between. Builds
 * of other apps between them do not break the run; any other build of
 * the same app does.
 */
export function groupBuilds<T extends Pick<Deployment, "kind" | "branch" | "number" | "status" | "error" | "createdAt">>(
  builds: T[],
): BuildGroup<T>[] {
  const groups: BuildGroup<T>[] = [];
  // Each app's run still open, by the error it failed with.
  const open = new Map<string, { group: BuildGroup<T>; error: string | null }>();
  for (const build of builds) {
    const app = appOf(build);
    const run = open.get(app);
    const error = buildError(build);
    if (build.status === "failed" && run && run.error === error) {
      run.group.count++;
      run.group.firstAt = build.createdAt;
      continue;
    }
    const group = { build, count: 1, firstAt: build.createdAt };
    groups.push(group);
    if (build.status === "failed") open.set(app, { group, error });
    else open.delete(app);
  }
  return groups;
}

// --- A repository's deployments, wherever they run ---------------------------

/** Every state a deployment can be in, in the order the filter lists them. */
export const STATES: readonly DeploymentState[] = ["success", "failure", "error", "in_progress", "queued", "inactive"];

/** Every way a deployment can be made. */
export const SOURCES: readonly DeploymentSource[] = ["actions", "g1t_page", "api"];

/** A state in a word. */
export const STATE_WORD: Record<DeploymentState, string> = {
  queued: "Queued",
  in_progress: "Deploying",
  success: "Deployed",
  failure: "Failed",
  error: "Error",
  inactive: "Inactive",
};

/** What made a deployment, as the site names it. */
export const SOURCE_LABEL: Record<DeploymentSource, string> = {
  actions: "g1t Actions",
  g1t_page: "g1t.page",
  api: "API",
};

/** An environment's name as a heading: `production` reads Production. */
export function environmentLabel(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** A commit as the site shows it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A g1t.page build, which also has a build log and the g1t.page controls. */
export function isPageBuild(id: string): boolean {
  return id.startsWith("dpl_");
}

/** Where an environment is served now: its own address, or its current deployment's. */
export function environmentUrl(env: Pick<DeploymentEnvironment, "url" | "current" | "latest">): string | null {
  return env.url ?? env.current?.environment_url ?? (env.latest?.state === "success" ? env.latest.environment_url : null);
}

type Ordered = Pick<DeploymentEnvironment, "name" | "production_environment" | "transient_environment" | "updated_at">;

/**
 * Environments as the pages list them: production ones first (the one
 * named `production` before the rest), then lasting ones, then transient
 * ones such as previews; in each, the most recently deployed first.
 */
export function orderEnvironments<T extends Ordered>(environments: readonly T[]): T[] {
  const rank = (env: T) => (env.production_environment ? (env.name === "production" ? 0 : 1) : env.transient_environment ? 3 : 2);
  return [...environments].sort(
    (a, b) => rank(a) - rank(b) || Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.name.localeCompare(b.name),
  );
}

/**
 * The environment that is production, for the overview: one marked as
 * production that has had a deployment, the one named `production` first.
 */
export function productionEnvironment<T extends Ordered & Pick<DeploymentEnvironment, "latest">>(environments: readonly T[]): T | null {
  return orderEnvironments(environments).find((env) => env.production_environment && env.latest != null) ?? null;
}

/** The filters the list's address can carry, besides the page. */
export const FILTER_KEYS = ["environment", "state", "source", "creator", "ref"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** Deployments on a page of the list, unless the address says otherwise. */
export const PER_PAGE = 30;

export type ListFilter = Required<Pick<DeploymentFilter, FilterKey>> & { page: number; per_page: number };

/** The list's filter from a page's query, ignoring anything it cannot be. */
export function parseFilter(query: URLSearchParams): ListFilter {
  const text = (key: string) => query.get(key)?.trim() || null;
  const state = text("state");
  const source = text("source");
  const page = Number.parseInt(query.get("page") ?? "", 10);
  const perPage = Number.parseInt(query.get("per_page") ?? "", 10);
  return {
    environment: text("environment"),
    state: STATES.includes(state as DeploymentState) ? (state as DeploymentState) : null,
    source: SOURCES.includes(source as DeploymentSource) ? (source as DeploymentSource) : null,
    creator: text("creator"),
    ref: text("ref"),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    per_page: Number.isFinite(perPage) ? Math.min(100, Math.max(1, perPage)) : PER_PAGE,
  };
}

/** Whether any filter narrows the list. */
export function isFiltered(filter: Pick<DeploymentFilter, FilterKey>): boolean {
  return FILTER_KEYS.some((key) => filter[key] != null && filter[key] !== "");
}

/**
 * The address of the list with one filter changed (null clears it), from
 * its first page; or, for `page`, the same list on another page.
 */
export function withFilter(path: string, filter: ListFilter, key: FilterKey | "page", value: string | number | null): string {
  const query = new URLSearchParams();
  for (const each of FILTER_KEYS) {
    const kept = each === key ? value : filter[each];
    if (kept != null && kept !== "") query.set(each, String(kept));
  }
  if (key === "page" && value != null && Number(value) > 1) query.set("page", String(value));
  if (filter.per_page !== PER_PAGE) query.set("per_page", String(filter.per_page));
  const search = query.toString();
  return `${path}${search ? `?${search}` : ""}#history`;
}

/** The distinct values of one field across deployments, for a filter's choices, the chosen one kept. */
export function choices(
  deployments: readonly (Pick<RepoDeployment, "creator" | "ref"> | null | undefined)[],
  field: "creator" | "ref",
  chosen?: string | null,
): string[] {
  const seen = new Set<string>();
  if (chosen) seen.add(chosen);
  for (const each of deployments) if (each?.[field]) seen.add(each[field]);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** "31–60 of 304": the rows a page of the list shows. */
export function pageRange(page: number, perPage: number, total: number): string {
  const first = (page - 1) * perPage + 1;
  if (total === 0 || first > total) return `0 of ${total}`;
  return `${first}–${Math.min(total, page * perPage)} of ${total}`;
}

/** Whether a deployment's payload has anything in it to show. */
export function hasPayload(payload: Record<string, unknown> | null | undefined): boolean {
  return payload != null && typeof payload === "object" && Object.keys(payload).length > 0;
}
