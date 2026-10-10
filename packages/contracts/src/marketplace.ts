/**
 * The Marketplace: what adds functionality to a workspace, the installs it
 * has, and members' requests to add things. Extensions add pages, data and
 * cards; integrations connect what a team already uses so agents can work
 * with it. Agents are not listed here: Agents mode has templates to start
 * one from. Anyone in a workspace browses the Marketplace; only owners add
 * things. A member asks instead, and the request reaches every owner as a
 * notification.
 *
 * Every listing has a reference, `<kind>:<id>`:
 *
 * - `integration:<connector>`: a connector from the catalog
 *   (./connectors.ts); the integrations service keeps the connection;
 * - `extension:<id>`: an extension, described by its manifest
 *   (`ExtensionManifest`): who publishes it, where its source is, the
 *   scopes it asks for, the domains its data goes to, the page it shows
 *   inside g1t, and its pricing. An install (`ExtensionInstall`) pins a
 *   version and can be switched off at once.
 *
 * Extensions are shared the way workflow actions are: a public
 * repository with a manifest, where tagging a release publishes a
 * version, and an install keeps the version it was installed at until an
 * owner takes an update. Nothing is paid yet, but listings carry a
 * pricing field and installs a plan, so paid listings are billing work.
 *
 * The agents service keeps installs (`extension_installs`) and requests
 * (`install_requests`). Wire shapes are snake_case. No imports, so services
 * test it under Node.
 */

/** What a listing adds to a workspace. */
export type ListingKind = "integration" | "extension";

export const LISTING_KINDS: readonly ListingKind[] = ["integration", "extension"];

/** Whether a listing can be added today, or is planned. */
export type ListingStatus = "available" | "soon";

/**
 * Where an extension's server code runs: on g1t (official, verified and
 * internal publishers, and community code once it has an isolated
 * sandbox), or on the publisher's own servers, reached over HTTPS.
 */
export type ExtensionRuntime = "hosted" | "connected";

/** The workspace areas an extension can add to. */
export type ExtensionAdds = {
  /** Its pages, in its sidebar, in order. */
  pages: string[];
  /** Agent roles it brings: templates, configured like any other agent. */
  agent_roles: string[];
  /** Cards it shows in chat and elsewhere, in words. */
  cards: string[];
  /** Tools agents can call. */
  tools: string[];
  /** Notification kinds it sends. */
  notifications: string[];
};

/**
 * An extension, as its manifest describes it. A published one comes from
 * `.g1t/extension.json` in its source repository at a tag; first-party
 * listings not yet published (`status: "soon"`) have no source yet.
 */
export type ExtensionManifest = {
  /** Lowercase letters, digits and hyphens: `support`. */
  id: string;
  name: string;
  /** One line, for cards. */
  tagline: string;
  /** A paragraph, for its page. */
  description: string;
  category: string;
  publisher: { name: string; tier: ListingTier };
  status: ListingStatus;
  /** Its public repository on g1t and the tag a version was published from; null until it is published. */
  source: { repo: string; tag: string } | null;
  /** The version a tag published (`1.4.0`); null until it is published. */
  version: string | null;
  runtime: ExtensionRuntime;
  /** The g1t scopes its token asks for (./scopes.ts), shown in plain words before install. */
  scopes: string[];
  /** What it can do, in plain words, as the install screen lists it. */
  permissions: string[];
  /**
   * Every host outside g1t its data goes to. The install screen says
   * "Data leaves g1t to …" for each; calls anywhere else are refused.
   * Empty: its data stays in g1t.
   */
  domains: string[];
  /**
   * The system outside g1t it bridges, in words (`the CRM you connect`),
   * when its data goes wherever the workspace points it rather than to
   * fixed domains. The install screen says so. Absent or null: none.
   */
  bridges?: string | null;
  /**
   * Its page inside g1t: a path served from the user-content domain
   * (g1tusercontent.com, or a self-hosted instance's own), loaded in a
   * sandboxed frame that reaches g1t only through the bridge. Null: no page.
   */
  ui: { entry: string } | null;
  adds: ExtensionAdds;
  /** Empty while every listing is free; a later price list goes here. */
  pricing: null;
};

/** An extension installed in a workspace. */
export type ExtensionInstall = {
  id: string;
  /** `extension:<id>`. */
  listing: string;
  /** The version installed; updates are offered, never forced. */
  version: string;
  /** The plan it is on: `free` until listings have prices. */
  plan: string;
  installed_by: string;
  /** RFC 3339. */
  installed_at: string;
  /** Off: the kill switch. Its token stops working and its page doesn't load. */
  enabled: boolean;
  /** Who last turned it off, and when; null while it is on. */
  disabled_by: string | null;
  disabled_at: string | null;
  /** Its monthly spend cap, in micro-dollars; null: the workspace's limit applies. */
  budget_monthly_micros: number | null;
};

/** The plan an install records while nothing is paid. */
export const FREE_PLAN = "free";

/** A manifest's checks, as publishing applies them; `knownScope` says which scopes exist (./scopes.ts `isScope`). */
export function checkManifest(raw: unknown, knownScope: (scope: string) => boolean): { ok: true; value: ExtensionManifest } | { ok: false; message: string } {
  const m = raw as Partial<ExtensionManifest> | null;
  const bad = (message: string) => ({ ok: false as const, message });
  if (!m || typeof m !== "object") return bad("The manifest isn't a JSON object.");
  if (typeof m.id !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(m.id)) return bad("`id` is 2 to 32 lowercase letters, digits and hyphens, starting with a letter.");
  for (const field of ["name", "tagline", "description", "category"] as const) {
    if (typeof m[field] !== "string" || !m[field]!.trim()) return bad(`\`${field}\` is required.`);
  }
  if (!m.publisher || typeof m.publisher.name !== "string" || !LISTING_TIERS.includes(m.publisher.tier as ListingTier)) return bad("`publisher` needs a name and a tier.");
  if (m.status !== "available" && m.status !== "soon") return bad("`status` is available or soon.");
  if (m.runtime !== "hosted" && m.runtime !== "connected") return bad("`runtime` is hosted or connected.");
  if (m.runtime === "hosted" && m.publisher.tier === "community") return bad("Community extensions run on their publisher's servers (`connected`) until hosted code has an isolated sandbox.");
  if (m.status === "available" && (!m.source || !m.version)) return bad("A published extension names its source repository, tag and version.");
  if (m.source && (typeof m.source.repo !== "string" || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(m.source.repo) || typeof m.source.tag !== "string" || !m.source.tag)) return bad("`source` is a repository (`owner/name`) and a tag.");
  if (!Array.isArray(m.scopes) || m.scopes.some((scope) => typeof scope !== "string" || !knownScope(scope))) return bad("Every scope must be one g1t has.");
  if (!Array.isArray(m.permissions) || m.permissions.length === 0) return bad("List what it can do in `permissions`, in plain words.");
  if (!Array.isArray(m.domains) || m.domains.some((domain) => typeof domain !== "string" || !isHost(domain))) return bad("`domains` are host names, such as api.example.com.");
  if (m.runtime === "connected" && m.domains.length === 0) return bad("A connected extension declares the domains it runs on.");
  if (m.bridges != null && (typeof m.bridges !== "string" || !m.bridges.trim())) return bad("`bridges` names the system it connects to, in words.");
  if (m.ui !== null && (typeof m.ui !== "object" || typeof m.ui?.entry !== "string" || !m.ui.entry.startsWith("/"))) return bad("`ui.entry` is a path, such as /index.html.");
  if (!m.adds || !["pages", "cards", "agent_roles", "tools", "notifications"].every((k) => Array.isArray((m.adds as Record<string, unknown>)[k]))) return bad("`adds` lists pages, cards, agent_roles, tools and notifications.");
  if (m.pricing !== null) return bad("Listings are free for now: `pricing` is null.");
  return { ok: true, value: m as ExtensionManifest };
}

function isHost(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

/** What the install screen says about where an extension's data goes. */
export function dataDisclosure(manifest: Pick<ExtensionManifest, "domains" | "bridges">): string {
  const to = [...manifest.domains, ...(manifest.bridges ? [manifest.bridges] : [])];
  if (to.length === 0) return "Its data stays in g1t.";
  return `Data leaves g1t to ${to.join(", ")}.`;
}

/** Where an extension's page loads from: its entry on the user-content origin, under its id and version. */
export function extensionFrameUrl(manifest: Pick<ExtensionManifest, "id" | "version" | "ui">, usercontentOrigin: string): string | null {
  if (!manifest.ui || !manifest.version) return null;
  return `${usercontentOrigin.replace(/\/+$/, "")}/x/${manifest.id}/${manifest.version}${manifest.ui.entry}`;
}

/** A version as a tag names it: `v1.4.0` and `1.4.0` are both `1.4.0`; null when it isn't one. */
export function versionOfTag(tag: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return match ? match[1]! : null;
}

/** What every first-party listing shares before its first release. */
const UNRELEASED = {
  publisher: { name: "g1t", tier: "official" as const },
  status: "soon" as const,
  source: null,
  version: null,
  runtime: "hosted" as const,
  ui: { entry: "/index.html" },
  pricing: null,
};

/**
 * g1t's own extensions. None is published yet: each is listed so people
 * see what is coming, and can't be installed until its first release. The
 * last three are connected systems: each bridges a system a team already
 * runs, so agents work across it and g1t together.
 */
export const FIRST_PARTY_EXTENSIONS: ExtensionManifest[] = [
  {
    ...UNRELEASED,
    id: "mail",
    name: "Mail",
    tagline: "Email on your own domain, with shared inboxes agents work in.",
    description:
      "Email that g1t runs on your domain. Shared inboxes such as support@ and sales@ work like channels: agents sort and draft, and sending needs approval or a rule you set. Spam and phishing filtering is included, at what it costs to run. Gmail and Outlook keep working alongside it.",
    category: "Communication",
    scopes: ["notifications:write", "artifacts:read"],
    permissions: ["Host email for your domain", "Let agents read shared inboxes and draft replies", "Send only with approval or a rule you set"],
    domains: [],
    adds: { pages: ["Inbox", "Shared inboxes", "Sent", "Rules for agents"], cards: ["Email threads in chat"], agent_roles: [], tools: ["mail", "thread"], notifications: ["Drafts to approve"] },
  },
  {
    ...UNRELEASED,
    id: "support",
    name: "Support",
    tagline: "Customer conversations an agent answers from your docs, escalating the rest.",
    description:
      "Conversations, escalations, macros and a knowledge base. A support agent answers what your docs cover, turns bug reports into issues in Code, and hands anything else to a person. Email to customers waits for approval.",
    category: "Customers",
    scopes: ["issues:write", "artifacts:read", "notifications:write"],
    permissions: ["Read and reply to support email, with your approval", "Store conversations in workspace data", "Open issues from bug reports"],
    domains: [],
    adds: {
      pages: ["Conversations", "Escalations", "Macros", "Knowledge"],
      cards: ["Customer cards in chat", "Bug reports as issues in Code"],
      agent_roles: ["Support Specialist"],
      tools: ["conversation", "macro"],
      notifications: ["Escalations"],
    },
  },
  {
    ...UNRELEASED,
    id: "crm",
    name: "CRM",
    tagline: "Accounts, deals and a pipeline, with agents that keep it current.",
    description:
      "Accounts and contacts, deals by stage and a weekly forecast, kept as workspace data. Agents log calls and email, draft follow-ups for a person to send, and flag deals that have gone quiet.",
    category: "Customers",
    scopes: ["artifacts:write", "notifications:write"],
    permissions: ["Store accounts, contacts and deals in workspace data", "Read email threads with customers in shared inboxes", "Draft follow-ups that a person sends"],
    domains: [],
    adds: { pages: ["Pipeline", "Deals", "Accounts", "Forecast"], cards: ["Account cards in chat"], agent_roles: ["Sales Ops"], tools: ["deal", "account"], notifications: ["Deals gone quiet"] },
  },
  {
    ...UNRELEASED,
    id: "recruiting",
    name: "Recruiting",
    tagline: "Openings, candidates and interview loops. Agents screen, people decide.",
    description:
      "A pipeline board, scorecards and scheduling. A recruiting agent screens applicants against your scorecard and books interview loops; offers and decisions stay with people.",
    category: "People",
    scopes: ["artifacts:write", "notifications:write"],
    permissions: ["Store candidates and openings in workspace data", "Read and write interview events on connected calendars", "Email candidates from a shared address, with your approval"],
    domains: [],
    adds: {
      pages: ["Pipeline", "Openings", "Candidates", "Interviews", "Offers"],
      cards: ["Candidate cards in chat"],
      agent_roles: ["Recruiter"],
      tools: ["candidate", "opening"],
      notifications: ["Offers to sign"],
    },
  },
  {
    ...UNRELEASED,
    id: "on-call",
    name: "On-call",
    tagline: "Rotations, pages and who is on call now.",
    description: "Rotations and schedules, pages through notifications, and an incident channel an operations agent keeps a timeline in.",
    category: "Engineering",
    scopes: ["notifications:write", "issues:read"],
    permissions: ["Store rotations in workspace data", "Page people through their notifications", "Read issues an incident links to"],
    domains: [],
    adds: { pages: ["Rotations", "Pages", "Incidents"], cards: ["Who's on call, in chat"], agent_roles: [], tools: ["rotation", "page"], notifications: ["Pages", "Your shift"] },
  },
  {
    ...UNRELEASED,
    id: "helpdesk-bridge",
    name: "Helpdesk bridge",
    tagline: "Work tickets from the helpdesk you already run, next to your code and chat.",
    description:
      "Connects the helpdesk your team already uses. Its tickets show in g1t with the customer and the conversation; agents draft replies there for a person to send, and a bug report becomes an issue in Code that stays linked to its ticket.",
    category: "Connected systems",
    scopes: ["issues:write", "notifications:write"],
    permissions: ["Read tickets and customers in the helpdesk you connect", "Draft replies there, sent by a person or a rule you set", "Open issues in Code linked to a ticket"],
    domains: [],
    bridges: "the helpdesk you connect",
    adds: { pages: ["Tickets", "Linked issues"], cards: ["Ticket cards in chat"], agent_roles: [], tools: ["ticket"], notifications: ["Tickets assigned to you"] },
  },
  {
    ...UNRELEASED,
    id: "crm-bridge",
    name: "CRM bridge",
    tagline: "The accounts and deals in the CRM you already use, in g1t and in chat.",
    description:
      "Connects the CRM your team already uses. Accounts and deals show in g1t and in chat, and agents log calls, update stages and draft follow-ups there, each change in the audit log.",
    category: "Connected systems",
    scopes: ["notifications:write"],
    permissions: ["Read accounts, contacts and deals in the CRM you connect", "Log activity and update deal stages there", "Draft follow-ups that a person sends"],
    domains: [],
    bridges: "the CRM you connect",
    adds: { pages: ["Accounts", "Deals"], cards: ["Account cards in chat"], agent_roles: [], tools: ["account", "deal"], notifications: ["Deals gone quiet"] },
  },
  {
    ...UNRELEASED,
    id: "erp-bridge",
    name: "ERP bridge",
    tagline: "Orders, invoices and stock from your ERP, for agents that answer and reconcile.",
    description:
      "Connects the ERP your business runs on. Agents look up orders, invoices and stock to answer questions in chat and support, and reconcile what doesn't match. Anything that changes money or stock waits for a person's approval.",
    category: "Connected systems",
    scopes: ["notifications:write"],
    permissions: ["Read orders, invoices and stock in the ERP you connect", "Propose changes there, each approved by a person"],
    domains: [],
    bridges: "the ERP you connect",
    adds: { pages: ["Orders", "Invoices", "Approvals"], cards: ["Order cards in chat"], agent_roles: [], tools: ["order", "invoice"], notifications: ["Changes to approve"] },
  },
];

/** A first-party extension by id. */
export function extensionById(id: string): ExtensionManifest | undefined {
  return FIRST_PARTY_EXTENSIONS.find((extension) => extension.id === id);
}

/**
 * Who stands behind a listing: g1t itself, a reviewed publisher, anyone,
 * or the workspace's own people.
 */
export type ListingTier = "official" | "verified" | "community" | "internal";

export const LISTING_TIERS: readonly ListingTier[] = ["official", "verified", "community", "internal"];

/**
 * Who stands behind every integration: the connector catalog
 * (./connectors.ts) is g1t's own, so each connector is Official.
 */
export const CONNECTOR_PUBLISHER: { name: string; tier: ListingTier } = { name: "g1t", tier: "official" };

/** A listing's reference, split: `integration:sentry` is `{ kind: "integration", id: "sentry" }`. */
export type ListingRef = { kind: ListingKind; id: string };

/** Where a request stands: waiting on an owner, added, or turned down. */
export type InstallRequestStatus = "open" | "done" | "declined";

export const INSTALL_REQUEST_STATUSES: readonly InstallRequestStatus[] = ["open", "done", "declined"];

/** A member's request that the workspace add a listing. */
export type InstallRequest = {
  id: string;
  /** `<kind>:<id>`. */
  listing: string;
  kind: ListingKind;
  /** The listing's name when it was asked for, such as `Sentry` or `Support`. */
  name: string;
  /** Why they want it, in their words, or null. */
  note: string | null;
  /** Who asked, by username. */
  requested_by: string;
  /** RFC 3339. */
  requested_at: string;
  status: InstallRequestStatus;
  /** The owner who added it or turned it down, by username. */
  resolved_by: string | null;
  /** RFC 3339. */
  resolved_at: string | null;
};

/**
 * Requests as one person sees them: an owner, every request in the
 * workspace (`can_resolve`); anyone else, their own. Open ones first, then
 * the latest; answered ones for 30 days.
 */
export type InstallRequests = { requests: InstallRequest[]; can_resolve: boolean };

/** The longest note a request carries. */
export const MAX_REQUEST_NOTE = 280;
/** The most requests one person keeps open in a workspace. */
export const MAX_OPEN_REQUESTS = 20;
/** How long an answered request stays listed. */
export const ANSWERED_REQUESTS_DAYS = 30;

/** A listing's reference: `integration:sentry`. */
export function listingRef(kind: ListingKind, id: string): string {
  return `${kind}:${id}`;
}

/** A reference split into kind and id; null when it is not one. */
export function parseListing(value: unknown): ListingRef | null {
  if (typeof value !== "string") return null;
  const match = /^(integration|extension):([a-z0-9][a-z0-9_-]{0,63})$/.exec(value.trim());
  return match ? { kind: match[1] as ListingKind, id: match[2]! } : null;
}

/** A note as kept: trimmed, at most `MAX_REQUEST_NOTE` characters, null when empty. */
export function cleanRequestNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_NOTE);
  return note || null;
}
