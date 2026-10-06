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
    date: "2026-10-05",
    title: "Invites",
    about:
      "g1t is invite-only while we open it up. You have 5 invites: make one for anyone with the link or for one email address, copy it, and revoke it until it is used; an unused one comes back when it expires. Owners can invite an email address straight into a workspace, and it makes the account and joins in one step.",
    href: "/settings#invites",
  },
  {
    date: "2026-10-05",
    title: "Status, security and policies",
    about:
      "g1t.sh/status checks every public part of g1t each minute and says plainly what it can't check yet; the dot beside Status in the footer and your account menu follows it. Security describes what protects your code and how to report a vulnerability, Support says who to write to, and Policies has the terms, privacy policy, acceptable use, refunds and subprocessors, with every change listed.",
    href: "/status",
  },
  {
    date: "2026-10-05",
    title: "One plan, and limits you control",
    about:
      "The forge stays free. The g1t plan is $20 a month per workspace, with $10 of usage included and deployments part of it. Billing now has the $5 trial after a card check, your spend limit with how far you can raise it yourself, Raise my limit, Prepay, caps per run and per issue, and Keep going or Stop when spending spikes.",
    href: "/{workspace}/-/billing",
  },
  {
    date: "2026-10-05",
    title: "A project overview that shows the way to production",
    about:
      "Production shows a screenshot of the live site, taken on each deploy. A checklist counts the steps to production, from first push to a first issue for g1t-agent, each linking to where it is done. Active branches show how far each has moved from main, with its pull request and preview.",
    href: "https://docs.g1t.sh/guides/projects/#the-overview",
  },
  {
    date: "2026-10-05",
    title: "Setup for Claude Code, Codex, OpenCode and Cursor",
    about:
      "Wherever g1t shows how to connect your coding agent, pick yours: the command or config for it, with a copy button. Every block on the page follows your choice, and it is remembered.",
    href: "https://docs.g1t.sh/guides/bring-your-own-agent/",
  },
  {
    date: "2026-10-05",
    title: "Browse public projects in the sidebar",
    about:
      "Public projects, Explore, Search and profiles use the sidebar whether you are signed in or not. A page you cannot see says so plainly, the same for private and missing, with a way to sign in or switch account.",
    href: "https://docs.g1t.sh/guides/git/#browsing-without-an-account",
  },
  {
    date: "2026-10-05",
    title: "Cost plus 20%, on everything",
    about:
      "Sandbox time is charged at cost plus 20% from the first second, with no free minutes. Runs on your own model provider no longer carry a $0.10 fee: they pay only their sandbox time.",
    href: "/pricing",
  },
  {
    date: "2026-10-05",
    title: "Catch up in seconds",
    about:
      "Catch up with main merges it in at once when the two changed different files. When they overlap, the merge box shows g1t-agent at work, step by step.",
    href: "https://docs.g1t.sh/guides/pull-requests/#catching-up",
  },
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
