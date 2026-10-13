/**
 * Guardrails: how long a workspace's runs may take, kept by the work
 * service. Mirrors `g1t_contracts::guardrails`. Sandboxes reach the
 * internet as any CI machine does; guardrails say nothing about the
 * network.
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/** What one level, the workspace or a project, sets. Unset is inherited. */
export type GuardrailSettings = {
  /** How long each kind of run may take, in minutes. */
  minutes?: Record<string, number>;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

/** What a run actually gets. */
export type Guardrails = {
  /**
   * No longer sent: command rules, deny patterns and the cost cap were for
   * g1t's own agents. Kept optional for the runner, which still passes
   * them on (and a plan's cost cap) when they are there.
   */
  rules?: Record<string, boolean>;
  deny?: string[];
  budgetUsd?: number | null;
  minutes: Record<string, number>;
};

export type GuardrailsView = {
  workspace: GuardrailSettings;
  project: GuardrailSettings | null;
  defaults: Guardrails;
  /** g1t's defaults with the workspace's: what a project inherits. */
  inherited: Guardrails;
  effective: Guardrails;
};

export interface GuardrailsApi {
  /** Members only. With `repo`, that project's level too. */
  getGuardrails(viewer: Viewer, workspace: string, repo?: RepoPath | null): Promise<Result<GuardrailsView>>;
  /** The workspace's level (owners), or with `repo`, that project's (members). */
  updateGuardrails(
    actor: User,
    workspace: string,
    repo: RepoPath | null,
    settings: GuardrailSettings,
  ): Promise<Result<GuardrailsView>>;
  /**
   * For the runner: what a run in `repo` gets, which is always its
   * project's. `repoId` names the project however it has moved since; a
   * pull request's working copy (`pulls/<pull id>`) stands for the
   * repository the pull request is to.
   */
  runGuardrails(repo: RepoPath, repoId?: string | null): Promise<Result<Guardrails>>;
}

/** The guardrails methods of the work service. */
export function guardrailsClient(service: ServiceBinding): GuardrailsApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    getGuardrails: (viewer, workspace, repo) => call("get_guardrails", { viewer, workspace, repo: repo ?? null }),
    updateGuardrails: (actor, workspace, repo, settings) =>
      call("update_guardrails", { actor, workspace, repo, settings }),
    runGuardrails: (repo, repoId) => call("run_guardrails", { repo, repo_id: repoId ?? null }),
  };
}
