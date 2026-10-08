/**
 * A project's links: its homepage, its docs, any others, and production's
 * address when it is deployed elsewhere. Each is an http(s) address,
 * tidied as a repository's website is (crates/contracts/src/repos.rs
 * `clean_website`): `https://` added when no scheme is given, anything else
 * refused. A repository's own project follows its website as homepage
 * until the project is given one of its own, as its description does.
 */

import type { ProjectLink, ProjectLinks } from "@g1t/contracts";

// As contracts' MAX_PROJECT_LINKS, MAX_LINK_LABEL and MAX_LINK_URL; repeated
// so this module's tests run without the package.
const MAX_PROJECT_LINKS = 10;
const MAX_LINK_LABEL = 40;
const MAX_LINK_URL = 255;

export type Cleaned<T> = { ok: true; value: T } | { ok: false; message: string };

/** An address as it is kept; null for blank. `what` names it in the refusal. */
export function cleanUrl(text: string | null | undefined, what = "A link"): Cleaned<string | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: true, value: null };
  let url: string;
  if (/^https?:\/\//i.test(trimmed)) url = trimmed.replace(/^https?/i, (scheme) => scheme.toLowerCase());
  else if (trimmed.includes("://") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed.split("/")[0]!.replace(/:\d+$/, ""))) {
    return { ok: false, message: `${what} is an http or https address.` };
  } else url = `https://${trimmed}`;
  const host = url.split("://")[1]!.split(/[/?#]/)[0]!;
  const name = host.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  if (
    url.length > MAX_LINK_URL ||
    /\s/.test(url) ||
    !name.includes(".") ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    !/^[a-z0-9.-]+$/i.test(name) ||
    host.includes("@")
  ) {
    return { ok: false, message: `${what} is not a web address, such as https://example.com.` };
  }
  return { ok: true, value: url };
}

/**
 * The links to keep: each with a label and an address, blank rows left
 * out, at most `MAX_PROJECT_LINKS`. A label is the address's host when
 * none is given.
 */
export function cleanLinks(input: unknown): Cleaned<ProjectLink[]> {
  if (!Array.isArray(input)) return { ok: false, message: "Give links as a list of labels and addresses." };
  const kept: ProjectLink[] = [];
  for (const item of input) {
    const entry = (item ?? {}) as { label?: unknown; url?: unknown };
    const label = typeof entry.label === "string" ? entry.label.trim().replace(/\s+/g, " ") : "";
    const raw = typeof entry.url === "string" ? entry.url : "";
    if (!label && !raw.trim()) continue;
    const url = cleanUrl(raw, label ? `The address for ${label}` : "A link");
    if (!url.ok) return url;
    if (!url.value) return { ok: false, message: `Give ${label} an address.` };
    if (label.length > MAX_LINK_LABEL) return { ok: false, message: `A link's label is at most ${MAX_LINK_LABEL} characters.` };
    kept.push({ label: label || url.value.split("://")[1]!.split(/[/?#]/)[0]!, url: url.value });
  }
  if (kept.length > MAX_PROJECT_LINKS) return { ok: false, message: `A project keeps at most ${MAX_PROJECT_LINKS} links besides its homepage and docs.` };
  return { ok: true, value: kept };
}

/** Links as stored: a JSON list; anything unreadable is none. */
export function storedLinks(text: string | null | undefined): ProjectLink[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((link): link is ProjectLink => typeof link?.label === "string" && typeof link?.url === "string")
      .slice(0, MAX_PROJECT_LINKS);
  } catch {
    return [];
  }
}

/**
 * The links a project shows, from its row. Only a repository's own
 * project (its primary one) follows the repository's website: another
 * project in it, from a directory of its own, is something else.
 */
export function projectLinks(row: {
  is_primary?: number;
  homepage?: string | null;
  repo_website?: string | null;
  docs_url?: string | null;
  links?: string | null;
}): ProjectLinks {
  const own = row.homepage ?? null;
  const repo = row.is_primary ? (row.repo_website ?? null) : null;
  return {
    homepage: own ?? repo,
    homepageInherited: own == null && repo != null,
    docs: row.docs_url ?? null,
    custom: storedLinks(row.links),
  };
}
