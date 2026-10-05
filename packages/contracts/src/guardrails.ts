/**
 * Guardrails: what a workspace lets its agents do in a sandbox, kept by the
 * work service. Mirrors `g1t_contracts::guardrails`.
 */
import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/** What one level, the workspace or a project, sets. Unset is inherited. */
export type GuardrailSettings = {
  restrictNetwork?: boolean | null;
  /** The registries that are on, by id. Replaces the inherited list. */
  registries?: string[] | null;
  /** More hosts to allow; they add to the other level's. */
  domains?: string[];
  /** Built-in command rules turned on or off, by id. */
  rules?: Record<string, boolean>;
  /** Permission rules to refuse; they add to the other level's. */
  deny?: string[];
  /** The most a run may cost, in US dollars. Zero means no cap. */
  budgetUsd?: number | null;
  /** How long each kind of run may take, in minutes. */
  minutes?: Record<string, number>;
  updatedBy?: string | null;
  updatedAt?: string | null;
};

/** What a run actually gets. */
export type Guardrails = {
  restrictNetwork: boolean;
  registries: string[];
  domains: string[];
  /** Every host a sandbox may reach. `*.example.com` covers subdomains. */
  hosts: string[];
  rules: Record<string, boolean>;
  deny: string[];
  /** Null: no cap. */
  budgetUsd: number | null;
  minutes: Record<string, number>;
};

export type RegistryInfo = { id: string; name: string; hosts: string[] };
export type RuleInfo = { id: string; title: string; about: string };

export type GuardrailsView = {
  workspace: GuardrailSettings;
  project: GuardrailSettings | null;
  defaults: Guardrails;
  /** g1t's defaults with the workspace's: what a project inherits. */
  inherited: Guardrails;
  effective: Guardrails;
  g1tHosts: string[];
  registries: RegistryInfo[];
  rules: RuleInfo[];
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
  /** For the runner: what a run in `repo` gets. */
  runGuardrails(repo: RepoPath): Promise<Result<Guardrails>>;
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
    runGuardrails: (repo) => call("run_guardrails", { repo }),
  };
}
