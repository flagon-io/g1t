import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

/**
 * GitHub: signing in with a GitHub account, and bringing repositories
 * across through g1t's GitHub App. Mirrors `crates/contracts/src/github.rs`.
 *
 * The identity service keeps linked accounts and their user tokens; the
 * integrations service keeps installations, linked repositories and the
 * app's webhook. With no app configured, `enabled`/`configured` are false
 * and the site shows no GitHub buttons.
 */

export type GithubPurpose = "sign_in" | "link";

/** How a return from GitHub ended. */
export type GithubFinished =
  | {
      kind: "signed_in";
      /** `twoFactorChallenge` is set, and `sessionToken` empty, while the account's two-factor code is still to come. */
      signedIn: { user: User; sessionToken: string; twoFactorChallenge?: string | null };
      created: boolean;
      next: string;
    }
  | { kind: "linked"; login: string; next: string }
  /** An account has one of its verified emails: sign in to it, then claim. */
  | { kind: "needs_link"; pending: string; login: string; next: string }
  /** A new account waiting on a username, or on an invite code. */
  | { kind: "needs_username"; pending: string; login: string; suggestion: string; next: string; inviteRequired: boolean };

export type GithubPending = {
  login: string;
  kind: "link" | "username";
  suggestion: string | null;
  next: string;
  inviteRequired: boolean;
};

export type GithubAccount = {
  githubId: number;
  login: string;
  linkedAt: string;
  /** Whether g1t holds a working user token for it. */
  authorized: boolean;
};

export type GithubAccountView = {
  enabled: boolean;
  account: GithubAccount | null;
  hasPassword: boolean;
};

/** How a GitHub repository comes to g1t. */
export type GithubMode = "import" | "mirror" | "push";

export type GithubInstallation = {
  id: number;
  workspace: string;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected" | string;
  suspended: boolean;
  settingsUrl: string;
  createdAt: string;
};

export type GithubAppStatus = {
  configured: boolean;
  installUrl: string | null;
  linked: boolean;
  installations: GithubInstallation[];
};

export type GithubRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  /** The g1t repository already linked to it, as `workspace/name`. */
  linkedTo: string | null;
};

export type GithubRepositories = {
  repositories: GithubRepository[];
  total: number;
  page: number;
  perPage: number;
};

export type GithubRepoLink = {
  repoId: string;
  repo: string;
  installationId: number;
  githubRepoId: number;
  fullName: string;
  mode: GithubMode;
  syncedAt: string | null;
  lastError: string | null;
  issuesImported: number;
};

export type GithubImportInput = {
  installationId: number;
  githubRepoId: number;
  name?: string;
  mode: GithubMode;
  private?: boolean;
  issues: boolean;
};

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

/** Signing in with GitHub: methods of the identity service. */
export function githubSignInClient(identity: ServiceBinding) {
  const call = <T>(method: string, args: object) => rpc<T>(identity, method, args);
  return {
    enabled: () => call<boolean>("github_enabled", {}),
    start: (input: { purpose: GithubPurpose; user?: User | null; redirectUri: string; next: string; inviteCode?: string | null }) =>
      call<Result<{ authorizeUrl: string; state: string }>>("github_start", input),
    finish: (state: string, code: string) => call<Result<GithubFinished>>("github_finish", { state, code }),
    pending: (pending: string) => call<Result<GithubPending>>("github_pending", { pending }),
    signUp: (pending: string, username: string, inviteCode?: string | null) =>
      call<Result<{ user: User; sessionToken: string }>>("github_sign_up", { pending, username, inviteCode: inviteCode ?? null }),
    claim: (pending: string, user: User) => call<Result<GithubAccount>>("github_claim", { pending, user }),
    account: (user: User) => call<GithubAccountView>("github_account", { user }),
    unlink: (user: User) => call<Result<boolean>>("github_unlink", { user }),
  };
}

/** g1t's GitHub App: methods of the integrations service. */
export function githubAppClient(integrations: ServiceBinding) {
  const call = <T>(method: string, args: object) => rpc<T>(integrations, method, args);
  return {
    status: (viewer: User, workspace: string) => call<Result<GithubAppStatus>>("github_status", { viewer, workspace }),
    addInstallation: (actor: User, workspace: string, installationId: number) =>
      call<Result<GithubInstallation>>("github_add_installation", { actor, workspace, installationId }),
    removeInstallation: (actor: User, workspace: string, installationId: number) =>
      call<Result<boolean>>("github_remove_installation", { actor, workspace, installationId }),
    repositories: (actor: User, workspace: string, installationId: number, page?: number) =>
      call<Result<GithubRepositories>>("github_repositories", { actor, workspace, installationId, page: page ?? null }),
    import: (actor: User, workspace: string, input: GithubImportInput) =>
      call<Result<GithubRepoLink>>("github_import", { actor, workspace, ...input }),
    link: (repoId: string) => call<GithubRepoLink | null>("github_link", { repoId }),
    unlinkRepo: (actor: User, repoId: string) => call<Result<boolean>>("github_unlink_repo", { actor, repoId }),
    sync: (actor: User, repoId: string) => call<Result<GithubRepoLink>>("github_sync", { actor, repoId }),
  };
}
