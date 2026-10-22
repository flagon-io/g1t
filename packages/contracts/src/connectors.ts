import type { Provider } from "./integrations";

/**
 * The connector catalog: every tool g1t connects to, or will, in one list.
 * The workspace's Integrations page and your own Integrations settings are
 * both drawn from it, so a new connector is added here, once.
 *
 * A connector is `available` when g1t can set it up today (its `href` is
 * where), and `soon` while it is planned. `scopes` says who connects it:
 *
 * - `workspace`: an owner connects it once, for everyone in the workspace.
 * - `personal`: each person connects their own account, and it follows them
 *   into every workspace they belong to (a calendar, a personal sign-in).
 *
 * A connector with both scopes can say something different for each, in
 * `personal`: its own description, status, capabilities or setup page.
 * `connectorView` resolves that into what one context shows.
 *
 * Paths in `href` are g1t's own pages. `:workspace` stands for the
 * workspace's slug.
 */

export type ConnectorScope = "workspace" | "personal";
export type ConnectorStatus = "available" | "soon";

export type ConnectorCategory =
  | "code"
  | "issues"
  | "chat"
  | "calendar"
  | "docs"
  | "monitoring"
  | "cloud"
  | "ai"
  | "data"
  | "crm"
  | "design"
  | "security"
  | "files";

/** What a connector lets g1t do, as the small tags on its card. */
export type ConnectorCapability =
  | "Agents can read"
  | "Agents can act"
  | "Opens work items"
  | "Writes back"
  | "Imports repositories"
  | "Signs you in"
  | "Sends events"
  | "Alerts into chat"
  | "Sets your status"
  | "Deploys"
  | "Syncs people";

export type Connector = {
  /** Stable and unique: used in links and requests. */
  id: string;
  name: string;
  category: ConnectorCategory;
  /** One plain line of what it does in g1t, for a workspace (or for you, when it is only personal). */
  description: string;
  scopes: ConnectorScope[];
  status: ConnectorStatus;
  /** Where an available connector is set up, for each scope it has. */
  href?: Partial<Record<ConnectorScope, string>>;
  capabilities?: ConnectorCapability[];
  /** The integration provider behind it, whose connections show it as connected. */
  provider?: Provider;
  /** What differs when you connect it for yourself. */
  personal?: { description?: string; status?: ConnectorStatus; capabilities?: ConnectorCapability[] };
  /** More words search should find it by. */
  keywords?: string[];
};

/** A connector as one context (a workspace, or you) shows it. */
export type ConnectorView = {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  status: ConnectorStatus;
  href: string | null;
  capabilities: ConnectorCapability[];
  provider: Provider | null;
  keywords: string[];
  /** The other scope it can also be connected in. */
  alsoIn: ConnectorScope | null;
};

/** The categories, in the order the directory lists them. */
export const CONNECTOR_CATEGORIES: { id: ConnectorCategory; title: string }[] = [
  { id: "code", title: "Code & CI" },
  { id: "issues", title: "Issues & projects" },
  { id: "chat", title: "Chat & meetings" },
  { id: "calendar", title: "Calendar & email" },
  { id: "docs", title: "Docs & knowledge" },
  { id: "monitoring", title: "Monitoring & incidents" },
  { id: "cloud", title: "Cloud & deploy" },
  { id: "ai", title: "AI & agents" },
  { id: "data", title: "Data & analytics" },
  { id: "crm", title: "CRM & support" },
  { id: "design", title: "Design" },
  { id: "security", title: "Security & identity" },
  { id: "files", title: "Files & storage" },
];

const W: ConnectorScope[] = ["workspace"];
const P: ConnectorScope[] = ["personal"];
const BOTH: ConnectorScope[] = ["workspace", "personal"];

/** A planned connector. */
function soon(
  id: string,
  name: string,
  category: ConnectorCategory,
  scopes: ConnectorScope[],
  description: string,
  capabilities: ConnectorCapability[] = [],
  personal?: Connector["personal"],
): Connector {
  return { id, name, category, description, scopes, status: "soon", capabilities, ...(personal ? { personal } : {}) };
}

export const CONNECTORS: Connector[] = [
  // Code & CI -------------------------------------------------------------
  {
    id: "github",
    name: "GitHub",
    category: "code",
    description: "Import repositories, with their branches, tags and issues, through g1t's GitHub App.",
    scopes: BOTH,
    status: "available",
    href: { workspace: "/new/github?workspace=:workspace", personal: "/settings/github" },
    capabilities: ["Imports repositories"],
    personal: {
      description: "Sign in with your GitHub account, and reach the repositories you can see there to import them.",
      capabilities: ["Signs you in", "Imports repositories"],
    },
    keywords: ["git", "import", "sign in"],
  },
  {
    id: "webhooks",
    name: "Webhooks",
    category: "code",
    description: "Every repository's events, sent to your own addresses as they happen, signed.",
    scopes: W,
    status: "available",
    href: { workspace: "/:workspace/-/settings/webhooks" },
    capabilities: ["Sends events"],
    keywords: ["http", "events", "outgoing"],
  },
  soon("gitlab", "GitLab", "code", BOTH, "Import projects, with their branches, tags and issues.", ["Imports repositories"], {
    description: "Sign in with GitLab, and reach your own projects to import them.",
    capabilities: ["Signs you in", "Imports repositories"],
  }),
  soon("bitbucket", "Bitbucket", "code", BOTH, "Import repositories, with their branches and tags.", ["Imports repositories"], {
    description: "Reach your own Bitbucket repositories to import them.",
    capabilities: ["Imports repositories"],
  }),
  soon("circleci", "CircleCI", "code", W, "Pipeline results as checks on pull requests, which agents read when a build fails.", ["Agents can read"]),
  soon("buildkite", "Buildkite", "code", W, "Build results as checks on pull requests, with the failing step for agents to fix.", ["Agents can read"]),
  soon("docker-hub", "Docker Hub", "code", W, "Push images your workflows build, and pull private base images.", ["Deploys"]),

  // Issues & projects -----------------------------------------------------
  {
    id: "linear",
    name: "Linear",
    category: "issues",
    description: "Agents read ENG-42 when work mentions it; import them as work items, and they hear back when the work lands.",
    scopes: BOTH,
    status: "available",
    href: { workspace: "/:workspace/-/settings/integrations/trackers?add=linear#add" },
    capabilities: ["Agents can read", "Writes back"],
    provider: "linear",
    personal: {
      description: "Issues assigned to you in Linear, in your g1t inbox beside everything else.",
      status: "soon",
      capabilities: ["Agents can read"],
    },
    keywords: ["tracker", "tickets"],
  },
  {
    id: "jira",
    name: "Jira",
    category: "issues",
    description: "Agents read TECH-1234 when work mentions it; import tickets, and they hear back when the work lands.",
    scopes: W,
    status: "available",
    href: { workspace: "/:workspace/-/settings/integrations/trackers?add=jira#add" },
    capabilities: ["Agents can read", "Writes back"],
    provider: "jira",
    keywords: ["atlassian", "tracker", "tickets"],
  },
  soon("shortcut", "Shortcut", "issues", W, "Stories agents read when work mentions them, updated when the work lands.", ["Agents can read", "Writes back"]),
  soon("clickup", "ClickUp", "issues", W, "Tasks agents can read and import, kept in step with their pull requests.", ["Agents can read", "Writes back"]),
  soon("trello", "Trello", "issues", W, "Cards become work items, and move along their board as the work does.", ["Opens work items", "Writes back"]),

  // Chat & meetings -------------------------------------------------------
  soon("slack", "Slack", "chat", BOTH, "Alerts and updates in the channels your team already reads.", ["Alerts into chat"], {
    description: "Your status in g1t follows the one you set in Slack, and the other way round.",
    capabilities: ["Sets your status"],
  }),
  soon("microsoft-teams", "Microsoft Teams", "chat", BOTH, "Alerts and updates posted to Teams channels.", ["Alerts into chat"], {
    description: "Your status in g1t follows your Teams presence.",
    capabilities: ["Sets your status"],
  }),
  soon("discord", "Discord", "chat", W, "Releases, alerts and updates posted to a Discord server.", ["Alerts into chat"]),
  soon("zoom", "Zoom", "chat", BOTH, "Meeting notes and recordings agents can read when work refers to them.", ["Agents can read"], {
    description: "Sets your status to On a call while you are in a Zoom meeting.",
    capabilities: ["Sets your status"],
  }),
  soon("google-meet", "Google Meet", "chat", P, "Sets your status to On a call while you are in a meeting, and starts a call from any channel.", [
    "Sets your status",
  ]),

  // Calendar & email ------------------------------------------------------
  soon("google-calendar", "Google Calendar", "calendar", P, "Sets your status to In a meeting while you are in one.", ["Sets your status"]),
  soon("outlook-calendar", "Outlook Calendar", "calendar", P, "Sets your status to In a meeting while you are in one.", ["Sets your status"]),
  soon("gmail", "Gmail", "calendar", P, "Turn an email into a work item, from your own inbox.", ["Opens work items"]),
  soon("outlook-mail", "Outlook Mail", "calendar", P, "Turn an email into a work item, from your own inbox.", ["Opens work items"]),

  // Docs & knowledge ------------------------------------------------------
  soon("google-docs", "Google Docs", "docs", BOTH, "Agents read the specs and plans linked from work items and chat.", ["Agents can read"], {
    description: "Docs you share in chat open for agents as well as people.",
    capabilities: ["Agents can read"],
  }),
  soon("coda", "Coda", "docs", W, "Agents read the docs and tables linked from work items and chat.", ["Agents can read"]),

  // Monitoring & incidents ------------------------------------------------
  {
    id: "sentry",
    name: "Sentry",
    category: "monitoring",
    description: "New errors open work items with the stack trace, and resolve in Sentry when the fix merges.",
    scopes: W,
    status: "available",
    href: { workspace: "/:workspace/-/settings/integrations/alerts?add=sentry#add" },
    capabilities: ["Opens work items", "Agents can read", "Writes back"],
    provider: "sentry",
    keywords: ["errors", "alerts", "exceptions"],
  },
  {
    id: "datadog",
    name: "Datadog",
    category: "monitoring",
    description: "Monitors that trigger open work items, and recoveries are noted on them.",
    scopes: W,
    status: "available",
    href: { workspace: "/:workspace/-/settings/integrations/alerts?add=datadog#add" },
    capabilities: ["Opens work items"],
    provider: "datadog",
    keywords: ["monitors", "alerts", "apm"],
  },
  {
    id: "alerts-webhook",
    name: "Alerts webhook",
    category: "monitoring",
    description: "Anything that can send signed JSON opens work items: your own scripts, or any monitoring tool.",
    scopes: W,
    status: "available",
    href: { workspace: "/:workspace/-/settings/integrations/alerts?add=webhook#add" },
    capabilities: ["Opens work items"],
    provider: "webhook",
    keywords: ["incoming", "http", "alerts", "pagerduty", "grafana"],
  },
  soon("pagerduty", "PagerDuty", "monitoring", BOTH, "Incidents open work items, and resolve when the fix lands.", ["Opens work items", "Writes back"], {
    description: "Sets your status to On call while you are on call.",
    capabilities: ["Sets your status"],
  }),
  soon("opsgenie", "Opsgenie", "monitoring", W, "Alerts open work items, and close when the fix lands.", ["Opens work items", "Writes back"]),
  soon("incident-io", "incident.io", "monitoring", W, "Incidents get a channel in g1t, with what changed alongside.", ["Opens work items", "Alerts into chat"]),
  soon("grafana", "Grafana", "monitoring", W, "Alert rules open work items, and agents read the dashboards they link to.", [
    "Opens work items",
    "Agents can read",
  ]),
  soon("new-relic", "New Relic", "monitoring", W, "Alerts open work items, with the traces agents need to find the cause.", [
    "Opens work items",
    "Agents can read",
  ]),
  soon("honeycomb", "Honeycomb", "monitoring", W, "Triggers open work items, and agents query traces while they work.", [
    "Opens work items",
    "Agents can read",
  ]),
  soon("better-stack", "Better Stack", "monitoring", W, "Uptime incidents and log alerts open work items.", ["Opens work items"]),

  // Cloud & deploy --------------------------------------------------------
  soon("aws", "Amazon Web Services", "cloud", W, "Workflows and deployments reach AWS with short-lived credentials, no stored keys.", ["Deploys"]),
  soon("google-cloud", "Google Cloud", "cloud", W, "Workflows and deployments reach Google Cloud with short-lived credentials.", ["Deploys"]),
  soon("azure", "Microsoft Azure", "cloud", W, "Workflows and deployments reach Azure with short-lived credentials.", ["Deploys"]),
  soon("netlify", "Netlify", "cloud", W, "Deploy previews as checks on pull requests.", ["Deploys", "Agents can read"]),
  soon("fly-io", "Fly.io", "cloud", W, "Deploy apps from workflows, and roll back from the deployment's page.", ["Deploys"]),
  soon("kubernetes", "Kubernetes", "cloud", W, "Roll out to your own clusters from workflows, with each rollout's status on g1t.", ["Deploys"]),

  // AI & agents. AI providers are not connectors: they are each workspace's
  // own AI settings, at /:workspace/-/settings/ai.
  {
    id: "mcp",
    name: "MCP clients",
    category: "ai",
    description: "Your own agent, connected to g1t's MCP server, works in g1t as you.",
    scopes: P,
    status: "available",
    href: { personal: "/settings/applications" },
    capabilities: ["Agents can act"],
    keywords: ["model context protocol", "agent", "applications", "oauth"],
  },

  // Data & analytics ------------------------------------------------------
  soon("postgresql", "PostgreSQL", "data", W, "Agents read your schema, and run read-only queries while they investigate.", ["Agents can read"]),
  soon("snowflake", "Snowflake", "data", W, "Agents answer questions from your warehouse with read-only queries.", ["Agents can read"]),
  soon("bigquery", "BigQuery", "data", W, "Agents answer questions from your datasets with read-only queries.", ["Agents can read"]),
  soon("amplitude", "Amplitude", "data", W, "Agents read the charts that work refers to.", ["Agents can read"]),
  soon("segment", "Segment", "data", W, "Agents read your tracking plan, and check new events against it.", ["Agents can read"]),

  // CRM & support ---------------------------------------------------------
  soon("zendesk", "Zendesk", "crm", W, "Turn a ticket into a work item, and tell the customer when the fix ships.", ["Opens work items", "Writes back"]),
  soon("salesforce", "Salesforce", "crm", W, "Agents read the account and case behind a request.", ["Agents can read"]),

  // Design ----------------------------------------------------------------
  soon("miro", "Miro", "design", W, "Agents read the boards linked from work items and chat.", ["Agents can read"]),
  soon("storybook", "Storybook", "design", W, "Each pull request's stories as a check, with what changed.", ["Agents can read"]),

  // Security & identity ---------------------------------------------------
  soon("okta", "Okta", "security", W, "Single sign-on, and people added and removed with your directory.", ["Signs you in", "Syncs people"]),
  soon("entra-id", "Microsoft Entra ID", "security", W, "Single sign-on, and people added and removed with your directory.", ["Signs you in", "Syncs people"]),
  soon(
    "google-workspace",
    "Google Workspace",
    "security",
    BOTH,
    "Single sign-on, and people added and removed with your directory.",
    ["Signs you in", "Syncs people"],
    {
      description: "Sign in to g1t with your Google account.",
      capabilities: ["Signs you in"],
    },
  ),
  soon("1password", "1Password", "security", W, "Secrets from a vault, read by workflows and deployments when they run.", ["Deploys"]),
  soon("snyk", "Snyk", "security", W, "Findings open work items, and an agent opens the fix.", ["Opens work items"]),

  // Files & storage -------------------------------------------------------
  soon("google-drive", "Google Drive", "files", BOTH, "Agents read the files linked from work items and chat.", ["Agents can read"], {
    description: "Attach files from your Drive in chat, without downloading them first.",
    capabilities: ["Agents can read"],
  }),
  soon("dropbox", "Dropbox", "files", BOTH, "Agents read the files linked from work items and chat.", ["Agents can read"], {
    description: "Attach files from your Dropbox in chat.",
    capabilities: ["Agents can read"],
  }),
  soon("onedrive", "OneDrive and SharePoint", "files", BOTH, "Agents read the files linked from work items and chat.", ["Agents can read"], {
    description: "Attach files from your OneDrive in chat.",
    capabilities: ["Agents can read"],
  }),
  soon("box", "Box", "files", W, "Agents read the files linked from work items and chat.", ["Agents can read"]),
];

/** The connector by its id. */
export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find((connector) => connector.id === id);
}

/** A connector as `scope` shows it, or null when it cannot be connected there. */
export function connectorView(connector: Connector, scope: ConnectorScope): ConnectorView | null {
  if (!connector.scopes.includes(scope)) return null;
  const own = scope === "personal" ? connector.personal : undefined;
  const status = own?.status ?? connector.status;
  const other: ConnectorScope = scope === "workspace" ? "personal" : "workspace";
  return {
    id: connector.id,
    name: connector.name,
    category: connector.category,
    description: own?.description ?? connector.description,
    status,
    href: status === "available" ? (connector.href?.[scope] ?? null) : null,
    capabilities: own?.capabilities ?? connector.capabilities ?? [],
    provider: connector.provider ?? null,
    keywords: connector.keywords ?? [],
    alsoIn: connector.scopes.includes(other) ? other : null,
  };
}

/** Every connector `scope` can show, in catalog order. */
export function connectorsFor(scope: ConnectorScope): ConnectorView[] {
  return CONNECTORS.map((connector) => connectorView(connector, scope)).filter((view): view is ConnectorView => view != null);
}

/** A setup path with its `:workspace` filled in. */
export function connectorPath(path: string, workspace: string): string {
  return path.replace(/:workspace\b/g, encodeURIComponent(workspace));
}
