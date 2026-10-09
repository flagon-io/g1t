/**
 * Who may do what with a project's deployments: each method's capability
 * on the project's repository. Seeing deployments takes Read; deploying,
 * redeploying and taking an app down spend compute and take Write (`run`);
 * deployment settings and domains take Admin (`manage_integrations`).
 * Types only, so the table is tested apart from the service.
 */

import type { Capability, Project, RepoRef, User } from "@g1t/contracts";

export const NEEDS = {
  settings: "read",
  list: "read",
  get: "read",
  listDomains: "read",
  redeploy: "run",
  takeDown: "run",
  updateSettings: "manage_integrations",
  addDomain: "manage_integrations",
  removeDomain: "manage_integrations",
  refreshDomain: "manage_integrations",
} as const satisfies Record<string, Capability>;

export type Method = keyof typeof NEEDS;

/** The repository a project's permission comes from. A mirrored one has none: its workspace's base permission decides. */
export function repoRef(project: Project): RepoRef {
  if (project.source.kind === "hosted") {
    return { id: project.source.repoId, namespace: project.source.repo.namespace, isPrivate: project.private };
  }
  return { id: "", namespace: project.workspace, isPrivate: project.private };
}

/**
 * Whether whoever a pull request is for is trusted with a project's secrets
 * without asking what they may do: only g1t itself, in work nobody asked it
 * for. A change g1t made for someone is for them (`workOwner`), and they are
 * asked about like anyone else.
 */
export function trustedOutright(owner: Pick<User, "kind">): boolean {
  return owner.kind === "agent" || owner.kind === "system";
}
