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

/** The repository a project's permission comes from. */
export function repoRef(project: Project): RepoRef {
  return { id: project.source.repoId, namespace: project.source.repo.namespace, isPrivate: project.private };
}

/**
 * Whether whoever a pull request is for is trusted with a project's secrets
 * without asking what they may do: only g1t's own system work. A pull
 * request g1t's former agent opened is its requester's (`workOwner`), or,
 * when nobody asked for it, trusted no further than anyone else: they are
 * asked about like anyone else.
 */
export function trustedOutright(owner: Pick<User, "kind">): boolean {
  return owner.kind === "system";
}
