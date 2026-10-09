/**
 * Mirroring: a repository kept in step with copies of it on other hosts.
 * Mirrors `g1t_contracts::mirrors`.
 *
 * Every linked repository has exactly one leader, where work happens. A
 * **mirror** follows a remote that leads; while it stands by it is an exact,
 * read-only copy that runs nothing. Someone can **take over** (g1t leads for
 * a while, then **hands back**), or **move it to g1t** for good, after which
 * g1t no longer tracks the remote. A repository g1t leads can be **mirrored
 * to** any number of followers.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

/** Where a mirror stands with the remote it follows. */
export type MirrorState = "standby" | "ci" | "takeover" | "handing_back";

/** A repository's tie to the remote it mirrors, on `Repo.mirror`. */
export type RepoMirror = {
  state: MirrorState;
  /** For people: `github.com/acme/web`. */
  remote: string;
  /** Its web address. */
  url: string;
  /** RFC 3339: when it entered this state. */
  since: string;
  warm?: boolean;
  githubWorkflows?: boolean;
  holdDeploys?: boolean;
};

/** Whether the repository takes pushes, merges, issues and agents now. */
export function mirrorWritable(mirror: RepoMirror | null | undefined): boolean {
  return !mirror || mirror.state === "takeover";
}

export type RemoteProvider = "github" | "g1t" | "git";
export type RemoteRole = "leader" | "follower";
export type RemoteState = MirrorState | "following" | "stuck";

export type MirrorSettings = {
  /** Who hears that the remote stopped answering: the banner only, or the inbox too. */
  notify: "banner" | "inbox";
  /** Take over on its own after this many minutes unreachable; null for only when someone does. */
  takeOverAfter: number | null;
  /** When a takeover goes back once the remote answers: when someone says, or by itself when clean. */
  handBack: "ask" | "when_clean";
  keepCiWarm: boolean;
  githubWorkflows: boolean;
  holdDeploys: boolean;
  /** For followers: pushes made on the remote itself. */
  remotePushes: "adopt" | "overwrite";
};

export const DEFAULT_MIRROR_SETTINGS: MirrorSettings = {
  notify: "banner",
  takeOverAfter: null,
  handBack: "when_clean",
  keepCiWarm: false,
  githubWorkflows: true,
  holdDeploys: true,
  remotePushes: "adopt",
};

/** The shortest and longest wait before an automatic takeover, in minutes. */
export const TAKE_OVER_AFTER_MINUTES = [5, 24 * 60] as const;

export type Remote = {
  id: string;
  repoId: string;
  repo: string;
  provider: RemoteProvider;
  role: RemoteRole;
  /** For people: `github.com/acme/web`. */
  name: string;
  url: string;
  state: RemoteState;
  stateSince: string;
  /** A username, or `g1t` when it happened on its own. */
  stateBy: string | null;
  reachable: boolean;
  unreachableSince: string | null;
  syncedAt: string | null;
  lastError: string | null;
  settings: MirrorSettings;
  createdAt: string;
};

export type RefAction = "same" | "push" | "fetch" | "pull_request" | "diverged";
export type RefDecision = "keep_ours" | "keep_theirs" | "pull_request";

export type RefPlan = {
  ref: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  action: RefAction;
  decision: RefDecision | null;
};

export type HandbackPlan = {
  refs: RefPlan[];
  reachable: boolean;
  ready: boolean;
};

export type MirrorView = {
  remotes: Remote[];
  plan: HandbackPlan | null;
  canManage: boolean;
  /** What the last action did that people should know: pull requests it opened, and so on. */
  notes?: string[];
};

export type RemoteBrief = {
  repoId: string;
  role: RemoteRole;
  name: string;
  state: RemoteState;
  reachable: boolean;
  /** When g1t last copied from it or pushed to it. */
  syncedAt?: string | null;
};

export type MirrorAddInput = {
  provider: Exclude<RemoteProvider, "github">;
  role: RemoteRole;
  url: string;
  username?: string | null;
  token?: string | null;
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

/** Mirroring: methods of the integrations service. */
export function mirrorsClient(integrations: ServiceBinding) {
  const call = <T>(method: string, args: object) => rpc<T>(integrations, method, args);
  return {
    view: (viewer: User | null, repoId: string) => call<Result<MirrorView>>("mirror_view", { viewer, repoId }),
    briefs: (repoIds: string[]) => call<RemoteBrief[]>("mirror_briefs", { repoIds }),
    takeOver: (actor: User, repoId: string) => call<Result<MirrorView>>("mirror_take_over", { actor, repoId }),
    ci: (actor: User, repoId: string, on: boolean) => call<Result<MirrorView>>("mirror_ci", { actor, repoId, on }),
    plan: (actor: User, repoId: string) => call<Result<MirrorView>>("mirror_hand_back_plan", { actor, repoId }),
    handBack: (actor: User, repoId: string, decisions: Record<string, RefDecision>) =>
      call<Result<MirrorView>>("mirror_hand_back", { actor, repoId, decisions }),
    moveIn: (actor: User, repoId: string, keepRemoteUpdated: boolean) =>
      call<Result<MirrorView>>("mirror_move_in", { actor, repoId, keepRemoteUpdated }),
    sync: (actor: User, repoId: string) => call<Result<MirrorView>>("mirror_sync", { actor, repoId }),
    settings: (actor: User, remoteId: string, settings: MirrorSettings) =>
      call<Result<Remote>>("mirror_settings", { actor, remoteId, settings }),
    add: (actor: User, repoId: string, input: MirrorAddInput) => call<Result<Remote>>("mirror_add", { actor, repoId, ...input }),
    remove: (actor: User, remoteId: string) => call<Result<boolean>>("mirror_remove", { actor, remoteId }),
  };
}
