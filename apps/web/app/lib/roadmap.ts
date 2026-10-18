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
   * Where it lives: a project page whose tabs it joins, a page of its own
   * in the project's sidebar ("Project"), or the workspace, for what spans
   * projects (Insights).
   */
  section: "Code" | "Deployments" | "Observability" | "Security" | "Insights" | "Project" | "Workspace";
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
  // --- Code ---------------------------------------------------------------
  // Nothing: code is not docs. Docs is its own workspace mode, filterable
  // by project there, and a project never gets a Docs tab.

  // --- Pages of their own in the project's sidebar ----------------------
  {
    key: "storage",
    title: "Storage",
    section: "Project",
    summary: "Configure databases and storage for your project.",
    why: "Manage the data services your app depends on alongside its deployments, with connections scoped to the right environment.",
    plans: [
      "Connect databases and storage to a project",
      "Configure connections for production and preview environments",
      "Manage connection credentials alongside environment variables",
    ],
    today: { label: "Environment variables", path: "settings/secrets" },
  },
  {
    key: "daemons",
    title: "Daemons",
    section: "Project",
    summary: "Long-running background processes for your project.",
    why: "Keep queue consumers and background workers running alongside your app, with their configuration and activity in the same project.",
    plans: [
      "Run containerized background processes",
      "Manage instances, restarts and environment variables",
      "See process health and logs alongside your deployments",
    ],
  },
  {
    key: "analytics",
    title: "Analytics",
    section: "Project",
    summary: "Who visits the deployed apps, without cookies.",
    why: "Visits, pages and referrers for each app, private by design, from Cloudflare's own analytics.",
    plans: ["Visits, pages, referrers and countries", "No cookies, no personal data", "Per deployment and per preview"],
  },
  {
    key: "firewall",
    title: "Firewall",
    section: "Project",
    summary: "Rules for who may reach the project's deployed apps.",
    why: "Deployed apps run on Cloudflare. Rate limits, bot protection and IP rules, per app and environment.",
    plans: ["Rate limits and bot protection", "IP and country rules", "Password-protected previews"],
    today: { label: "Deployments", path: "deployments" },
  },
  {
    key: "flags",
    title: "Flags",
    section: "Project",
    summary: "Turn features on per environment or per user, without a deploy.",
    why: "Ship code dark and turn it on when ready, for some users first, at the edge, with no deploy.",
    plans: ["Flags read at the edge by deployed apps", "Rollouts by percentage, user or environment", "Reminders to clean up flags once fully on"],
    today: { label: "Deployments", path: "deployments" },
  },

  // --- Security -------------------------------------------------------------
  // The overview, secret scanning, code scanning, vulnerabilities and the
  // dependency graph are built: see routes/repo/security-*.tsx.

  // --- Observe ------------------------------------------------------------
  {
    key: "uptime",
    title: "Uptime",
    section: "Observability",
    summary: "Checks that the app answers, from around the world.",
    why: "Know the app is down before your users tell you, and who was told.",
    plans: ["Checks from many places", "Alerts by email and webhook", "A public status page"],
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
    summary: "What the project costs, by workflow run, sandbox, build and app.",
    why: "Usage is charged by the workspace; here it is broken down for one project, so you can see what each part of the work costs.",
    plans: ["Cost by kind of work and by work item", "Cost per merged change", "Budgets per project"],
  },
];

export function roadmapItem(key: string): RoadmapItem | undefined {
  return ROADMAP.find((item) => item.key === key);
}

export function roadmapIn(section: RoadmapItem["section"]): RoadmapItem[] {
  return ROADMAP.filter((item) => item.section === section);
}
