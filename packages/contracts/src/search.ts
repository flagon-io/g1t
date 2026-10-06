import type { ServiceBinding } from "./clients";
import type { Viewer } from "./identity";
import type { Result } from "./result";

/**
 * Search across all of g1t: repositories (name, description, topics,
 * README), code on default branches, issues and pull requests, people and
 * workspaces. Everything public, and private content the viewer is a member
 * of, decided when the query runs. Mirrors `crates/contracts/src/search.rs`.
 */

/** One tab of results. */
export type SearchType = "repositories" | "code" | "issues" | "pulls" | "people";

export const SEARCH_TYPES: SearchType[] = ["repositories", "code", "issues", "pulls", "people"];

/** The most results on one page, and how many a page has when none is asked for. */
export const MAX_PER_PAGE = 50;
export const DEFAULT_PER_PAGE = 20;
/** Counts stop here: past it a tab says "1,000+". */
export const COUNT_CAP = 1000;

/** A piece of a snippet, highlighted where it matched the query. */
export type Segment = { text: string; highlight: boolean };

/** A line of code in a result, numbered from 1. */
export type CodeLine = { number: number; parts: Segment[] };

export type HitKind = "repository" | "code" | "issue" | "pull" | "user" | "workspace";

/** One result. Which fields are set depends on `kind`. */
export type SiteHit = {
  kind: HitKind;
  /** `acme/web`, a file's path, an issue's title, a person's name. */
  title: string;
  /** A path on g1t.sh: `/acme/web/blob/main/src/app.rs#L12`. */
  url: string;
  /** `owner/name`, for everything but people. */
  repo: string | null;
  private: boolean;
  description: string | null;
  snippet: Segment[];
  /** Code only: the lines that matched, with a line around each. */
  lines: CodeLine[];
  path: string | null;
  language: string | null;
  ref: string | null;
  number: number | null;
  /** `open`/`closed` for an issue; `draft`/`open`/`merged`/`closed` for a pull request. */
  state: string | null;
  author: string | null;
  labels: string[];
  topics: string[];
  /** A username or a workspace's slug. */
  slug: string | null;
  avatar: string | null;
  /** RFC 3339. */
  updatedAt: string | null;
};

export type SearchCounts = Record<SearchType, number>;

export type SearchResults = {
  /** The query as it was read. */
  query: string;
  type: SearchType;
  counts: SearchCounts;
  page: number;
  perPage: number;
  more: boolean;
  hits: SiteHit[];
  /** What the query could not do, said plainly. */
  notes: string[];
};

export type ExploreRepo = {
  namespace: string;
  name: string;
  description: string | null;
  topics: string[];
  language: string | null;
  createdAt: string;
  pushedAt: string | null;
  /** Whether it is archived: read-only, kept for reference. */
  archived: boolean;
};

export type Facet = { name: string; count: number };

export type Explore = {
  repos: ExploreRepo[];
  languages: Facet[];
  topics: Facet[];
  page: number;
  more: boolean;
};

export interface SearchApi {
  /** One page of results of one type, with counts for every type. */
  search(
    viewer: Viewer,
    query: string,
    options?: { type?: SearchType | null; page?: number; perPage?: number },
  ): Promise<Result<SearchResults>>;
  /** A few repositories, issues, pull requests and people, as someone types. */
  suggest(viewer: Viewer, query: string): Promise<SiteHit[]>;
  /** Public repositories, recently active or new, by language or topic. */
  explore(
    viewer: Viewer,
    options?: { sort?: "active" | "new"; language?: string | null; topic?: string | null; page?: number },
  ): Promise<Explore>;
}

export function searchClient(service: ServiceBinding): SearchApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    search: (viewer, query, options = {}) =>
      call("search", { viewer, query, type: options.type ?? null, page: options.page ?? null, perPage: options.perPage ?? null }),
    suggest: (viewer, query) => call("suggest", { viewer, query }),
    explore: (viewer, options = {}) =>
      call("explore", {
        viewer,
        sort: options.sort ?? null,
        language: options.language ?? null,
        topic: options.topic ?? null,
        page: options.page ?? null,
      }),
  };
}

/** Reads a type as an address or a person writes it; null when it is not one. */
export function searchType(value: string | null | undefined): SearchType | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "repositories":
    case "repos":
    case "repo":
      return "repositories";
    case "code":
      return "code";
    case "issues":
    case "issue":
      return "issues";
    case "pulls":
    case "prs":
    case "pr":
      return "pulls";
    case "people":
    case "users":
      return "people";
    default:
      return null;
  }
}
