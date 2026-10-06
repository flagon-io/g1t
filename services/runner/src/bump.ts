/**
 * Security updates (`RunnerService.startBump`): what the security service
 * asks for, checked, and the sandbox it becomes, which runs the runner's
 * `bump` mode (crates/runner bump.rs). Pure, so it is tested on its own.
 */
import type { BumpArgs, RepoPath, User } from "@g1t/contracts";

/** g1t's own identity: `g1t_contracts::system::{ID, USERNAME}`. */
export const SYSTEM_ID = "g1t";
export const SYSTEM_USERNAME = "g1t";

/** The ecosystems the runner can update, by OSV's names. */
export const BUMP_ECOSYSTEMS: readonly string[] = ["npm", "crates.io", "Go", "PyPI"];

/** Long enough to clone, resolve and push; then the token stops working. */
export const BUMP_TOKEN_TTL_SECONDS = 30 * 60;

/** A security update's time cap, and what is reserved for it. */
export const BUMP_MINUTES = 20;

/** The most lockfiles one update names. */
const MAX_LOCKFILES = 50;

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
 * What is wrong with a request for a security update, or null when it can
 * start: a repository, an ecosystem the runner updates, a package and
 * version it can pass to a tool, lockfiles inside the repository, and a
 * branch under `prefix` (`UPDATE_BRANCH_PREFIX`).
 */
export function bumpProblem(input: unknown, prefix: string): string | null {
  if (!input || typeof input !== "object") return "A security update needs its arguments.";
  const args = input as Partial<BumpArgs>;
  if (!args.repo || !isText(args.repo.namespace) || !isText(args.repo.name)) return "A security update needs its repository.";
  if (!isText(args.ecosystem) || !BUMP_ECOSYSTEMS.includes(args.ecosystem)) {
    return `g1t cannot update ${String(args.ecosystem)} dependencies; it updates ${BUMP_ECOSYSTEMS.join(", ")}.`;
  }
  if (!isText(args.package) || !isArgument(args.package.trim())) return "A security update needs the package's name.";
  if (!isText(args.version) || !isArgument(args.version.trim())) return "A security update needs the version to raise it to.";
  if (!Array.isArray(args.lockfiles) || args.lockfiles.length === 0 || args.lockfiles.length > MAX_LOCKFILES) {
    return `A security update names between 1 and ${MAX_LOCKFILES} lockfiles.`;
  }
  const outside = args.lockfiles.find((path) => !isLockfilePath(path));
  if (outside !== undefined) return `${String(outside)} is not a path inside the repository.`;
  if (
    !isText(args.branch) ||
    !args.branch.startsWith(prefix) ||
    args.branch.length <= prefix.length ||
    args.branch.length > 200 ||
    args.branch.includes("..") ||
    /[\s~^:?*[\\]/.test(args.branch)
  ) {
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

/**
 * The sandbox's variables: what `bump` mode reads. `token` is a run
 * credential that reads the repository and pushes only `args.branch`.
 */
export function bumpEnv(args: BumpArgs, baseBranch: string, token: string): Record<string, string> {
  const pkg = args.package.trim();
  const version = args.version.trim();
  return {
    MODE: "bump",
    // The credential acts for the workspace; git sends any name with it.
    G1T_USER: args.repo.namespace.toLowerCase(),
    G1T_TOKEN: token,
    GIT_REMOTE: remoteOf(args.repo),
    GIT_BRANCH_BASE: baseBranch,
    GIT_BRANCH: args.branch,
    BUMP_ECOSYSTEM: args.ecosystem,
    BUMP_PACKAGE: pkg,
    BUMP_VERSION: version,
    BUMP_LOCKFILES: JSON.stringify(args.lockfiles),
    COMMIT_MESSAGE: isText(args.message) ? args.message : `Update ${pkg} to ${version}`,
  };
}
