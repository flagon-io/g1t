/**
 * A project's description follows its repository's until someone gives the
 * project one of its own. The `description` column holds only that own
 * text (null: inherit); `repo_description` is the repository's, kept from
 * repos like its visibility and default branch.
 */

/** The longest description a project keeps of its own. */
export const MAX_DESCRIPTION = 200;

/** The description a project shows, and whether it is its repository's. */
export function effectiveDescription(row: { description: string | null; repo_description?: string | null }): {
  description: string | null;
  inherited: boolean;
} {
  if (row.description != null) return { description: row.description, inherited: false };
  return { description: row.repo_description ?? null, inherited: true };
}

/**
 * The own description to store for a change: unchanged when none is given,
 * null (follow the repository) for null or blank text, otherwise the text.
 */
export function ownDescription(current: string | null, change: string | null | undefined): string | null {
  if (change === undefined) return current;
  const text = change?.trim() ?? "";
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
}
