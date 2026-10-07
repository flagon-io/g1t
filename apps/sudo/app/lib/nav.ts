/**
 * sudo's navigation, and the roadmap for what g1t is building in house:
 * its own CRM and back office, in place of bought ones. Each item is a
 * real page. One marked `soon` renders a placeholder that says what it
 * will do and why, so staff can see where sudo is going (routes.ts makes
 * a route for each). No Workers or React imports, so it can be tested
 * under Node.
 */

/** The icon a sidebar item shows; components/shell.tsx draws each one. */
export type NavIcon =
  | "overview"
  | "workspaces"
  | "enterprises"
  | "reach-out"
  | "people"
  | "invoices"
  | "prices"
  | "credits"
  | "usage"
  | "stripe"
  | "costs"
  | "agents"
  | "abuse"
  | "incidents"
  | "inbox"
  | "view-as"
  | "announcements"
  | "staff"
  | "audit"
  | "requests"
  | "overages"
  | "velocity"
  | "invites"
  // Sections
  | "customers"
  | "spend"
  | "revenue"
  | "platform"
  | "support"
  | "team";

/** What a page that is not built yet says about itself. */
export type Roadmap = {
  /** What it will do and why, two to four sentences. */
  summary: string[];
  /** What it will have, one line each. */
  plans: string[];
  /** Something staff should know now, such as where to go meanwhile. */
  meanwhile?: { text: string; to?: string; link?: string };
};

export type NavItem = {
  label: string;
  /** Where it lives. A `soon` item's page is the placeholder. */
  to: string;
  icon: NavIcon;
  /** One line, shown on hover. */
  about: string;
  /** Other paths under which this item is the current one. */
  also?: string[];
  /** Not built yet: the page says what it will be. */
  soon?: Roadmap;
  /** A number the sidebar shows beside it while it is above zero, such as requests waiting. */
  count?: NavCount;
};

/** The numbers the sidebar can show, read by root.tsx on every page. */
export type NavCount = "waitlist" | "incidents";

export type NavCounts = Partial<Record<NavCount, number>>;

/** What a page or a folded section shows beside it: its items' counts, added up. */
export function countFor(items: Pick<NavItem, "count">[], counts: NavCounts): number {
  return items.reduce((sum, item) => sum + (item.count ? (counts[item.count] ?? 0) : 0), 0);
}

/**
 * A section of the sidebar: a row with an icon that opens to its pages,
 * as GitLab and Vercel fold theirs. One with no title is top-level links.
 */
export type NavGroup = { title: string | null; icon?: NavIcon; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    title: null,
    items: [
      { label: "Overview", to: "/", icon: "overview", about: "The business at a glance: this month, the last six, and who needs a word." },
      { label: "Reach out", to: "/reach-out", icon: "reach-out", about: "Who is worth a word now, and who on the team has it." },
    ],
  },
  {
    title: "Customers",
    icon: "customers",
    items: [
      { label: "Workspaces", to: "/workspaces", icon: "workspaces", about: "Every workspace, who owns it, and how it pays." },
      { label: "Enterprises", to: "/enterprises", icon: "enterprises", about: "Customers paying for several workspaces with one bill." },
      {
        label: "Invites",
        to: "/invites",
        icon: "invites",
        about: "The waitlist, every invite, more invites for a person or workspace, and who invited whom.",
        count: "waitlist",
      },
      {
        label: "People",
        to: "/people",
        icon: "people",
        about: "Everyone with a g1t account, across the workspaces they belong to.",
        soon: {
          summary: [
            "Every person with a g1t account, not just the workspaces they belong to. Support starts from a person far more often than from a workspace: someone writes in from an email address, and staff need to find them, see which workspaces they own or belong to, and what they did lately.",
            "It gives sales a view of contacts as well as accounts: the owner who signs, the engineer who brought g1t in, and who to ask when a workspace goes quiet.",
          ],
          plans: [
            "Search by username, email or name, across every account",
            "A person's page: their workspaces and role in each, sign-ins, verified email, two-factor status",
            "Contacts on a workspace: who is the buyer, who is technical, who to bill",
            "Merge duplicate accounts, and resend or change a verification email, each recorded",
          ],
          meanwhile: { text: "Search a workspace by an owner's username or email on Workspaces.", to: "/workspaces", link: "Workspaces" },
        },
      },
    ],
  },
  {
    title: "Spend",
    icon: "spend",
    items: [
      {
        label: "Requests",
        to: "/requests",
        icon: "requests",
        about: "Owners asking for a higher limit or help with a month: answered within one business day.",
      },
      {
        label: "Overages",
        to: "/overages",
        icon: "overages",
        about: "Workspaces well past their typical month, what caused it, and goodwill credits.",
      },
      {
        label: "Velocity",
        to: "/velocity",
        icon: "velocity",
        about: "Who is spending fastest right now, against their usual hour, and any spikes.",
      },
    ],
  },
  {
    title: "Revenue",
    icon: "revenue",
    items: [
      {
        label: "Invoices",
        to: "/invoices",
        icon: "invoices",
        about: "Every invoice g1t has sent, to workspaces and enterprises.",
      },
      {
        label: "Plans & prices",
        to: "/prices",
        icon: "prices",
        about: "The price book: what each meter costs g1t and what it sells for.",
        soon: {
          summary: [
            "The price book, edited in sudo instead of in code. Every metered unit (sandbox seconds, builds, app requests and CPU, app-months) has what it costs g1t and what g1t sells it for, and the price follows the cost with a markup.",
            "Changing a markup or a plan's price is a decision finance makes and should be able to make safely: previewed against last month's usage, with a date it takes effect, and recorded with who made it and why.",
          ],
          plans: [
            "Each meter's cost, markup and price, and where the cost came from (Cloudflare's list price or its bill)",
            "Edit a markup or a plan's monthly price, with a preview of what last month would have charged",
            "Schedule a change for the start of a month, so no one is charged mid-month on a new price",
            "Every change in the history the public pricing page already shows",
          ],
        },
      },
      {
        label: "Credits & refunds",
        to: "/credits",
        icon: "credits",
        about: "Every credit and refund staff have issued, and why.",
        soon: {
          summary: [
            "Every credit and refund staff have given, across all customers: how much, to whom, by whom and why. Goodwill is a cost, and finance needs to see what it adds up to each month.",
            "It is also where refunds to a card will live. Today a credit goes to a workspace's balance; giving money back to the card it came from goes through Stripe, and should be done from here, recorded, with the same typed confirmation as a credit.",
          ],
          plans: [
            "Every credit, filterable by staff member, workspace and month, with totals",
            "Refund a payment to the card it came from, in full or in part",
            "Per-role limits: support can credit up to a set amount; more needs finance",
            "Reasons as a short list (outage, billing error, goodwill, trial) so they can be counted",
          ],
          meanwhile: { text: "Issue a credit from the workspace's page, under Billing.", to: "/workspaces", link: "Workspaces" },
        },
      },
      {
        label: "Usage explorer",
        to: "/usage",
        icon: "usage",
        about: "What customers used, sliced by meter, model, repository and day.",
        soon: {
          summary: [
            "What customers used, across every workspace, sliced any way: by meter, model, repository, task and day. It answers the questions that come up in a sales call or a cost review: who uses the most sandbox time, which model costs most, what a customer's agents spend per pull request.",
            "Billing records every run and sandbox second with its cost and charge already. This puts it in front of the people who need it, without a query.",
          ],
          plans: [
            "Charged, cost and margin over any range, for everyone or one customer",
            "Group by meter, model, task, repository or workspace; compare two periods",
            "The heaviest workspaces this month, and how fast each is growing",
            "Export to CSV",
          ],
        },
      },
    ],
  },
  {
    title: "Platform",
    icon: "platform",
    items: [
      { label: "Stripe", to: "/stripe", icon: "stripe", about: "Billing's Stripe keys, webhook, and the events Stripe sent." },
      {
        label: "Costs & margin",
        to: "/costs",
        icon: "costs",
        about: "Where g1t's money goes, with what it gave away kept apart; on Bill & pricing, Cloudflare's bill, drift and the price book.",
      },
      {
        label: "Agents & models",
        to: "/agents",
        icon: "agents",
        about: "The models agents run on, what each costs, and how runs are going.",
        soon: {
          summary: [
            "The models g1t's agents run on, and how they are doing: runs, failures, tokens and cost per model, and which workspaces bring their own provider. It is where staff decide which models to offer and see what a change in a provider's price means.",
            "Hosted models are open to some workspaces and not others; that list belongs here, edited and recorded, not in configuration.",
          ],
          plans: [
            "Runs, failures and cost per model, per day",
            "Who may use g1t's hosted models, and the free allowance's pool",
            "Workspaces on their own provider, and the sandbox time their runs use",
            "Stuck or long-running agents, with a way to stop one",
          ],
        },
      },
      {
        label: "Abuse & fraud",
        to: "/abuse",
        icon: "abuse",
        about: "Sandboxes stopped for looking like mining, and disputes and declines.",
      },
      {
        label: "Incidents",
        to: "/incidents",
        icon: "incidents",
        about: "Declare and run incidents, schedule maintenance, and publish postmortems on status.g1t.sh.",
        count: "incidents",
      },
    ],
  },
  {
    title: "Support",
    icon: "support",
    items: [
      {
        label: "Inbox",
        to: "/inbox",
        icon: "inbox",
        about: "Customers' messages, beside everything about who sent them.",
        soon: {
          summary: [
            "Customers' email and in-app messages in one queue, each beside everything sudo knows about who sent it: their workspaces, what they pay, their limit, their last invoice, and the notes sales kept. Support answers faster when nothing needs looking up.",
            "Built in house so a conversation can become an action without leaving it: a credit, a billing link, a note on the workspace.",
          ],
          plans: [
            "Assign, snooze and close conversations; see who is answering what",
            "The sender's workspaces, plan, limit and recent invoices alongside",
            "Saved replies, and links that open the right page in g1t",
            "Response times by person and by week",
          ],
        },
      },
      {
        label: "View as customer",
        to: "/view-as",
        icon: "view-as",
        about: "See g1t as a customer sees it, audited and time-limited.",
        soon: {
          summary: [
            "See g1t exactly as a customer sees it, to reproduce what they describe. Read-only by default, it is the most sensitive thing staff can do, so it is built to be safe first.",
            "Every session will be audited and time-limited: it needs a reason, it ends on its own, the customer's own audit log says that g1t staff looked, and nothing can be changed or any secret read while viewing.",
          ],
          plans: [
            "Start a session with a reason (a support conversation or a note); it ends after 30 minutes",
            "Read-only: no pushes, no settings, no secrets, no billing changes",
            "A banner on every page while it lasts, and a record in the customer's audit log",
            "Only roles allowed to, and a list of every session for review",
          ],
        },
      },
      {
        label: "Announcements",
        to: "/announcements",
        icon: "announcements",
        about: "Banners and notices for customers: incidents, maintenance, changes.",
        soon: {
          summary: [
            "Tell customers what they need to know, from one place: a banner for an incident or maintenance, a notice about a price change, an email to the owners of the workspaces a change affects.",
            "Notices can go to everyone or to a slice (owners on an enterprise, workspaces near their limit), with a start and an end, and a record of who sent what.",
          ],
          plans: [
            "Banners in g1t with a start, an end, and a severity",
            "Email to owners of chosen workspaces, previewed before it goes",
            "Price-change notices with the notice period the terms require",
            "A history of everything announced",
          ],
        },
      },
    ],
  },
  {
    title: "Team",
    icon: "team",
    items: [
      {
        label: "Staff & roles",
        to: "/staff",
        icon: "staff",
        about: "Who is staff, and what each role may do.",
        soon: {
          summary: [
            "Who is g1t staff and what each of them may do. Today everyone in STAFF_EMAILS may do everything; as the team grows, roles should match the work: sales can see accounts and keep notes but cannot credit, support can make billing links and small credits, finance can change terms and issue refunds.",
            "Access still decides who gets in. Roles decide what they can do once there, and every refusal is recorded like every change.",
          ],
          plans: [
            "Roles (sales, support, finance, admin) with the permissions each grants",
            "Per-role limits on money: the most a credit can be without a second person",
            "Assign roles by email, recorded, with the date each was given",
            "A second person's approval for comped terms and large credits",
          ],
        },
      },
      {
        label: "Audit log",
        to: "/audit",
        icon: "audit",
        about: "Every change made in sudo, by whom, across every customer.",
      },
    ],
  },
];

/** Whether a section holds the page at `pathname`, so it is drawn open. */
export function holdsCurrent(group: NavGroup, pathname: string): boolean {
  return group.items.some((item) => isCurrent(item, pathname));
}

/** Every item, in sidebar order. */
export function navItems(nav: NavGroup[] = NAV): NavItem[] {
  return nav.flatMap((group) => group.items);
}

/** The items not built yet, each with the placeholder page routes.ts makes. */
export function soonItems(nav: NavGroup[] = NAV): (NavItem & { soon: Roadmap })[] {
  return navItems(nav).filter((item): item is NavItem & { soon: Roadmap } => item.soon != null);
}

/** The item for a path, if one is its page. */
export function soonFor(pathname: string, nav: NavGroup[] = NAV): (NavItem & { soon: Roadmap }) | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  return soonItems(nav).find((item) => item.to === path) ?? null;
}

/**
 * Whether `item` is the current page at `pathname`: its own path or one
 * beneath it. `/` is current only on itself.
 */
export function isCurrent(item: Pick<NavItem, "to" | "also">, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return [item.to, ...(item.also ?? [])].some((prefix) => {
    const base = prefix.split("?")[0];
    if (base === "/") return path === "/";
    return path === base || path.startsWith(`${base}/`);
  });
}
