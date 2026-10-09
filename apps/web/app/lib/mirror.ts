/**
 * Mirroring, as the site says it: the badge beside a repository's name,
 * the line across its pages, why a button is off on a read-only mirror,
 * and the settings and hand-back forms read back from what was posted.
 * The rules themselves (what a mirror refuses) are the integrations
 * service's; these only put them into words.
 */

// Types only: the contracts' index does not load under `node --test`.
// mirror.test.ts holds the copies below to the contracts' own values.
import type { HandbackPlan, MirrorSettings, RefAction, RefDecision, RemoteBrief, RepoMirror } from "@g1t/contracts";

/** As `mirrorWritable` in the contracts: it leads, or g1t has taken over. */
export function writable(mirror: RepoMirror | null | undefined): boolean {
  return !mirror || mirror.state === "takeover";
}

/** As `TAKE_OVER_AFTER_MINUTES` in the contracts: 5 minutes to a day. */
export const TAKE_OVER_MINUTES = [5, 24 * 60] as const;

/** What a repository needs to say anything about its mirroring. */
export type MirroredRepo = { namespace: string; name: string; mirror?: RepoMirror | null };

/**
 * A remote in brief, as the repository layout loads it for every page.
 * `syncedAt` when the service says when it last copied, for the line that
 * says how fresh g1t's copy is.
 */
export type MirrorBrief = RemoteBrief & { syncedAt?: string | null };

/** Where the mirroring settings are, and the guide. */
export const MIRRORING_DOCS = "https://docs.g1t.sh/guides/mirroring/";
export const mirroringSettings = (base: string) => `${base}/settings/mirroring`;

/**
 * Why pushing, merging, opening issues and pull requests, and assigning
 * agents are off: the repository follows a remote that leads. Null when
 * they are not off for that reason (it leads, or g1t has taken over).
 */
export function mirrorReason(repo: MirroredRepo | null | undefined): string | null {
  const mirror = repo?.mirror;
  if (!repo || writable(mirror)) return null;
  const full = `${repo.namespace}/${repo.name}`;
  if (mirror!.state === "handing_back") {
    return `${full} is handing back to ${mirror!.remote}; it takes changes again when that is done.`;
  }
  return `${full} is a mirror of ${mirror!.remote}. Work happens there until someone takes over in Settings → Mirroring.`;
}

/**
 * Why running a workflow or running one again is off. In CI failover g1t
 * runs the remote's workflows, so they may be run here; a mirror standing
 * by, or handing back, runs nothing.
 */
export function workflowReason(repo: MirroredRepo | null | undefined): string | null {
  const state = repo?.mirror?.state;
  if (state === "ci" || state === "takeover") return null;
  return mirrorReason(repo);
}

/** The leader a mirror follows, from the briefs. */
export function leaderOf(briefs: readonly MirrorBrief[] | null | undefined): MirrorBrief | null {
  return briefs?.find((brief) => brief.role === "leader") ?? null;
}

/** The remotes that follow this repository, from the briefs. */
export function followersOf(briefs: readonly MirrorBrief[] | null | undefined): MirrorBrief[] {
  return (briefs ?? []).filter((brief) => brief.role === "follower");
}

export type MirrorTone = "neutral" | "info" | "warn" | "accent";

/** The badge beside the repository's name: what it is to its remotes, in a few words. */
export function mirrorBadge(
  mirror: RepoMirror | null | undefined,
  briefs: readonly MirrorBrief[] | null | undefined,
): { label: string; tone: MirrorTone; more: number } | null {
  if (mirror) {
    switch (mirror.state) {
      case "standby":
        return { label: `Mirror of ${mirror.remote}`, tone: "neutral", more: 0 };
      case "ci":
        return { label: "Mirror · running CI", tone: "info", more: 0 };
      case "takeover":
        return { label: `Taken over from ${mirror.remote}`, tone: "warn", more: 0 };
      case "handing_back":
        return { label: `Handing back to ${mirror.remote}`, tone: "warn", more: 0 };
    }
  }
  const followers = followersOf(briefs);
  if (followers.length === 0) return null;
  return { label: `Mirrored to ${followers[0]!.name}`, tone: "accent", more: followers.length - 1 };
}

/**
 * Which line goes across the repository's pages, if any. A mirror standing
 * by whose remote answers needs none: the badge says it.
 */
export type MirrorBannerKind = "unreachable" | "ci" | "takeover" | "handing_back";

export function mirrorBanner(
  mirror: RepoMirror | null | undefined,
  briefs: readonly MirrorBrief[] | null | undefined,
): MirrorBannerKind | null {
  if (!mirror) return null;
  const answering = leaderOf(briefs)?.reachable !== false;
  if ((mirror.state === "standby" || mirror.state === "ci") && !answering) return "unreachable";
  if (mirror.state === "standby") return null;
  return mirror.state;
}

/** What happens to one branch when the takeover goes back. */
export function refActionWords(action: RefAction, remote: string): string {
  switch (action) {
    case "same":
      return "Already the same";
    case "push":
      return `Pushed to ${remote}`;
    case "fetch":
      return `Taken from ${remote}`;
    case "pull_request":
      return "Sent as a pull request (protected there)";
    case "diverged":
      return "Both moved: choose";
  }
}

/** The choices for a branch both sides moved, in order. */
export function decisionChoices(remote: string): { value: RefDecision; label: string }[] {
  return [
    { value: "keep_ours", label: "Keep g1t's" },
    { value: "keep_theirs", label: `Keep ${remote}'s` },
    { value: "pull_request", label: "Send g1t's as a pull request" },
  ];
}

/** A commit's short name, or a dash when the branch is not there. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** A branch name as a form field, for its decision. */
export const decisionField = (ref: string) => `decision:${ref}`;

/** The decisions posted with a hand-back: one per branch both sides moved. */
export function decisionsFrom(entries: Iterable<[string, FormDataEntryValue]>): Record<string, RefDecision> {
  const decisions: Record<string, RefDecision> = {};
  for (const [name, value] of entries) {
    if (!name.startsWith("decision:")) continue;
    const decision = String(value);
    if (decision === "keep_ours" || decision === "keep_theirs" || decision === "pull_request") {
      decisions[name.slice("decision:".length)] = decision;
    }
  }
  return decisions;
}

/**
 * Whether the hand-back can go: the remote answers, and every branch both
 * sides moved has a decision, the one chosen on the page or the plan's.
 */
export function handBackReady(plan: HandbackPlan, chosen: Record<string, RefDecision | undefined>): boolean {
  if (!plan.reachable) return false;
  return plan.refs.every((ref) => ref.action !== "diverged" || (chosen[ref.ref] ?? ref.decision) != null);
}

/** Minutes before an automatic takeover, held to what the service takes. */
export function clampMinutes(value: number): number {
  const [least, most] = TAKE_OVER_MINUTES;
  if (!Number.isFinite(value)) return least;
  return Math.min(most, Math.max(least, Math.round(value)));
}

type FormLike = { get(name: string): FormDataEntryValue | null };

/**
 * A remote's settings from its form. The leader's form (a mirror's remote)
 * and a follower's carry different fields: what a form does not carry
 * keeps its value from `current`.
 */
export function mirrorSettingsFrom(form: FormLike, current: MirrorSettings): MirrorSettings {
  if (form.get("kind") === "follower") {
    const pushes = form.get("remotePushes");
    return { ...current, remotePushes: pushes === "overwrite" ? "overwrite" : pushes === "adopt" ? "adopt" : current.remotePushes };
  }
  const on = (name: string) => form.get(name) === "on";
  return {
    ...current,
    notify: form.get("notify") === "inbox" ? "inbox" : "banner",
    takeOverAfter: on("autoTakeOver") ? clampMinutes(Number(form.get("takeOverAfter") ?? "")) : null,
    handBack: on("handBackWhenClean") ? "when_clean" : "ask",
    keepCiWarm: on("keepCiWarm"),
    githubWorkflows: on("githubWorkflows"),
    holdDeploys: on("holdDeploys"),
  };
}

/** Words for a remote's state, in its row. */
export function remoteStateWords(state: string): string {
  switch (state) {
    case "standby":
      return "Standing by";
    case "ci":
      return "CI failover";
    case "takeover":
      return "Taken over";
    case "handing_back":
      return "Handing back";
    case "following":
      return "Following";
    case "stuck":
      return "Stuck";
    default:
      return state;
  }
}
