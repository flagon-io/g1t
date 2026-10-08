/**
 * Who a commit is by, as g1t shows it: the account its author address
 * belongs to, else the name written on the commit.
 *
 * Git records a name and an address; g1t matches the address to an
 * account by a confirmed address or the account's noreply address
 * (`email_owners` in services/identity), never an unconfirmed one. The
 * address itself never reaches the page: a commit is shown with the
 * person, not the address, so a private address stays private.
 */
import type { Blame, Commit, Contributor, EmailOwner } from "@g1t/contracts";

/**
 * One person on a commit. `user` is an account; `g1t` is g1t itself;
 * `ghost` is an account that was deleted; `author` is nobody on g1t,
 * shown by the name on the commit, with no link and no card.
 */
export type CommitPerson = {
  kind: "user" | "g1t" | "ghost" | "author";
  /** The name written on the commit. Beside an account it is a hint. */
  name: string;
  /** The account's username; null for `author`. */
  username: string | null;
  /** The account's uploaded avatar, by hash. */
  avatar: string | null;
};

/** A commit as the page gets it: its people, never their addresses. */
export type ShownCommit = Omit<Commit, "author"> & {
  author: CommitPerson;
  /** From `Co-authored-by` trailers, in order. */
  coAuthors: CommitPerson[];
};

/** Who last changed each line, with the commits' people. */
export type ShownBlame = Omit<Blame, "commits"> & { commits: ShownCommit[] };

/** A commit as a file list's row shows it: no people at all. */
export type FileCommit = Pick<Commit, "hash" | "message" | "authoredAt">;

/** Each entry's last commit; `complete` is false when some were not reached. */
export type FileCommits = { entries: { name: string; commit: FileCommit }[]; complete: boolean };

/**
 * The addresses on g1t's own commits: its noreply address, and those its
 * agents and merge queue used before (as "g1t agent"), which history
 * keeps. Every one is shown as g1t.
 */
export const G1T_COMMIT_EMAILS: ReadonlySet<string> = new Set([
  "g1t@users.noreply.g1t.sh",
  "agent@g1t.sh",
  "queue@g1t.sh",
  "mergecheck@g1t.sh",
]);

const CO_AUTHOR = /^co-authored-by:\s*(.*?)\s*<([^>]*)>\s*$/i;

/** The name and address in each `Co-authored-by` trailer of a message. */
export function coAuthorsOf(message: string): { name: string; email: string }[] {
  const lines = message.trim().split("\n");
  const last = lines.slice(lines.lastIndexOf("") + 1);
  const found: { name: string; email: string }[] = [];
  for (const line of last) {
    const match = CO_AUTHOR.exec(line.trim());
    if (match) found.push({ name: match[1]!.trim(), email: match[2]!.trim() });
  }
  return found;
}

/** Lowercased and trimmed, as `email_owners` keys them. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Every distinct address the commits name, authors and co-authors, that
 * needs asking about: g1t's own are known already.
 */
export function addressesToMatch(commits: readonly Pick<Commit, "author" | "message">[]): string[] {
  const seen = new Set<string>();
  const add = (email: string) => {
    const one = normalizeEmail(email);
    if (one && one.includes("@") && !G1T_COMMIT_EMAILS.has(one)) seen.add(one);
  };
  for (const commit of commits) {
    add(commit.author.email);
    for (const co of coAuthorsOf(commit.message)) add(co.email);
  }
  return [...seen];
}

/** The person a name and address on a commit belong to. */
export function personFor(name: string, email: string, owners: Readonly<Record<string, EmailOwner>>): CommitPerson {
  const written = name.trim() || "Unknown";
  const address = normalizeEmail(email);
  if (G1T_COMMIT_EMAILS.has(address)) return { kind: "g1t", name: written, username: "g1t", avatar: null };
  const owner = address ? owners[address] : undefined;
  if (owner?.username === "ghost") return { kind: "ghost", name: written, username: "ghost", avatar: null };
  if (owner) return { kind: "user", name: written, username: owner.username, avatar: owner.avatar };
  return { kind: "author", name: written, username: null, avatar: null };
}

/** A commit with its people found and its author's address left out. */
export function showCommit(commit: Commit, owners: Readonly<Record<string, EmailOwner>>): ShownCommit {
  const { author, ...rest } = commit;
  return {
    ...rest,
    author: personFor(author.name, author.email, owners),
    coAuthors: coAuthorsOf(commit.message).map((co) => personFor(co.name, co.email, owners)),
  };
}

/**
 * A repository's contributor as a person on its commits. The repos
 * service tallies them by the same rules (services/repos/src/contributors.rs:
 * `email_owners`, then g1t's addresses, then the name), so the About, the
 * Contributors page and every commit show one person the same way.
 */
export function contributorPerson(contributor: Pick<Contributor, "kind" | "name" | "username" | "avatar">): CommitPerson {
  if (contributor.kind === "g1t") return { kind: "g1t", name: contributor.name, username: "g1t", avatar: null };
  if (contributor.kind === "user" && contributor.username === "ghost") return { kind: "ghost", name: contributor.name, username: "ghost", avatar: null };
  if (contributor.kind === "user" && contributor.username) {
    return { kind: "user", name: contributor.name, username: contributor.username, avatar: contributor.avatar ?? null };
  }
  return { kind: "author", name: contributor.name, username: null, avatar: null };
}

/** What a person on a commit is called on the page. */
export function shownName(person: CommitPerson): string {
  return person.username ?? person.name;
}

/** Where a person on a commit links to, if anywhere. */
export function profileHref(person: CommitPerson): string | null {
  return person.kind === "user" && person.username ? `/u/${person.username}` : null;
}
