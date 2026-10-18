/**
 * Who may do what to a work item: lib/work-items.ts has the rest of how
 * the site shows them.
 */
import { type Abilities, CAPABILITIES, type Capability, type RepoRole, type User, allows, granted, maxRole, permission } from "@g1t/contracts";

/**
 * The viewer's role on a work item of `workspace`, as
 * `crates/contracts/src/access.rs` `item_role` reads it: the better of
 * what their membership of the workspace gives (at least Read, since every
 * member sees its work) and their role on its origin repository. Null
 * when they may not see it.
 */
export function itemRole(
  viewer: User | null | undefined,
  workspace: string,
  origin: { id: string; namespace: string; isPrivate: boolean } | null,
): RepoRole | null {
  const slug = workspace.toLowerCase();
  const member = viewer?.workspaces?.some((m) => m.slug.toLowerCase() === slug)
    ? maxRole(granted(viewer, { id: "", namespace: slug, isPrivate: true }), "read")
    : null;
  return maxRole(member, origin ? permission(viewer, origin) : null);
}

/** Whether the viewer may do `capability` on a work item, by the same table as a repository's. */
export function canItem(
  viewer: User | null | undefined,
  workspace: string,
  origin: { id: string; namespace: string; isPrivate: boolean } | null,
  capability: Capability,
): boolean {
  return allows(itemRole(viewer, workspace, origin), capability);
}

/** Every capability, true or false, for one viewer on a work item: what its page passes to its parts. */
export function itemAbilities(
  viewer: User | null | undefined,
  workspace: string,
  origin: { id: string; namespace: string; isPrivate: boolean } | null,
): Abilities {
  const role = itemRole(viewer, workspace, origin);
  return Object.fromEntries(CAPABILITIES.map((row) => [row.capability, allows(role, row.capability)])) as Abilities;
}
