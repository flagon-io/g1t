/**
 * CODEOWNERS: who owns which paths of a repository, read from the branch a
 * pull request merges into. Mirrors `crates/contracts/src/codeowners.rs`,
 * which holds the parser and the rules.
 */

/** Where the file is looked for, first found wins. */
export const CODEOWNERS_LOCATIONS = [
  ".g1t/CODEOWNERS",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  ".gitlab/CODEOWNERS",
] as const;

/** Whether `path` is one of the places a CODEOWNERS file is read from. */
export function isCodeownersPath(path: string): boolean {
  return (CODEOWNERS_LOCATIONS as readonly string[]).includes(path);
}

export type CodeownersErrorKind =
  | "too_large"
  | "negation"
  | "character_range"
  | "bad_pattern"
  | "bad_owner"
  | "bad_section"
  | "unknown_user"
  | "unknown_team"
  | "unknown_email"
  | "no_write_access"
  | "team_no_access";

/** One problem with a CODEOWNERS file, on a line (0 for the whole file). */
export type CodeownersError = {
  line: number;
  kind: CodeownersErrorKind;
  /** The owner or pattern at fault, as written. */
  token: string | null;
  message: string;
};

/** A CODEOWNERS file at one branch, checked like a linter. */
export type CodeownersReport = {
  /** Where it was found; null when there is none. */
  path: string | null;
  ref: string;
  size: number;
  rules: number;
  sections: string[];
  errors: CodeownersError[];
};

/** Where one rule's review stands on a pull request. */
export type OwnerReview = {
  /** The section's name; null for rules before any section. */
  section: string | null;
  line: number;
  pattern: string;
  /** Owners as written: `@ana`, `@acme/backend`, `ana@example.com`. */
  owners: string[];
  files: string[];
  optional: boolean;
  required: number;
  approved_by: string[];
  changes_requested_by: string[];
  satisfied: boolean;
};

/** Who owns what a pull request changes, and whose approval is still needed. */
export type PullCodeOwners = {
  path: string;
  /** Whether branch protection requires code owners' approval. */
  required: boolean;
  reviews: OwnerReview[];
  /** What still stands in the way; null when nothing does. */
  missing: string | null;
  errors: number;
};

/** A short label for an error kind, for the errors view. */
export const CODEOWNERS_ERROR_LABELS: Record<CodeownersErrorKind, string> = {
  too_large: "Too large",
  negation: "Negation",
  character_range: "Character range",
  bad_pattern: "Bad pattern",
  bad_owner: "Bad owner",
  bad_section: "Bad section",
  unknown_user: "Unknown user",
  unknown_team: "Unknown team",
  unknown_email: "Unknown email",
  no_write_access: "No write access",
  team_no_access: "Team without access",
};
