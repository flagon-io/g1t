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
    why: "One view of everything in flight, arranged the way your team thinks about it. Agents move the cards as they work, so the board is never out of date.",
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
    summary: "Outcomes on a timeline, with how much of each has landed.",
    why: "An outcome is what should be true when the work is done. On a roadmap you see when each is expected and how much has landed.",
    plans: [
      "Outcomes as bars on a timeline, from start to target",
      "Progress from merged work, not from guesses",
      "Slip warnings when the work left outgrows the time left",
    ],
    today: { label: "Outcomes", path: "plans" },
  },
  {
    key: "insights",
    title: "Insights",
    section: "Workspace",
    summary: "How the whole workspace delivers: lead time, reviews, what agents do and what it costs, across every project.",
    why: "Each project will have its own numbers. The workspace's put them side by side, so you can see which projects ship steadily, where work waits, and where the money goes.",
    plans: [
      "Delivery metrics for every project, side by side",
      "Where work waits: review, the merge queue, checks",
      "Agents' share of merged changes, and how often it lands first time",
      "Cost by project, by kind of work and per merged change",
    ],
  },
  // --- Code ---------------------------------------------------------------
  // Nothing: code is not docs. Docs is its own workspace mode, filterable
  // by project there, and a project never gets a Docs tab.

  // --- Agents -------------------------------------------------------------
  // At work, Sessions and Memory are built (see project-nav.ts), and so is
  // the workspace's Agents overview.
  {
    key: "playbooks",
    title: "Playbooks",
    section: "Agents",
    summary: "How agents should work here: conventions, commands and checks.",
    why: "Every project has its own way of doing things. Today every agent run already reads the repository's AGENTS.md and CLAUDE.md, at the root and in the directories it touches, and reviews read .g1t/review.md, all from the default branch. Playbooks build on those files with structure g1t can act on, not just read.",
    plans: [
      "Instructions per kind of work: fixes, features, reviews, upgrades",
      "Commands to build and test that g1t runs before every change, not just tells the agent about",
      "Paths agents may not touch without a person, enforced on push",
      "Learned from reviews: what people corrected becomes a proposed rule",
    ],
    today: { label: "Instructions, on Agents", path: "agents" },
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
    key: "flags",
    title: "Feature flags",
    section: "Deployments",
    summary: "Turn features on per environment or per user, without a deploy.",
    why: "Ship code dark and turn it on when ready, for some users first, at the edge, with no deploy.",
    plans: ["Flags read at the edge by deployed apps", "Rollouts by percentage, user or environment", "Flags cleaned up by agents when fully on"],
    today: { label: "Deployments", path: "deployments" },
  },

  // --- Security -------------------------------------------------------------
  // The overview, secret scanning, code scanning, vulnerabilities and the
  // dependency graph are built: see routes/repo/security-*.tsx.
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
