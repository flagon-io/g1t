/**
 * What a project will have and does not yet: the pages the project menu
 * shows as Soon, each with a page of its own saying what it will be. One
 * place, so the menu and those pages never disagree.
 *
 * Each entry says what it is for, what it will do, and what to use today,
 * so a Soon is a promise someone can read, not a greyed-out word.
 */

export type RoadmapItem = {
  /** In the address: `/<owner>/<project>/soon/<key>`. */
  key: string;
  title: string;
  /**
   * Where it lives: a project page whose tabs it joins, or the workspace,
   * for what spans projects (boards, the roadmap, packages, the fleet).
   */
  section: "Code" | "Issues" | "Agents" | "Deployments" | "Observability" | "Security" | "Insights" | "Workspace";
  /** One line, for the menu's tooltip and the page's lead. */
  summary: string;
  /** Why it matters, in two or three sentences. */
  why: string;
  /** What it will do. */
  plans: string[];
  /** What to use until it exists: a project page, by its path under the project. */
  today?: { label: string; path: string };
};

export const ROADMAP: RoadmapItem[] = [
  // --- Work ---------------------------------------------------------------
  {
    key: "board",
    title: "Board",
    section: "Workspace",
    summary: "Issues and pull requests as a board, a table or a roadmap, with fields of your own.",
    why: "Like GitHub Projects: one view of everything in flight, arranged the way your team thinks about it. Agents move the cards as they work, so the board is never out of date.",
    plans: [
      "Board, table and roadmap views of the same items, saved and shared",
      "Custom fields: status, priority, size, iteration, dates, anything",
      "Group and filter by owner, outcome, label, agent or state",
      "Cards move by themselves as agents open, revise and land changes",
      "Across projects: one board can hold work from any of the workspace's projects",
      "Attach a board to a project, so it shows on that project too",
    ],
  },
  {
    key: "roadmap",
    title: "Roadmap",
    section: "Workspace",
    summary: "Outcomes on a timeline, with their dependencies across projects.",
    why: "An outcome is what should be true when the work is done. On a roadmap you see when each is expected, what it waits on in other projects, and how much has landed.",
    plans: [
      "Outcomes as bars on a timeline, from start to target",
      "Progress from merged work, not from guesses",
      "Dependencies across projects, drawn from the project graph",
      "Slip warnings when the work left outgrows the time left",
    ],
    today: { label: "Outcomes", path: "plans" },
  },
  {
    key: "milestones",
    title: "Milestones",
    section: "Issues",
    summary: "Dates to land outcomes by, with what is left and what is at risk.",
    why: "A milestone groups the issues that must land together, by a date. g1t shows what remains and which agent or person holds each part.",
    plans: [
      "Issues and outcomes grouped under a due date",
      "Burn-down from merged pull requests",
      "At-risk items flagged before the date, not after",
    ],
    today: { label: "Issues", path: "issues" },
  },

  // --- Code ---------------------------------------------------------------
  {
    key: "branches",
    title: "Branches",
    section: "Code",
    summary: "Every branch: who is on it, how far behind it is, and its preview.",
    why: "With agents opening branches by the dozen, a list of names is not enough. Each branch shows its pull request, its checks, its live preview and how stale it is.",
    plans: [
      "Branches with their pull request, checks and preview address",
      "Ahead and behind the default branch, with one-click catch-up by an agent",
      "Protection rules: required checks, reviews and the merge queue",
      "Stale branches cleaned up on a schedule you set",
    ],
    today: { label: "Pull requests", path: "pulls" },
  },
  {
    key: "tags",
    title: "Tags",
    section: "Code",
    summary: "Tags, and the releases made from them.",
    why: "A tag marks a version of the code. Each links to its release notes and to the deployment that shipped it.",
    plans: ["Tags with their commit, release and deployment", "Signed tags verified", "Rules for who may create and move them"],
    today: { label: "Commits", path: "commits" },
  },
  {
    key: "compare",
    title: "Compare",
    section: "Code",
    summary: "Any two branches, tags or commits, side by side.",
    why: "See exactly what changed between two points, with the sessions and pull requests that changed it.",
    plans: ["Diff any two refs", "The pull requests and agent sessions between them", "Open a pull request from the comparison"],
    today: { label: "Commits", path: "commits" },
  },
  {
    key: "docs",
    title: "Docs",
    section: "Code",
    summary: "Pages about the project that agents keep current as the code changes.",
    why: "A wiki goes stale the day it is written. g1t's docs live with the code, and when a change makes a page wrong, an agent proposes the fix in the same pull request.",
    plans: [
      "Pages written in Markdown, kept in the repository",
      "Agents update pages a change makes wrong, in the same pull request",
      "Architecture pages drawn from the code itself",
      "Search across every project's docs",
    ],
    today: { label: "Files", path: "code" },
  },

  // --- Agents -------------------------------------------------------------
  {
    key: "agents",
    title: "At work",
    section: "Agents",
    summary: "Every agent at work on this project now, and a way to steer it.",
    why: "Agents are the project's busiest contributors. See each one live: what issue it holds, what it is doing this minute, what it has spent, and send it a word mid-run.",
    plans: [
      "Live view of each running agent, with its current step",
      "Steer, pause or stop a run, and hand it to a person",
      "What each run has cost so far",
      "Your own agents and g1t's side by side",
    ],
    today: { label: "Pull requests", path: "pulls" },
  },
  {
    key: "sessions",
    title: "Sessions",
    section: "Agents",
    summary: "Every agent session that changed this project, searchable.",
    why: "When an agent writes a line, its reasoning is worth keeping. Every session is kept, searchable, and linked from the lines it wrote, so why-blame answers why the code is the way it is.",
    plans: [
      "Every session, with its prompt, steps, tools and result",
      "Search by file, issue, agent or words",
      "Why-blame: from any line to the session that wrote it",
      "Sessions as context for the next agent on the same code",
    ],
    today: { label: "Commits", path: "commits" },
  },
  {
    key: "playbooks",
    title: "Playbooks",
    section: "Agents",
    summary: "How agents should work here: conventions, commands and checks.",
    why: "Every project has its own way of doing things. A playbook tells every agent how this one builds, tests, names things and what it must never touch, kept with the code and versioned with it.",
    plans: [
      "Instructions per kind of work: fixes, features, reviews, upgrades",
      "Commands to build and test, run before every change",
      "Paths agents may not touch without a person",
      "Learned from reviews: what people corrected becomes a rule",
    ],
    today: { label: "Settings", path: "settings" },
  },
  {
    key: "memory",
    title: "Memory",
    section: "Agents",
    summary: "What agents have learned about this project, kept and curated.",
    why: "Agents that forget repeat mistakes. g1t keeps what they learn about the code, its quirks and its people, and lets you see, edit and delete it.",
    plans: ["Facts agents learned, with where they learned them", "Edit or remove anything", "Shared across every agent on the project"],
  },

  {
    key: "fleet",
    title: "Agent fleet",
    section: "Workspace",
    summary: "Every agent at work across the workspace, and what each is costing.",
    why: "Agents work on many projects at once. The fleet shows them all: what each holds, how far along it is, and where people are needed.",
    plans: [
      "Every running agent across projects, live",
      "Queue of work waiting for an agent, by priority",
      "Spend by agent, project and kind of work",
      "Pause or redirect agents across the workspace",
    ],
  },

  // --- Deployments ----------------------------------------------------------
  {
    key: "environments",
    title: "Environments",
    section: "Deployments",
    summary: "Staging, production and others, with approvers and branch rules.",
    why: "Production and previews exist today. Environments add the rest: staging, QA, per-customer, each with its own variables, approvers and rules for what may deploy there.",
    plans: [
      "Named environments with their own variables and secrets",
      "Required approvers before a deploy",
      "Branch rules: what may deploy where",
      "Promote a deployment from one environment to the next",
    ],
    today: { label: "Deployments", path: "deployments" },
  },
  {
    key: "releases",
    title: "Releases",
    section: "Deployments",
    summary: "Tagged releases with notes written from what landed.",
    why: "Release notes from the pull requests and sessions that made the release: what changed, why, and who or what changed it.",
    plans: ["Notes drafted from merged work", "Assets and checksums attached", "Published to the project's page and a feed"],
    today: { label: "Commits", path: "commits" },
  },
  {
    key: "packages",
    title: "Packages",
    section: "Workspace",
    summary: "The workspace's package registry: npm, containers and more.",
    why: "Publish packages from workflows to g1t's registry, with the same access as the code.",
    plans: ["npm, OCI containers, Cargo, PyPI and Go modules", "Published from any project's workflows", "Private packages for the workspace"],
  },
  {
    key: "flags",
    title: "Feature flags",
    section: "Deployments",
    summary: "Turn features on per environment or per user, without a deploy.",
    why: "Ship code dark and turn it on when ready, for some users first, at the edge, with no deploy.",
    plans: ["Flags read at the edge by deployed apps", "Rollouts by percentage, user or environment", "Flags cleaned up by agents when fully on"],
    today: { label: "Deployments", path: "deployments" },
  },

  // --- Security -------------------------------------------------------------
  {
    key: "security",
    title: "Overview",
    section: "Security",
    summary: "Every security finding in one place, with the agent fixing each.",
    why: "Findings are worth something only when they are fixed. Each one here becomes an issue an agent takes, tested and landed through the merge queue.",
    plans: ["Findings by severity across scanners", "Each fixed by an agent through the queue", "A security policy and how to report to you"],
  },
  {
    key: "secret-scanning",
    title: "Secret scanning",
    section: "Security",
    summary: "Keys and tokens found in the code or its history, revoked and removed.",
    why: "A leaked key is an incident. g1t blocks pushes that carry one, finds old ones in history, and helps revoke them.",
    plans: ["Push protection for known key formats", "History scanned for leaks", "Revocation with the provider, where it allows"],
  },
  {
    key: "dependency-updates",
    title: "Dependency updates",
    section: "Security",
    summary: "Outdated and vulnerable packages, updated by agents.",
    why: "Like Dependabot, but the agent also fixes what the upgrade breaks, so updates land instead of piling up.",
    plans: ["Vulnerable packages first, then outdated ones", "Breaking changes fixed in the same pull request", "Grouped, scheduled and landed through the queue"],
  },
  {
    key: "code-scanning",
    title: "Code scanning",
    section: "Security",
    summary: "Code scanned for vulnerabilities on every change.",
    why: "Scanning on every pull request, with findings explained in the review and fixed by the author's agent.",
    plans: ["Static analysis on every pull request", "Findings in the review, with a fix", "Baselines so only new findings block"],
  },
  {
    key: "firewall",
    title: "Firewall",
    section: "Security",
    summary: "Rules for who may reach the project's deployed apps.",
    why: "Deployed apps run on Cloudflare. Rate limits, bot protection and IP rules, per app and environment.",
    plans: ["Rate limits and bot protection", "IP and country rules", "Password-protected previews"],
    today: { label: "Deployments", path: "deployments" },
  },

  // --- Observe ------------------------------------------------------------
  {
    key: "logs",
    title: "Logs",
    section: "Observability",
    summary: "Requests, errors and CPU time of each deployment, and its logs.",
    why: "Every deployed app's logs and numbers, by deployment, so a regression points at the change that caused it.",
    plans: ["Live and searchable logs", "Requests, errors, latency and CPU by deployment", "Compare a preview with production"],
    today: { label: "Deployments", path: "deployments" },
  },
  {
    key: "errors",
    title: "Errors",
    section: "Observability",
    summary: "Errors from the running app, each becoming an issue an agent can take.",
    why: "An error in production should become a fix, not a dashboard. Each new error is grouped, explained, and turned into an issue with the context an agent needs.",
    plans: ["Errors grouped with stack and request", "One click to an issue for an agent", "Incidents with a timeline and who was told"],
    today: { label: "Issues", path: "issues" },
  },
  {
    key: "uptime",
    title: "Uptime",
    section: "Observability",
    summary: "Checks that the app answers, from around the world.",
    why: "Know the app is down before your users tell you, and who was told.",
    plans: ["Checks from many places", "Alerts by email and webhook", "A public status page"],
  },
  {
    key: "analytics",
    title: "Web analytics",
    section: "Observability",
    summary: "Who visits the deployed apps, without cookies.",
    why: "Visits, pages and referrers for each app, private by design, from Cloudflare's own analytics.",
    plans: ["Visits, pages, referrers and countries", "No cookies, no personal data", "Per deployment and per preview"],
  },

  // --- Insights -------------------------------------------------------------
  {
    key: "delivery",
    title: "Delivery",
    section: "Insights",
    summary: "Lead time, deploy frequency, change failure rate and time to restore.",
    why: "The four numbers that say how well a team ships, measured from what actually happened in g1t.",
    plans: ["DORA metrics from merges and deployments", "Review and queue time", "Trends by week and by project"],
  },
  {
    key: "costs",
    title: "Costs",
    section: "Insights",
    summary: "What the project costs, by agent run, sandbox, build and app.",
    why: "Usage is charged by the workspace; here it is broken down for one project, so you can see what each part of the work costs.",
    plans: ["Cost by kind of work and by issue", "Cost per merged change", "Budgets per project"],
  },
  {
    key: "impact",
    title: "Agent impact",
    section: "Insights",
    summary: "How much of the work agents do, and how well.",
    why: "The share of changes agents author, how often their work lands first time, and where people still step in.",
    plans: ["Agents' share of merged changes", "First-time pass rate of checks and reviews", "Where people correct agents most"],
  },
];

export function roadmapItem(key: string): RoadmapItem | undefined {
  return ROADMAP.find((item) => item.key === key);
}

export function roadmapIn(section: RoadmapItem["section"]): RoadmapItem[] {
  return ROADMAP.filter((item) => item.section === section);
}
