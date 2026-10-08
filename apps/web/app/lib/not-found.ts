/**
 * What a not-found page says. A private project, issue or workspace and one
 * that does not exist must look the same to someone who cannot see it, so
 * the words depend only on what kind of thing the address names and on who
 * is looking, never on whether it exists.
 */

/** The kind of thing an address names. */
export type MissingKind = "project" | "issue" | "pull" | "workspace" | "person" | "page";

const KINDS: readonly MissingKind[] = ["project", "issue", "pull", "workspace", "person", "page"];

/** Words for each kind, as a sentence uses them. */
const NOUN: Record<MissingKind, string> = {
  project: "project",
  issue: "issue",
  pull: "pull request",
  workspace: "workspace",
  person: "person",
  page: "page",
};

/** Names that are pages of g1t itself, never a workspace. */
const RESERVED = new Set([
  "settings", "explore", "search", "new", "u", "pricing", "avatars", "workspaces", "login", "logout",
  "register", "verify", "confirm-email", "forgot", "reset", "device", "oauth", "invite",
]);

/**
 * The kind a loader said it could not find (`data({ kind }, { status: 404 })`),
 * else the kind the address names. Only the shape of the address is used.
 */
export function missingKind(errorData: unknown, pathname: string): MissingKind {
  const said = (errorData as { kind?: unknown } | null | undefined)?.kind;
  if (typeof said === "string" && (KINDS as readonly string[]).includes(said)) return said as MissingKind;
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "u" && parts.length === 2) return "person";
  if (parts.length === 0 || RESERVED.has(parts[0]!)) return "page";
  if (parts.length === 1) return "workspace";
  if (parts[1] === "-") return "page";
  if (parts.length === 2) return "project";
  if (parts[2] === "issues" && parts.length === 4 && /^\d+$/.test(parts[3]!)) return "issue";
  if (parts[2] === "pull" && parts.length === 4 && /^\d+$/.test(parts[3]!)) return "pull";
  return "page";
}

export type NotFoundCopy = {
  title: string;
  body: string;
  /** Who is signed in, for "Signed in as". Null when no one is. */
  signedInAs: string | null;
  /** Offer to sign in and come back. */
  signIn: boolean;
};

/**
 * What the page says to whoever is looking. Signed out, it says that the
 * page may be private, and to sign in if it is yours; signed in, that it
 * does not exist or they cannot reach it. Never which of the two.
 */
export function notFoundCopy(kind: MissingKind, username: string | null | undefined): NotFoundCopy {
  // People are public: a name either belongs to someone or it does not.
  if (kind === "person") {
    return { title: "Nothing here", body: "No one on g1t goes by that name.", signedInAs: null, signIn: false };
  }
  if (!username) {
    return {
      title: "Nothing here",
      body: "This page doesn't exist, or it's private. Sign in if it's yours.",
      signedInAs: null,
      signIn: true,
    };
  }
  return {
    title: "Nothing here",
    body: "This page doesn't exist, or you don't have access to it.",
    signedInAs: username,
    signIn: false,
  };
}
