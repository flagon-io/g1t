/**
 * Where `#N` in text leads on the site: the rules of
 * `crates/contracts/src/work/refs.rs`, which every reader of references
 * follows. A reference is `#N`, `owner/name#N` (read in that repository)
 * or `workspace#N` (in that workspace). Read in a repository, `#N` is its
 * pull request N, else the work item that was its issue N, else the
 * workspace's work item N, else a pull request N of another of its
 * repositories, numbered after work items came (an older pull request's
 * number is only its repository's): only the work service knows which, so a link goes through
 * `/<owner>/<repo>/ref/<n>`, which asks it (`resolveRef`) and sends the
 * browser on. Read in a workspace alone, `#N` is its work item N, else its
 * pull request N numbered after work items came: the work item's page sends
 * a pull request's number on.
 * Pure, so it is tested under Node.
 */

/** Where text is read: in a repository (and its workspace), or in a workspace alone. */
export type RefContext = { repo: { namespace: string; name: string } } | { workspace: string };

/** A reference found in text. */
export type Ref =
  | { scope: "here"; number: number }
  | { scope: "repo"; namespace: string; name: string; number: number }
  | { scope: "workspace"; workspace: string; number: number };

/** A work item's page. */
export function itemPath(workspace: string, number: number): string {
  return `/${workspace.toLowerCase()}/-/work/${number}`;
}

/** The page that reads `#number` in a repository and sends the browser to what it names. */
export function repoRefPath(repo: { namespace: string; name: string }, number: number): string {
  return `/${repo.namespace.toLowerCase()}/${repo.name}/ref/${number}`;
}

/** Where a reference leads, read in `context`; null for `#N` with no context to read it in. */
export function refHref(ref: Ref, context: RefContext | null | undefined): string | null {
  switch (ref.scope) {
    case "repo":
      return repoRefPath({ namespace: ref.namespace, name: ref.name }, ref.number);
    case "workspace":
      return itemPath(ref.workspace, ref.number);
    case "here":
      if (!context) return null;
      return "repo" in context ? repoRefPath(context.repo, ref.number) : itemPath(context.workspace, ref.number);
  }
}

/** A reference in its written form: `owner/name#12`, `workspace#12` or `#12`. */
export function parseRef(owner: string | undefined, name: string | undefined, number: string): Ref | null {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || number.length > 9) return null;
  if (owner && name) return { scope: "repo", namespace: owner.toLowerCase(), name, number: n };
  if (owner) return { scope: "workspace", workspace: owner.toLowerCase(), number: n };
  return { scope: "here", number: n };
}
