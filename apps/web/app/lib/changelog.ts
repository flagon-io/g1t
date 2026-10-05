/**
 * What is new on g1t, newest first, for the corner of mission control that
 * says so. Short and specific: what changed, and where to see it. Add an
 * entry in the same change that ships the feature.
 */
export type ChangelogEntry = {
  /** `YYYY-MM-DD`. */
  date: string;
  title: string;
  about: string;
  /** Docs, or a page on g1t; `{workspace}` and `{project}` are filled in where known. */
  href: string;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-04",
    title: "Agents and memory",
    about: "Watch every agent run live, stop or message it, and see what agents learned about each project.",
    href: "/{workspace}/-/agents",
  },
  {
    date: "2026-10-04",
    title: "Checks and conflicts",
    about: "Workflow statuses on every pull request, and conflicts found before you press merge.",
    href: "https://docs.g1t.sh/guides/pull-requests/",
  },
  {
    date: "2026-10-04",
    title: "Profiles",
    about: "Your name, bio and everything you opened, in one place.",
    href: "/settings",
  },
  {
    date: "2026-10-04",
    title: "Custom domains",
    about: "Serve production on your own domain, with its certificate handled for you.",
    href: "https://docs.g1t.sh/guides/deployments/",
  },
  {
    date: "2026-10-04",
    title: "Rename a workspace",
    about: "Old addresses redirect for 90 days, so links and clones keep working.",
    href: "/{workspace}/-/settings",
  },
  {
    date: "2026-10-04",
    title: "Workspace names and icons",
    about: "Give a workspace a display name and an icon of its own.",
    href: "/{workspace}/-/settings",
  },
];

/** An entry's link, with the workspace filled in; null when it needs one and there is none. */
export function changelogHref(entry: ChangelogEntry, workspace: string | null): string | null {
  if (!entry.href.includes("{workspace}")) return entry.href;
  return workspace ? entry.href.replaceAll("{workspace}", workspace) : null;
}
