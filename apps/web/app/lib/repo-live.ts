/**
 * Repository pages that update live: which changes each page cares about,
 * and when a page may refresh itself. Pure; the hook that uses them is
 * lib/use-repo-live.ts.
 *
 * A tab on a repository page watches the repository over the live socket
 * (`/-/live`, services/notify): the site checks the person may read it,
 * then every push, pull request, issue, comment, review, check, run,
 * release and security alert there arrives as a small `RepoChange`. A page
 * refreshes its loader when a change matches it, a second after the last
 * one, at most every two seconds, never under someone typing or with a
 * dialog open, and not at all while the tab is out of view: it catches up
 * once when it comes back. A busy repository sends changes all the time
 * (every branch's pushes, every commit's checks), so each page matches
 * only what it shows: the Code page its own branch and the checks of the
 * commit it shows, not another branch's. Signed out, or while the socket
 * is down, it refreshes when the tab comes back into view and once a
 * minute while it is in view instead.
 */
import type { RepoChange } from "@g1t/contracts";

export type { RepoChange };

/** Which changes a page shows. */
export type RepoMatch = (change: RepoChange) => boolean;

/** How long after the last matching change the page refreshes. */
export const LIVE_DEBOUNCE_MS = 1000;
/** However steady the changes, a page waits no longer than this before refreshing. */
export const LIVE_MAX_WAIT_MS = 5000;
/** However many changes arrive, a page refreshes at most this often. */
export const LIVE_MIN_GAP_MS = 2000;
/** How often a page held back (someone typing, a dialog open) looks again. */
export const LIVE_HOLD_CHECK_MS = 1000;
/** Without the socket: coming back into view refreshes at most this often. */
export const FALLBACK_FOCUS_MS = 30_000;
/** Without the socket: how often a page in view refreshes. */
export const FALLBACK_POLL_MS = 60_000;
/** A watch is asked for again this often while the page stays open (it lasts REPO_WATCH_MS). */
export const REWATCH_MS = 10 * 60_000;

// ── Matching ─────────────────────────────────────────────────────────────

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";

/** The branch a full ref names, or null for a tag or anything else. */
export function branchOf(ref: string | null | undefined): string | null {
  return ref?.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
}

/** The tag a full ref names, or null. */
export function tagOf(ref: string | null | undefined): string | null {
  return ref?.startsWith(TAGS) ? ref.slice(TAGS.length) : null;
}

function family(change: RepoChange): string {
  return change.kind.split(".")[0] ?? "";
}

/** A push or a deletion of a ref. */
export function isRefChange(change: RepoChange): boolean {
  return change.kind === "git.push" || change.kind === "git.deleted" || change.kind === "branch.renamed" || change.kind === "repo.default_branch_changed";
}

/** A push to branch `branch` (or its deletion). */
export function isPushTo(change: RepoChange, branch: string | null | undefined): boolean {
  return (change.kind === "git.push" || change.kind === "git.deleted") && !!branch && branchOf(change.ref) === branch;
}

/** Something reported on a commit: a status, a check, a run. */
export function isCheck(change: RepoChange): boolean {
  return ["status", "check_run", "check_suite", "checks", "workflow", "run"].includes(family(change));
}

/** A harness session starting, going on and ending (not a pull request's recorded session). */
const SESSION_KINDS = ["session.started", "session.progressed", "session.ended"];

const ALERTS = ["secret_scanning_alert", "code_scanning_alert", "vulnerability_alert"];

/** A check on one of `shas`: any check when they are not known, and one that names no commit. */
function isCheckOn(change: RepoChange, shas: readonly string[] | null | undefined): boolean {
  return isCheck(change) && (shas == null || !change.sha || shas.includes(change.sha));
}

/** What a page of files shows, for matching only what can change it. */
export type ShownFiles = {
  /** The branch shown; null for a tag or a commit. */
  branch: string | null;
  /** Every branch, for the branch menu and count: a new one, or one of them deleted, changes them. */
  branches?: readonly string[] | null;
  /** The commit shown, whose checks are on the page. */
  sha?: string | null;
};

/** What each kind of repository page shows. */
export const repoPages = {
  /**
   * Files and a folder: its own branch moving (the files and the latest
   * commit), a branch made, deleted or renamed and the default changing
   * (the branch menu and count), any tag (the About's), checks on the
   * commit shown, releases and deployments. Without `shown`, any ref and
   * any check.
   */
  files(shown?: ShownFiles): RepoMatch {
    return (change) => {
      if (["release", "deployment", "deployment_status"].includes(family(change))) return true;
      if (!shown) return isRefChange(change) || isCheck(change);
      if (isCheck(change)) return isCheckOn(change, shown.sha ? [shown.sha] : null);
      if (!isRefChange(change)) return false;
      const branch = branchOf(change.ref);
      if (branch == null || change.kind === "branch.renamed" || change.kind === "repo.default_branch_changed") return true;
      if (branch === shown.branch) return true;
      // Another branch: only made or deleted matters, by the menu it is in or not.
      const known = shown.branches == null || shown.branches.includes(branch);
      return change.kind === "git.deleted" ? known : !known;
    };
  },
  /**
   * A project's overview: what it runs and how it is doing (deployments,
   * checks, releases), who is working on it (claims and sessions), and the
   * pull requests that may need someone (opened, readied, reviewed, merged).
   * Of the checks, only the shown commit's (`sha`) and finished pull
   * requests' (how often checks pass); without `sha`, all.
   */
  overview(sha?: string | null): RepoMatch {
    return (change) =>
      (change.kind === "checks.completed" || isCheckOn(change, sha ? [sha] : null)) ||
      ["release", "deployment", "deployment_status", "work", "pull", "review"].includes(family(change)) ||
      SESSION_KINDS.includes(change.kind);
  },
  /** Commits: pushes to the branch shown, and checks on the commits shown (on any without `shas`). */
  commits(branch: string | null, shas?: readonly string[] | null): RepoMatch {
    return (change) => (branch == null ? change.kind === "git.push" && !tagOf(change.ref) : isPushTo(change, branch)) || isCheckOn(change, shas);
  },
  /** Branches and tags: any ref moving, pull requests (a branch's), checks. */
  refs(): RepoMatch {
    return (change) => isRefChange(change) || isCheck(change) || family(change) === "pull" || family(change) === "release";
  },
  /** Tags and releases. */
  tags(): RepoMatch {
    return (change) => (isRefChange(change) && (tagOf(change.ref) != null || change.ref == null)) || family(change) === "release";
  },
  /** The pull requests list: pull requests and what is said and checked on them. */
  pulls(): RepoMatch {
    return (change) => ["pull", "review", "checks", "queue"].includes(family(change)) || (family(change) === "comment" && change.number != null) || isCheck(change);
  },
  /** The issues list: issues, comments on them, and pull requests that close them. */
  issues(): RepoMatch {
    return (change) => ["issue", "comment"].includes(family(change)) || ["pull.opened", "pull.merged", "pull.closed", "pull.reopened"].includes(change.kind);
  },
  /**
   * A pull request: its own changes (commits, reviews, comments, checks,
   * merged or closed), pushes to its head branch, and what is reported on
   * its head commit.
   */
  pull(number: number, head?: { branch?: string | null; sha?: string | null }): RepoMatch {
    return (change) =>
      (change.number === number && family(change) !== "issue") ||
      (!!head?.branch && isPushTo(change, head.branch)) ||
      (!!head?.sha && change.sha === head.sha && isCheck(change)) ||
      change.kind === "queue.changed";
  },
  /** An issue: its own changes and comments, and the pull requests linked to it. */
  issue(number: number, linked: number[] = []): RepoMatch {
    return (change) => change.number != null && (change.number === number || linked.includes(change.number));
  },
  /**
   * The Work page: claims, sessions starting and ending, dependencies,
   * overlaps, what the merge queue finds and decisions, the queue moving,
   * and merges; and sessions going on (heard from, so still active).
   */
  work(): RepoMatch {
    return (change) =>
      ["work", "dependency", "overlap", "integration", "decision", "queue"].includes(family(change)) ||
      SESSION_KINDS.includes(change.kind) ||
      change.kind === "pull.merged";
  },
  /**
   * A harness session's page: any session starting, going on or ending
   * (its subagents are sessions too), claims and overlaps. A change names
   * no session, so every session's activity in the repository counts.
   */
  session(): RepoMatch {
    return (change) => family(change) === "session" || family(change) === "work" || change.kind === "overlap.detected";
  },
  /** The runs list: runs starting, moving and finishing, and what starts them. */
  runs(): RepoMatch {
    return (change) => ["workflow", "run", "status", "check_suite"].includes(family(change));
  },
  /** A run: its own jobs and its end, and what is reported on its commit. */
  run(id: string, sha?: string | null): RepoMatch {
    return (change) => change.run === id || (!!sha && change.sha === sha && family(change) === "status");
  },
  /** Security: alerts opening, closing and being dismissed, and the pull requests that fix them. */
  security(): RepoMatch {
    return (change) => ALERTS.includes(family(change)) || change.kind === "pull.merged" || change.kind === "pull.opened";
  },
};

/** Commits a set of changes brought to a branch, for "N new commits": null when uncounted. */
export function newCommits(changes: RepoChange[], branch: string | null): number | null {
  let total = 0;
  for (const change of changes) {
    if (change.kind !== "git.push" || (branch != null && branchOf(change.ref) !== branch)) continue;
    if (change.commits == null) return null;
    total += change.commits;
  }
  return total;
}

// ── When to refresh ──────────────────────────────────────────────────────

/** What a page knows when deciding whether to refresh now. */
export type GateState = {
  /** When the first change still waiting arrived, or null when none is. */
  pendingSince: number | null;
  /** When the latest change arrived. */
  lastChangeAt: number | null;
  /** When the page last refreshed. */
  lastRunAt: number | null;
};

export type GateInput = {
  now: number;
  /** Whether the tab is in view. */
  visible: boolean;
  /** Someone is typing on the page, or a dialog is open. */
  busy: boolean;
  /** A navigation or a submission is under way: the router reloads the page itself. */
  navigating: boolean;
  /** The page refreshes at most this often; LIVE_MIN_GAP_MS unless a page's loader is heavier (Home's). */
  gap?: number;
};

/**
 * `hold`: nothing to do until the tab comes back into view, which asks
 * again; no timer runs meanwhile.
 */
export type GateDecision = { action: "idle" } | { action: "run" } | { action: "hold" } | { action: "wait"; ms: number };

/**
 * Whether to refresh now for the changes waiting, or how long to wait
 * before asking again. A second after the last change (at most five after
 * the first), at most every two seconds, never under someone typing or
 * with a dialog open, and never for a tab out of view: what waited is
 * fetched once, as soon as it comes back.
 */
export function gate(state: GateState, input: GateInput): GateDecision {
  if (state.pendingSince == null) return { action: "idle" };
  if (!input.visible) return { action: "hold" };
  if (input.busy || input.navigating) return { action: "wait", ms: LIVE_HOLD_CHECK_MS };
  const quiet = input.now - (state.lastChangeAt ?? state.pendingSince);
  const waited = input.now - state.pendingSince;
  const since = state.lastRunAt == null ? Infinity : input.now - state.lastRunAt;
  const ms = Math.max(quiet < LIVE_DEBOUNCE_MS && waited < LIVE_MAX_WAIT_MS ? Math.min(LIVE_DEBOUNCE_MS - quiet, LIVE_MAX_WAIT_MS - waited) : 0, (input.gap ?? LIVE_MIN_GAP_MS) - since);
  return ms > 0 ? { action: "wait", ms } : { action: "run" };
}

/**
 * Without the socket (signed out, or while it is down): whether to refresh
 * now. `focus` when the tab comes back into view, at most every 30 s;
 * `poll` once a minute while it is in view. Never with the socket up.
 */
export function fallbackDue(input: { live: boolean; visible: boolean; now: number; lastRunAt: number | null; reason: "focus" | "poll" }): boolean {
  if (input.live || !input.visible) return false;
  const since = input.lastRunAt == null ? Infinity : input.now - input.lastRunAt;
  return since >= (input.reason === "focus" ? FALLBACK_FOCUS_MS : FALLBACK_POLL_MS);
}

/** What has focus, as `isTyping` reads it. */
export type FocusedElement = { tagName: string; type?: string | null; isContentEditable?: boolean; readOnly?: boolean; disabled?: boolean } | null;

const NOT_TYPED = new Set(["button", "checkbox", "radio", "submit", "reset", "file", "image", "color", "range", "hidden"]);

/** Whether the focused element is somewhere one types: a text box, a text area, an editor. */
export function isTyping(focused: FocusedElement): boolean {
  if (!focused || focused.disabled || focused.readOnly) return false;
  if (focused.isContentEditable) return true;
  const tag = focused.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NOT_TYPED.has((focused.type ?? "text").toLowerCase());
  return false;
}

/** Whether a page that tells it is at its bottom: then new timeline items are followed. */
export function atBottom(scroll: { top: number; height: number; viewport: number }, slack = 120): boolean {
  return scroll.top + scroll.viewport >= scroll.height - slack;
}
