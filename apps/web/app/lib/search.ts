/**
 * Building search queries and addresses on the site: the filters on the
 * search page change the query people can see and edit, never something
 * hidden, so a search is always one shareable address.
 */
import type { SearchType } from "@g1t/contracts";

/** The qualifiers a search understands, as the help lists them. */
export const QUALIFIERS: { example: string; means: string }[] = [
  { example: "repo:acme/web", means: "Only in one repository" },
  { example: "org:acme", means: "Only in one workspace (also workspace:acme)" },
  { example: "language:rust", means: "Code in a language, or repositories mostly in it" },
  { example: "path:src/", means: "Code under a path; path:*.rs for a pattern" },
  { example: "is:issue  is:pr", means: "Only issues, or only pull requests" },
  { example: "is:open  is:closed  is:merged", means: "Issues and pull requests by state" },
  { example: "author:ana", means: "Opened by someone" },
  { example: "label:bug", means: "Issues and pull requests with a label" },
  { example: "\"exact phrase\"", means: "These words together, in this order" },
  { example: "-word  -label:wontfix", means: "Leave out what has it" },
];

/** Languages offered by the language filter; any other can be typed. */
export const LANGUAGES = [
  "rust",
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "ruby",
  "java",
  "kotlin",
  "swift",
  "c",
  "c++",
  "c#",
  "php",
  "elixir",
  "shell",
  "sql",
  "html",
  "css",
  "markdown",
  "yaml",
  "toml",
  "json",
];

/** What each tab is called. */
export const TYPE_LABELS: Record<SearchType, string> = {
  repositories: "Repositories",
  code: "Code",
  issues: "Issues",
  pulls: "Pull requests",
  people: "People",
};

/** Splits a query into its tokens, keeping quoted runs whole. */
export function tokens(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

/** The value of a qualifier in a query, the first if it is given more than once. */
export function qualifier(query: string, key: string): string | null {
  for (const token of tokens(query)) {
    const [name, ...rest] = token.split(":");
    if (name?.toLowerCase() === key && rest.length) return rest.join(":").replace(/^"|"$/g, "") || null;
  }
  return null;
}

/**
 * The query with `key:value` in place of any `key:` it had; with `value`
 * null, without it. `aliases` are other names for the same qualifier
 * (`org` and `workspace`), removed as well. Kept in the order written.
 */
export function withQualifier(query: string, key: string, value: string | null, aliases: string[] = []): string {
  const names = new Set([key, ...aliases]);
  const kept = tokens(query).filter((token) => {
    const name = token.split(":")[0]?.toLowerCase() ?? "";
    return !(token.includes(":") && names.has(name));
  });
  if (value) kept.push(`${key}:${/\s/.test(value) ? `"${value}"` : value}`);
  return kept.join(" ");
}

/** `is:` values of one family set to `value`, the family's others removed. */
export function withIs(query: string, family: string[], value: string | null): string {
  const kept = tokens(query).filter((token) => {
    const [name, rest] = token.split(":");
    return !(name?.toLowerCase() === "is" && family.includes((rest ?? "").toLowerCase()));
  });
  if (value) kept.push(`is:${value}`);
  return kept.join(" ");
}

/** The `is:` value of a family the query has, if any. */
export function isValue(query: string, family: string[]): string | null {
  for (const token of tokens(query)) {
    const [name, rest] = token.split(":");
    if (name?.toLowerCase() === "is" && family.includes((rest ?? "").toLowerCase())) return rest!.toLowerCase();
  }
  return null;
}

/** The address of a search. */
export function searchHref(query: string, type?: SearchType | null, page?: number): string {
  const params = new URLSearchParams();
  params.set("q", query.trim());
  if (type) params.set("type", type);
  if (page && page > 1) params.set("page", String(page));
  return `/search?${params.toString()}`;
}

/** A count as a tab shows it: up to the cap, then "1k+". */
export function shortCount(count: number, cap = 1000): string {
  if (count > cap - 1) return "1k+";
  return String(count);
}
