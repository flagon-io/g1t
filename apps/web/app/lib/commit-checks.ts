/**
 * Words for a commit's checks, as the badge beside a commit and its list
 * say them (components/commit-checks.tsx).
 */
import type { CheckItem, CommitChecks } from "@g1t/contracts";

/** The headline over a commit's checks. */
export function checksHeadline(checks: Pick<CommitChecks, "state">): string {
  if (checks.state === "failure") return "Some checks were not successful";
  if (checks.state === "pending") return "Some checks haven't completed yet";
  if (checks.state === "none") return "No checks";
  return "All checks have passed";
}

/** "1 failing, 1 in progress and 2 successful checks", under the headline. */
export function checksTally(checks: Pick<CommitChecks, "successful" | "failed" | "pending" | "skipped" | "total">): string {
  const parts: string[] = [];
  if (checks.failed) parts.push(`${checks.failed} failing`);
  if (checks.pending) parts.push(`${checks.pending} in progress`);
  if (checks.skipped) parts.push(`${checks.skipped} skipped`);
  if (checks.successful) parts.push(`${checks.successful} successful`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "No");
  return `${list} ${checks.total === 1 ? "check" : "checks"}`;
}

/** `25s`, `1m 12s` or `1h 4m` between two times; empty without both. */
export function took(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What one check says after its name: a status's description; for a check
 * run, how it went and how long it took (`Successful in 25s`), then its
 * title.
 */
export function checkDetail(item: CheckItem): string {
  if (item.kind === "status") return item.description ?? stateWord(item);
  const time = took(item.startedAt, item.completedAt);
  let word = stateWord(item);
  if (time && item.state === "success") word = `Successful in ${time}`;
  else if (time && item.state === "failure") word = `Failing after ${time}`;
  return item.description ? `${word} — ${item.description}` : word;
}

function stateWord(item: Pick<CheckItem, "state" | "startedAt">): string {
  switch (item.state) {
    case "success":
      return "Successful";
    case "failure":
      return "Failing";
    case "pending":
      return item.startedAt ? "In progress" : "Queued";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    default:
      return "Neutral";
  }
}

/**
 * Where a check's Details link goes: its page on g1t when it has one (a
 * check run's report, or a job's run), otherwise the reporter's page. A
 * link to g1t itself is made a path; anything else opens apart.
 */
export function detailsLink(item: Pick<CheckItem, "url" | "detailsUrl">, site = "https://g1t.sh"): { href: string; external: boolean } | null {
  const target = item.url ?? item.detailsUrl;
  if (!target) return null;
  if (target.startsWith("/")) return { href: target, external: false };
  if (target.startsWith(`${site}/`)) return { href: target.slice(site.length), external: false };
  if (/^https?:\/\//.test(target)) return { href: target, external: true };
  return null;
}
