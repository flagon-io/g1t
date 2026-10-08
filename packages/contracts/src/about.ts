/**
 * A repository's About, as its Files page shows it beside the files: its
 * license, security policy and languages, its contributors, its stars and
 * its releases. Mirrors `crates/contracts/src/about.rs`.
 *
 * What is read from files and history is worked out in the background for
 * the default branch's head and kept by commit: an answer can be for an
 * older commit (`commit` is not `head`) while the newer one is worked out,
 * or `pending` when nothing has been worked out yet.
 */
import type { Repo } from "./repos";

export type LanguageShare = {
  name: string;
  /** `#rrggbb`, the color it is known by. */
  color: string | null;
  bytes: number;
  /** Of the bytes counted, to one decimal place. */
  percent: number;
};

export type License = {
  /** `MIT`, `Apache-2.0`; null when the text is not one g1t recognizes. */
  spdxId: string | null;
  /** "MIT License", or "Other". */
  name: string;
  /** The file it was read from: `LICENSE`. */
  path: string;
};

/** `user`: matched to an account. `g1t`: g1t itself. `author`: the name on the commits. */
export type ContributorKind = "user" | "g1t" | "author";

/** Commits in the week starting on Monday `week` (`YYYY-MM-DD`, UTC). */
export type WeekCommits = { week: string; commits: number };

export type Contributor = {
  kind: ContributorKind;
  name: string;
  username?: string | null;
  avatar?: string | null;
  commits: number;
  firstAt: string;
  lastAt: string;
  /** Only for the most active contributors, on the Contributors page. */
  weeks: WeekCommits[];
};

export type Freshness = {
  /** The default branch's head; null for an empty repository. */
  head: string | null;
  /** The commit the answer was worked out for. */
  commit: string | null;
  computedAt: string | null;
  /** Nothing worked out yet: ask again shortly. */
  pending: boolean;
  /** Too large to read in full: counts what was read. */
  partial: boolean;
};

export type Languages = Freshness & { languages: LanguageShare[] };

export type Contributors = Freshness & {
  total: number;
  /** The commits read. */
  commits: number;
  contributors: Contributor[];
  /** Every commit read, by week, oldest first, empty weeks included. */
  weeks: WeekCommits[];
};

export type Release = {
  id: string;
  tagName: string;
  /** The commit the tag named. */
  target: string;
  name: string | null;
  /** Markdown. */
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: string | null;
  createdAt: string;
  /** Null while it is a draft. */
  publishedAt: string | null;
  latest: boolean;
};

export const MAX_RELEASE_NAME_CHARS = 200;
export const MAX_RELEASE_BODY_CHARS = 125_000;

export type Stargazer = { username: string; avatar: string | null; starredAt: string };
export type StarredRepo = { repo: Repo; starredAt: string; stars: number };
export type Stars = { starred: boolean; stars: number };

export type RepoAbout = Freshness & {
  license: License | null;
  /** Path of SECURITY.md, when it has one. */
  securityPolicy: string | null;
  languages: LanguageShare[];
  /** How many contributors there are. */
  contributors: number;
  /** The most active, without their weeks. */
  topContributors: Contributor[];
  stars: number;
  starred: boolean;
  /** Releases the viewer can see. */
  releases: number;
  latestRelease: Release | null;
};

export type NewRelease = {
  tagName: string;
  /** A branch or commit for a tag that does not exist yet; the default branch when absent. */
  target?: string | null;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
};

export type ReleaseChange = { name?: string; body?: string; draft?: boolean; prerelease?: boolean };
