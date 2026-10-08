/**
 * What the Files page's About, the Contributors, Releases and Activity
 * pages say, worked out without the server: labels, the language bar,
 * and an activity line for each event worth one.
 */
import type { Contributor, G1tEvent, LanguageShare, License, Project, WeekCommits } from "@g1t/contracts";

/**
 * The address the About links to: the project's homepage (its own, or its
 * repository's website it follows), else production when it runs
 * elsewhere. Null leaves the repository's website.
 */
export function projectHomepage(project: Pick<Project, "links" | "runs" | "productionUrl"> | null): string | null {
  if (!project) return null;
  return project.links?.homepage ?? (project.runs === "elsewhere" ? project.productionUrl : null) ?? null;
}

/** "MIT license", as the About names it; "View license" for one not recognized. */
export function licenseLabel(license: License): string {
  return license.spdxId ? `${license.spdxId} license` : "View license";
}

/** "12", "1.2k", "15k". */
export function compact(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** "1 star", "1.2k stars". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${compact(n)} ${n === 1 ? one : many}`;
}

/** The language bar's pieces: the largest, then the rest under 1% as Other. */
export function languageBar(languages: LanguageShare[], least = 1): LanguageShare[] {
  const shown = languages.filter((language) => language.percent >= least);
  const rest = languages.filter((language) => language.percent < least);
  if (rest.length === 0) return shown;
  const bytes = rest.reduce((sum, language) => sum + language.bytes, 0);
  const percent = Math.round(rest.reduce((sum, language) => sum + language.percent, 0) * 10) / 10;
  if (percent === 0 && shown.length > 0) return shown;
  return [...shown, { name: "Other", color: null, bytes, percent }];
}

/** Where a contributor's name leads: their profile, for an account. */
export function contributorHref(contributor: Contributor): string | null {
  return contributor.kind === "user" && contributor.username ? `/u/${contributor.username}` : null;
}

/** The tallest week, for a chart's scale: never zero. */
export function peak(weeks: WeekCommits[]): number {
  return Math.max(1, ...weeks.map((week) => week.commits));
}

/** A contributor's weeks laid over the repository's, missing weeks as none. */
export function alignWeeks(all: WeekCommits[], own: WeekCommits[]): number[] {
  const byWeek = new Map(own.map((week) => [week.week, week.commits]));
  return all.map((week) => byWeek.get(week.week) ?? 0);
}

/** An Activity line: what happened, and the branch, tag or pull request it was to. */
export type ActivityLine =
  | { kind: "push"; branch: string; commit: string; before: string | null; created: boolean; defaultBranch: boolean }
  | { kind: "tag"; tag: string; commit: string }
  | { kind: "merge"; number: number; commit: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "default"; from: string; to: string };

/** The events the Activity page lists. */
export const ACTIVITY_TYPES = ["git.push", "pull.merged", "branch.renamed", "repo.default_branch_changed"] as const;

/** One event as an Activity line, or null for one it does not list. */
export function activityLine(event: G1tEvent): ActivityLine | null {
  switch (event.type) {
    case "git.push": {
      const data = event.data as { ref: string; before?: string | null; after: string; defaultBranch: boolean };
      if (data.ref.startsWith("refs/tags/")) return { kind: "tag", tag: data.ref.slice("refs/tags/".length), commit: data.after };
      if (!data.ref.startsWith("refs/heads/")) return null;
      return {
        kind: "push",
        branch: data.ref.slice("refs/heads/".length),
        commit: data.after,
        before: data.before ?? null,
        created: !data.before,
        defaultBranch: data.defaultBranch,
      };
    }
    case "pull.merged": {
      const data = event.data as { number: number; commit: string };
      return { kind: "merge", number: data.number, commit: data.commit };
    }
    case "branch.renamed": {
      const data = event.data as { from: string; to: string };
      return { kind: "renamed", from: data.from, to: data.to };
    }
    case "repo.default_branch_changed": {
      const data = event.data as { from: string; to: string; renamed: boolean };
      // A rename of the default branch says so once, as a rename.
      return data.renamed ? null : { kind: "default", from: data.from, to: data.to };
    }
    default:
      return null;
  }
}
