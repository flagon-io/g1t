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
  "register", "verify", "forgot", "reset", "device", "oauth", "invite",
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
  /** Tell them to ask a workspace owner for access. */
  askOwner: boolean;
};

/** What the page says for this kind of thing, to whoever is looking. */
export function notFoundCopy(kind: MissingKind, username: string | null | undefined): NotFoundCopy {
  // People are public: a name either belongs to someone or it does not.
  if (kind === "person") {
    return {
      title: "No one goes by that name",
      body: "Check the spelling, or search for them.",
      signedInAs: null,
      signIn: false,
      askOwner: false,
    };
  }
  const noun = NOUN[kind];
  if (!username) {
    return {
      title: `Sign in to see this ${noun}`,
      body: "It may be private, or it may not exist.",
      signedInAs: null,
      signIn: true,
      askOwner: false,
    };
  }
  return {
    title: `This ${noun} doesn't exist, or you don't have access to it`,
    body: "",
    signedInAs: username,
    signIn: false,
    askOwner: true,
  };
}
