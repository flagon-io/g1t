/**
 * Full-text search over pages (D1's FTS5): turning what someone typed into
 * a safe query, and deciding which spaces a search may look in. Pure.
 */

/**
 * A query as FTS5 understands it: each word quoted (so `-`, `:` and
 * operators are text, never syntax), every word required, the last one a
 * prefix so results come as you type. Null when nothing searchable is left.
 */
export function ftsQuery(text: string): string | null {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => `"${w.replace(/"/g, "")}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

/**
 * Which spaces a search looks in: those the reader may read, narrowed to
 * one space when asked. An empty list means search nothing.
 */
export function searchSpaces(readable: string[], only: string | null | undefined): string[] {
  if (!only) return readable;
  return readable.includes(only) ? [only] : [];
}

/** Whether a page belongs under a project filter: it, or its space, is linked to the project. */
export function inProject(project: string | null | undefined, pageProjects: string[], spaceProjects: string[]): boolean {
  if (!project) return true;
  const want = project.toLowerCase();
  return pageProjects.some((p) => p.toLowerCase() === want) || spaceProjects.some((p) => p.toLowerCase() === want);
}

/** A project reference as stored: `owner/name`, lowercased; null when it is not one. */
export function projectRef(value: string): string | null {
  const s = String(value ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/.test(s) ? s : null;
}
