import { type Abilities, type Capability, type RepoRole, needs } from "@g1t/contracts";

/**
 * What the viewer may do in the repository being looked at, as the
 * repository's layout loads it for its pages and the sidebar.
 */
export type ViewerAccess = {
  /** Their effective role; null when they cannot see it. */
  role: RepoRole | null;
  /** Whether they have a role of their own, not only because it is public. */
  insider: boolean;
  can: Abilities;
};

/** The title of something the viewer cannot use, saying which role it needs; undefined when they can. */
export function whyNot(can: Abilities | null | undefined, capability: Capability): string | undefined {
  return can?.[capability] ? undefined : needs(capability);
}

/** Whether the viewer sees the repository's settings: Maintain and up. */
export function seesSettings(access: Pick<ViewerAccess, "can" | "insider"> | null | undefined): boolean {
  return Boolean(access?.insider && (access.can.manage_settings || access.can.manage_protection));
}

/** Each settings page and the capability that opens it. */
export const SETTINGS_CAPABILITY: Record<string, Capability> = {
  "": "manage_settings",
  repository: "manage_settings",
  agents: "manage_settings",
  branches: "manage_protection",
  rules: "manage_protection",
  guardrails: "manage_protection",
  webhooks: "manage_integrations",
  secrets: "manage_integrations",
  actions: "manage_integrations",
  environments: "manage_integrations",
  runners: "manage_integrations",
  deployments: "manage_integrations",
  domains: "manage_integrations",
  dependencies: "manage_settings",
  // Write and up can see who has access; Admins change it.
  access: "push",
};
