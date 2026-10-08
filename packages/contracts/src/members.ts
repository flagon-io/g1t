/**
 * A workspace's members: owners and members, the roles that add to a
 * member, and what members are allowed to do. Mirrors
 * `crates/contracts/src/members.rs`.
 */

/** A role a member can hold besides owner or member. Owners have both already. */
export type OrgRole = "billing_manager" | "security_manager";

export const ORG_ROLES: readonly OrgRole[] = ["billing_manager", "security_manager"];

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  billing_manager: "Billing manager",
  security_manager: "Security manager",
};

/** One line on what each role gives, as People shows it. */
export const ORG_ROLE_SUMMARIES: Record<OrgRole, string> = {
  billing_manager: "Manages the budget, AI credit, payment, invoices and billing details. Nothing on repositories.",
  security_manager: "Reads every repository, and sees and manages every security alert and security setting.",
};

/** What a workspace lets its members do. The names are the REST API's. */
export type MemberPrivileges = {
  members_can_create_public_repositories: boolean;
  members_can_create_private_repositories: boolean;
  members_can_change_repo_visibility: boolean;
  members_can_delete_repositories: boolean;
  members_can_invite_outside_collaborators: boolean;
};

export const DEFAULT_MEMBER_PRIVILEGES: MemberPrivileges = {
  members_can_create_public_repositories: true,
  members_can_create_private_repositories: true,
  members_can_change_repo_visibility: true,
  members_can_delete_repositories: false,
  members_can_invite_outside_collaborators: true,
};

/** A workspace a person belongs to and cannot use until they meet its policy. */
export type PolicyHold = {
  slug: string;
  reason: string;
  gap: "two_factor" | "verified_email" | "email_domain";
};
