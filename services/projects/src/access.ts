/**
 * Who may do what with a project: each method's capability on the
 * project's repository. Seeing a project takes Read; changing it (its name,
 * root directory and settings) takes Maintain (`manage_settings`).
 * Types only, so the table is tested apart from the service.
 */

import type { Capability, RepoRef } from "@g1t/contracts";

export const NEEDS = {
  get: "read",
  create: "manage_settings",
  update: "manage_settings",
} as const satisfies Record<string, Capability>;

/** The repository a stored project's permission comes from. */
export function repoRef(row: { repo_id: string; repo_namespace: string; repo_private: number | boolean }): RepoRef {
  return { id: row.repo_id, namespace: row.repo_namespace, isPrivate: !!row.repo_private };
}
