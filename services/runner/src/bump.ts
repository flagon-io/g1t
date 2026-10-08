/**
 * Security and version updates (`RunnerService.startBump`): what the
 * security service asks for, checked, and the sandbox it becomes, which
 * runs the runner's `bump` mode (crates/runner bump.rs). Pure, so it is
 * tested on its own.
 */
import type { BumpArgs, BumpPackage, BumpRegistry, RepoPath, User } from "@g1t/contracts";

/** g1t's own identity: `g1t_contracts::system::{ID, USERNAME}`. */
export const SYSTEM_ID = "g1t";
export const SYSTEM_USERNAME = "g1t";

/** The ecosystems the runner can update, by OSV's names. */
export const BUMP_ECOSYSTEMS: readonly string[] = ["npm", "crates.io", "Go", "PyPI"];

/** How a version update changes a manifest's requirement (`versioning-strategy`). */
export const BUMP_STRATEGIES: readonly string[] = ["increase", "increase-if-necessary", "widen", "lockfile-only"];

/** The kinds of private registry the runner can point its tools at. */
export const BUMP_REGISTRY_TYPES: readonly string[] = ["npm-registry", "cargo-registry", "python-index", "goproxy-server"];

/** Long enough to clone, resolve and push; then the token stops working. */
export const BUMP_TOKEN_TTL_SECONDS = 30 * 60;

/** An update's time cap, and what is reserved for it. */
export const BUMP_MINUTES = 20;

/** The most lockfiles one update names. */
const MAX_LOCKFILES = 50;

/** The most packages one grouped update raises. */
const MAX_PACKAGES = 50;

/** The most private registries one update reads. */
const MAX_REGISTRIES = 20;

/** The longest text in a registry's entry. */
const MAX_REGISTRY_TEXT = 2000;

/**
 * g1t itself, working in `workspace`: the actor of the work it does on its
 * own, such as a security update or an agent it puts on one. Mirrors
 * `g1t_contracts::User::system`. Identity makes its run credentials act
 * for the workspace.
 */
export function systemActor(workspace: string): User {
  return {
    id: SYSTEM_ID,
    username: SYSTEM_USERNAME,
    kind: "system",
    verified: true,
    workspaces: [{ slug: workspace.toLowerCase(), role: "member" }],
  };
}

/** Whether `user` is g1t itself. */
export function isSystem(user: User | null | undefined): boolean {
  return user?.kind === "system";
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A name or version the runner passes to a tool as one argument. */
function isArgument(text: string): boolean {
  return text.length <= 214 && !text.startsWith("-") && /^[A-Za-z0-9@/._+~-]+$/.test(text);
}

/** A lockfile's path from the repository's root, inside it. */
function isLockfilePath(path: unknown): boolean {
  if (!isText(path) || path.length > 512 || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "..");
}

/**
 * Whether git takes `branch` as a branch's name, short of a full ref: what
 * a version update's branch, named by the dependency update file, must be.
 * Mirrors `branch_name_ok` in crates/runner bump.rs.
 */
export function isBranchName(branch: unknown): branch is string {
  if (!isText(branch) || branch.length > 200) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(branch) || branch.includes("..") || branch.includes("@{")) return false;
  if (branch.startsWith("-") || branch.startsWith("/") || branch.startsWith("refs/")) return false;
  return !branch.endsWith("/") && !branch.endsWith(".lock");
}

/** Absent, or text no longer than a registry's entry holds. */
function isRegistryText(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= MAX_REGISTRY_TEXT);
}

/** What is wrong with one private registry, or null. */
function registryProblem(registry: unknown): string | null {
  if (!registry || typeof registry !== "object") return "A private registry needs its type and URL.";
  const entry = registry as Partial<BumpRegistry>;
  if (!isText(entry.type) || !BUMP_REGISTRY_TYPES.includes(entry.type)) {
    return `g1t cannot read a ${String(entry.type)} registry; it reads ${BUMP_REGISTRY_TYPES.join(", ")}.`;
  }
  if (!isText(entry.url) || entry.url.length > MAX_REGISTRY_TEXT || !/^https:\/\/[^\s/]+\S*$/.test(entry.url)) {
    return "A private registry's URL starts with https://.";
  }
  if (!isRegistryText(entry.username) || !isRegistryText(entry.password) || !isRegistryText(entry.token)) {
    return `A private registry's credentials are text of at most ${MAX_REGISTRY_TEXT} characters.`;
  }
  if (entry.replacesBase !== undefined && typeof entry.replacesBase !== "boolean") {
    return "A private registry's replacesBase is true or false.";
  }
  if (entry.scopes !== undefined) {
    if (!Array.isArray(entry.scopes) || entry.scopes.length > MAX_REGISTRIES) {
      return `A private registry serves at most ${MAX_REGISTRIES} scopes.`;
    }
    const scope = entry.scopes.find((scope) => typeof scope !== "string" || !/^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope));
    if (scope !== undefined) return `${String(scope)} is not an npm scope.`;
  }
  return null;
}

/**
 * What is wrong with a request for an update, or null when it can start: a
 * repository, an ecosystem the runner updates, packages and versions it
 * can pass to a tool, lockfiles inside the repository, and a branch. A
 * security update's branch starts with `prefix` (`UPDATE_BRANCH_PREFIX`); a
 * version update (`kind: "version"`) names any branch git takes, and may
 * also choose a versioning strategy and name private registries.
 */
export function bumpProblem(input: unknown, prefix: string): string | null {
  if (!input || typeof input !== "object") return "A security update needs its arguments.";
  const args = input as Partial<BumpArgs>;
  if (args.kind !== undefined && args.kind !== "version") return `g1t cannot make a ${String(args.kind)} update.`;
  const versionUpdate = args.kind === "version";
  const what = versionUpdate ? "A version update" : "A security update";
  if (!args.repo || !isText(args.repo.namespace) || !isText(args.repo.name)) return `${what} needs its repository.`;
  if (!isText(args.ecosystem) || !BUMP_ECOSYSTEMS.includes(args.ecosystem)) {
    return `g1t cannot update ${String(args.ecosystem)} dependencies; it updates ${BUMP_ECOSYSTEMS.join(", ")}.`;
  }
  if (!isText(args.package) || !isArgument(args.package.trim())) return `${what} needs the package's name.`;
  if (!isText(args.version) || !isArgument(args.version.trim())) return `${what} needs the version to raise it to.`;
  if (args.packages !== undefined) {
    if (!Array.isArray(args.packages) || args.packages.length > MAX_PACKAGES) return `${what} raises at most ${MAX_PACKAGES} packages.`;
    for (const entry of args.packages as unknown[]) {
      const { package: name, version } = (entry && typeof entry === "object" ? entry : {}) as Partial<BumpPackage>;
      if (!isText(name) || !isArgument(name.trim())) return `${what} needs each package's name.`;
      if (!isText(version) || !isArgument(version.trim())) return `${what} needs the version to raise ${name.trim()} to.`;
    }
  }
  if (args.strategy !== undefined && (typeof args.strategy !== "string" || !BUMP_STRATEGIES.includes(args.strategy))) {
    return `${String(args.strategy)} is not a versioning strategy; g1t knows ${BUMP_STRATEGIES.join(", ")}.`;
  }
  if (args.force !== undefined && typeof args.force !== "boolean") return `${what}'s force is true or false.`;
  if (args.base !== undefined && !isBranchName(args.base)) return `${String(args.base)} is not a branch name git takes.`;
  if (args.registries !== undefined) {
    if (!Array.isArray(args.registries) || args.registries.length > MAX_REGISTRIES) {
      return `${what} reads at most ${MAX_REGISTRIES} private registries.`;
    }
    for (const registry of args.registries as unknown[]) {
      const problem = registryProblem(registry);
      if (problem) return problem;
    }
  }
  if (!Array.isArray(args.lockfiles) || args.lockfiles.length === 0 || args.lockfiles.length > MAX_LOCKFILES) {
    return `${what} names between 1 and ${MAX_LOCKFILES} lockfiles.`;
  }
  const outside = args.lockfiles.find((path) => !isLockfilePath(path));
  if (outside !== undefined) return `${String(outside)} is not a path inside the repository.`;
  if (versionUpdate) {
    return isBranchName(args.branch) ? null : `${String(args.branch)} is not a branch name git takes.`;
  }
  if (!isBranchName(args.branch) || !args.branch.startsWith(prefix) || args.branch.length <= prefix.length) {
    return `A security update's branch starts with ${prefix}.`;
  }
  return null;
}

/** The sandbox for one update: the same branch is the same sandbox. */
export function bumpSandboxName(args: BumpArgs): string {
  return `bump:${args.repo.namespace}/${args.repo.name}:${args.branch}`.toLowerCase();
}

/** The repository's clone URL, as every sandbox is given it. */
export function remoteOf(repo: RepoPath): string {
  return `https://g1t.sh/${repo.namespace}/${repo.name}.git`;
}

/** The packages an update raises: `packages`, or else its one package. */
export function bumpPackages(args: BumpArgs): BumpPackage[] {
  const listed = (args.packages ?? []).map((entry) => ({ package: entry.package.trim(), version: entry.version.trim() }));
  return listed.length > 0 ? listed : [{ package: args.package.trim(), version: args.version.trim() }];
}

/**
 * The sandbox's variables: what `bump` mode reads. `token` is a run
 * credential that reads the repository and pushes only `args.branch`.
 * `BUMP_PACKAGE` and `BUMP_VERSION` are the first of `BUMP_PACKAGES`.
 * `BUMP_REGISTRIES` holds credentials, which the runner writes only
 * outside the clone.
 */
export function bumpEnv(args: BumpArgs, baseBranch: string, token: string): Record<string, string> {
  const packages = bumpPackages(args);
  const { package: pkg, version } = packages[0]!;
  const named = packages.length === 1 ? `${pkg} to ${version}` : `${pkg} and ${packages.length - 1} more`;
  return {
    MODE: "bump",
    // The credential acts for the workspace; git sends any name with it.
    G1T_USER: args.repo.namespace.toLowerCase(),
    G1T_TOKEN: token,
    GIT_REMOTE: remoteOf(args.repo),
    GIT_BRANCH_BASE: baseBranch,
    GIT_BRANCH: args.branch,
    BUMP_KIND: args.kind === "version" ? "version" : "security",
    BUMP_ECOSYSTEM: args.ecosystem,
    BUMP_PACKAGE: pkg,
    BUMP_VERSION: version,
    BUMP_PACKAGES: JSON.stringify(packages),
    BUMP_STRATEGY: args.strategy ?? "increase",
    BUMP_FORCE: args.force ? "1" : "0",
    BUMP_REGISTRIES: JSON.stringify(args.registries ?? []),
    BUMP_LOCKFILES: JSON.stringify(args.lockfiles),
    COMMIT_MESSAGE: isText(args.message) ? args.message : `Update ${named}`,
  };
}

/**
 * The hosts of an update's private registries, which its sandbox may reach
 * on top of the public ones (`BUMP_HOSTS`).
 */
export function registryHosts(args: BumpArgs): string[] {
  const hosts = new Set<string>();
  for (const registry of args.registries ?? []) {
    try {
      hosts.add(new URL(registry.url).host);
    } catch {
      // bumpProblem refuses a registry without a URL.
    }
  }
  return [...hosts];
}
