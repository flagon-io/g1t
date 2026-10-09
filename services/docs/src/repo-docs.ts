/** Which of a repository's files are its docs in Docs, and their titles (src/repo-spaces.ts). Pure. */

/** Files kept per repository: the first this many Markdown files, README first, then by path. */
export const MAX_REPO_FILES = 300;

/** Whether a path is one of a project's docs: Markdown under `docs/`, or the README at the root. */
export function isRepoDoc(path: string): boolean {
  if (/^readme\.(md|markdown|mdx)$/i.test(path)) return true;
  return /^docs\/.+\.(md|markdown|mdx)$/i.test(path);
}

/** A file's title: its first heading, the `title:` of its front matter, or its name. */
export function repoDocTitle(path: string, markdown: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const fromFront = front ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(front[1]!)?.[1] : null;
  if (fromFront) return fromFront.slice(0, 200);
  const body = front ? markdown.slice(front[0].length) : markdown;
  const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  if (heading) return heading.replace(/[*_`]/g, "").slice(0, 200);
  const name = path.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
  if (/^readme$/i.test(name)) return path.includes("/") ? path.split("/").slice(-2, -1)[0]! : "README";
  return name.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The docs files in a listing, README first, then by path; at most MAX_REPO_FILES. */
export function pickRepoDocs<T extends { path: string }>(files: T[]): T[] {
  return files
    .filter((f) => isRepoDoc(f.path))
    .sort((a, b) => {
      const ra = a.path.toLowerCase().startsWith("readme.") ? 0 : 1;
      const rb = b.path.toLowerCase().startsWith("readme.") ? 0 : 1;
      return ra - rb || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_REPO_FILES);
}

