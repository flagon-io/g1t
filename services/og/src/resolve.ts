/**
 * Which card a page of g1t.sh gets, and what it says.
 *
 * Everything here is looked up with no viewer, so a card can only ever show
 * what an anonymous visitor to the page could see. A private repository, a
 * page that does not exist, or anything that fails to load gets the generic
 * card: never a name or a title that a link preview could leak.
 */
import type { IdentityApi, Issue, Project, PullStatus, ReposApi, WorkApi, ProjectsApi } from "@g1t/contracts";

// The one list of Soon pages, shared with the site so the two never disagree.
import { roadmapItem } from "../../../apps/web/app/lib/roadmap.ts";

export type IssueState = "open" | "completed" | "not_planned";

export type Card =
  /**
   * The brand card: the lockup and the tagline. `failed` when a service
   * could not be reached, so the card is not kept for long.
   */
  | { kind: "brand"; failed?: true }
  /** A page of the site that says what g1t is. */
  | { kind: "page"; address: string; eyebrow: string; title: string; description: string }
  | {
      kind: "workspace";
      slug: string;
      name: string;
      description: string | null;
      projects: number;
      /** The uploaded icon's hash, if it has one. */
      avatar?: string | null;
      /** That icon as a data URI, once loaded; see `index.ts`. */
      icon?: string;
    }
  | {
      /** A person's profile, at `/u/<username>`. */
      kind: "person";
      username: string;
      name: string | null;
      bio: string | null;
      /** Over public repositories only. */
      pullsMerged: number;
      pullsOpen: number;
      issues: number;
      avatar?: string | null;
      icon?: string;
    }
  | {
      kind: "project";
      owner: string;
      repo: string;
      name: string;
      description: string | null;
      issues: number;
      pulls: number;
    }
  | {
      kind: "issue";
      owner: string;
      repo: string;
      number: number;
      title: string;
      state: IssueState;
      author: string;
    }
  | {
      kind: "pull";
      owner: string;
      repo: string;
      number: number;
      title: string;
      state: PullStatus;
      author: string;
    }
  | { kind: "soon"; owner: string; repo: string; title: string; summary: string; section: string }
  | { kind: "docs"; title: string; section: string | null; description: string | null };

export const BRAND: Card = { kind: "brand" };

/** The services a card is looked up in: only the calls it needs. */
export type Sources = {
  identity: Pick<IdentityApi, "getWorkspace" | "profile">;
  repos: Pick<ReposApi, "get">;
  work: Pick<WorkApi, "counts" | "getIssue" | "getPull" | "byAuthor">;
  projects: Pick<ProjectsApi, "get" | "list">;
};

/**
 * The site's own pages, which no workspace can be named. Those that say
 * what g1t is get a card of their own; the rest (sign-in, settings and the
 * like) get the brand card.
 */
const PAGES: Record<string, Card> = {
  "": BRAND,
  pricing: {
    kind: "page",
    address: "g1t.sh/pricing",
    eyebrow: "Pricing",
    title: "What it costs us, plus a markup",
    description:
      "g1t passes its costs through: what Cloudflare and model providers charge g1t, plus a set markup. No seats.",
  },
  explore: {
    kind: "page",
    address: "g1t.sh/explore",
    eyebrow: "Explore",
    title: "Public projects on g1t",
    description: "Recently active and new public projects, by language and topic.",
  },
  search: {
    kind: "page",
    address: "g1t.sh/search",
    eyebrow: "Search",
    title: "Search all of g1t",
    description: "Repositories, code, issues, pull requests and people, in one search.",
  },
  policies: {
    kind: "page",
    address: "g1t.sh/policies",
    eyebrow: "Policies",
    title: "The rules we both play by",
    description: "Terms of Service, Privacy Policy, Acceptable Use, refunds and subprocessors, in plain language.",
  },
  "policies/terms": {
    kind: "page",
    address: "g1t.sh/policies/terms",
    eyebrow: "Policies",
    title: "Terms of Service",
    description: "The agreement between you and Flagon, Inc. when you use g1t.",
  },
  "policies/privacy": {
    kind: "page",
    address: "g1t.sh/policies/privacy",
    eyebrow: "Policies",
    title: "Privacy Policy",
    description: "What g1t collects, why, where it goes, and how to see, export or delete it.",
  },
  "policies/acceptable-use": {
    kind: "page",
    address: "g1t.sh/policies/acceptable-use",
    eyebrow: "Policies",
    title: "Acceptable Use Policy",
    description: "What g1t may not be used for, and what happens when it is.",
  },
  "policies/refunds": {
    kind: "page",
    address: "g1t.sh/policies/refunds",
    eyebrow: "Policies",
    title: "Refunds and Cancellation",
    description: "Ending the plan, accidental overages, goodwill credits and refunds.",
  },
  "policies/subprocessors": {
    kind: "page",
    address: "g1t.sh/policies/subprocessors",
    eyebrow: "Policies",
    title: "Subprocessors",
    description: "The companies that process data for g1t, and what each receives.",
  },
  security: {
    kind: "page",
    address: "g1t.sh/security",
    eyebrow: "Security",
    title: "How g1t keeps your code and accounts safe",
    description: "Per-run credentials, the audit log, guardrails, isolated sandboxes, and how to report a vulnerability.",
  },
  support: {
    kind: "page",
    address: "g1t.sh/support",
    eyebrow: "Support",
    title: "Get help with g1t",
    description: "The documentation, the status page, and who to write to.",
  },
  status: {
    kind: "page",
    address: "g1t.sh/status",
    eyebrow: "Status",
    title: "g1t status",
    description: "Whether each part of g1t is working right now.",
  },
  register: {
    kind: "page",
    address: "g1t.sh/register",
    eyebrow: "Get started",
    title: "Hand off the outcome. A team of agents ships it.",
    description: "Create an account on g1t, the git forge for teams of agents.",
  },
};

const RESERVED = new Set([
  "login",
  "register",
  "logout",
  "verify",
  "forgot",
  "reset",
  "device",
  "oauth",
  "new",
  "settings",
  "explore",
  "pricing",
  "search",
  "workspaces",
  "policies",
  "security",
  "support",
  "status",
  "brand",
  "avatars",
  "llms.txt",
  "favicon.ico",
  "favicon.svg",
]);

/** A name as it may appear in an address: no slashes, dots only inside. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The path's segments, decoded; null if it is not a path on the site. */
export function segments(path: string): string[] | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const bare = path.split(/[?#]/, 1)[0];
  try {
    return bare
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** The card for a page of g1t.sh, as an anonymous visitor would see it. */
export async function resolve(path: string, sources: Sources): Promise<Card> {
  const parts = segments(path);
  if (!parts) return BRAND;
  try {
    return (await lookUp(parts, sources)) ?? BRAND;
  } catch {
    // A service that is down must not break a link preview.
    return { kind: "brand", failed: true };
  }
}

async function lookUp(parts: string[], sources: Sources): Promise<Card | null> {
  const { identity, repos, work, projects } = sources;
  const [owner, repo, section, item] = parts;
  if (owner === undefined) return PAGES[""];
  // A person, under `u`. Counted with no viewer: public repositories only.
  if (owner.toLowerCase() === "u") {
    if (repo === undefined || parts.length !== 2 || !NAME.test(repo)) return null;
    const profile = await identity.profile(repo.toLowerCase());
    if (!profile) return null;
    const authored = await work.byAuthor(profile.username, null, { limit: 1 }).catch(() => null);
    const counts = authored?.ok ? authored.value.counts : null;
    return {
      kind: "person",
      username: profile.username,
      name: profile.name,
      bio: profile.bio,
      pullsMerged: counts?.pullsMerged ?? 0,
      pullsOpen: counts?.pullsOpen ?? 0,
      issues: counts?.issues ?? 0,
      avatar: profile.avatar,
    };
  }
  if (RESERVED.has(owner.toLowerCase())) {
    if (parts.length === 1) return PAGES[owner.toLowerCase()] ?? null;
    // Each policy has a card of its own.
    if (parts.length === 2) return PAGES[`${owner.toLowerCase()}/${parts[1].toLowerCase()}`] ?? null;
    return null;
  }
  if (!NAME.test(owner)) return null;

  // A workspace, or one of its own pages under `-`.
  if (repo === undefined || repo === "-") {
    const workspace = await identity.getWorkspace(owner.toLowerCase());
    if (!workspace) return null;
    const listed = await projects.list(workspace.slug, null).catch(() => null);
    return {
      kind: "workspace",
      slug: workspace.slug,
      name: workspace.name || workspace.slug,
      description: workspace.description,
      projects: listed?.ok ? listed.value.filter((p) => !p.private).length : 0,
      avatar: workspace.avatar ?? null,
    };
  }

  // A project, through its repository: nothing is shown unless the
  // repository is public.
  if (!NAME.test(repo)) return null;
  const path = { namespace: owner, name: repo };
  const found = await repos.get(path, null);
  if (!found.ok || found.value.isPrivate) return null;
  const { namespace, name } = found.value;
  const canonical = { namespace, name };

  if (section === "issues" && item !== undefined && isNumber(item) && parts.length === 4) {
    const issue = await work.getIssue(canonical, Number(item), null);
    if (issue.ok) {
      return {
        kind: "issue",
        owner: namespace,
        repo: name,
        number: issue.value.issue.number,
        title: issue.value.issue.title,
        state: issueState(issue.value.issue),
        author: issue.value.issue.author.username,
      };
    }
  }

  if (section === "pull" && item !== undefined && isNumber(item)) {
    const pull = await work.getPull(canonical, Number(item), null);
    if (pull.ok) {
      return {
        kind: "pull",
        owner: namespace,
        repo: name,
        number: pull.value.pull.number,
        title: pull.value.pull.title,
        state: pull.value.pull.status,
        author: pull.value.pull.author.username,
      };
    }
  }

  if (section === "soon" && item !== undefined && parts.length === 4) {
    const feature = roadmapItem(item);
    if (feature) {
      return {
        kind: "soon",
        owner: namespace,
        repo: name,
        title: feature.title,
        summary: feature.summary,
        section: feature.section,
      };
    }
  }

  const [project, counts] = await Promise.all([
    projects.get(namespace, name.toLowerCase(), null).catch(() => null),
    work.counts(canonical, null).catch(() => null),
  ]);
  const shown: Project | null = project?.ok && !project.value.private ? project.value : null;
  return {
    kind: "project",
    owner: namespace,
    repo: name,
    name: shown?.name ?? name,
    description: shown?.description ?? found.value.description,
    issues: counts?.ok ? counts.value.issues : 0,
    pulls: counts?.ok ? counts.value.pulls : 0,
  };
}

function isNumber(value: string): boolean {
  return /^[1-9][0-9]{0,8}$/.test(value);
}

function issueState(issue: Issue): IssueState {
  if (issue.state === "open") return "open";
  return issue.reason === "not_planned" ? "not_planned" : "completed";
}

/** The card for a page of the docs, from what the page says about itself. */
export function docsCard(query: URLSearchParams): Card {
  const title = clean(query.get("title"), 160);
  if (!title) return { kind: "docs", title: "g1t docs", section: null, description: clean(query.get("description"), 300) };
  return {
    kind: "docs",
    title,
    section: clean(query.get("section"), 60),
    description: clean(query.get("description"), 300),
  };
}

/** Text from a query string: trimmed, single-spaced and bounded. */
export function clean(value: string | null, max: number): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
