import { ArrowUpRight } from "lucide-react";

import type { FeaturePlan, FreeTier, Price } from "@g1t/contracts";
import { type InstanceType, machineSize, machines } from "@g1t/contracts/instances";

import type { Route } from "./+types/pricing";
import { money as sum, wholeDollars } from "../lib/money";
import { page } from "../lib/meta";
import { application, faqPage } from "../lib/structured-data";
import { TimeAgo } from "../components/ui";
import { Card } from "../components/ui/card";
import { billing } from "../lib/services.server";
import { Unavailable } from "../components/boundary";
import { isFailed, orElse, part } from "../lib/partial";

export function meta(args: Route.MetaArgs) {
  const plan = args.loaderData?.book?.plans?.find((p) => p.feature === "plan") ?? DEFAULT_PLAN;
  return [
    ...page(args, {
      title: `g1t pricing - $${plan.monthlyCents / 100} per workspace, never per seat, usage priced from cost plus 20%`,
      description:
        "People chat free on every plan, and the forge is free. One plan, $21 a month per workspace with $10 of usage included. Runner minutes are a flat rate per machine; everything else g1t runs is priced from what it costs, plus 20%. Your own runners are free. No seats, ever.",
    }),
    application(plan.monthlyCents / 100),
    faqPage(FAQ),
  ];
}

export async function loader() {
  // The page reads without the price book: the plan and the rest are its
  // defaults, and the usage table and price changes say they could not be
  // loaded instead of looking empty.
  const [book, status] = await Promise.all([part(billing.prices(), "The price book"), billing.status().catch(() => null)]);
  return { book: orElse(book, null), unpriced: isFailed(book), free: status?.free ?? false };
}

/** A price, with the fraction of a cent it is set to: `$0.024`, `$0.25`. */
function money(micros: number): string {
  return sum(micros, { precise: true });
}

/** Per second is easier to read per minute. */
function perUnit(price: Price, micros: number): string {
  return price.unit === "second" ? `${money(micros * 60)} a minute` : `${money(micros)} per ${price.unit}`;
}

function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1e9) * 10) / 10} GB`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Price-book rows the table shows in rows of their own, or not at all. The
 * agent and model meters are retired: a price book that still lists them
 * leaves them off the page.
 */
const SHOWN_APART = new Set([
  "app_month",
  "agent_models",
  "agent_tokens",
  "agent_tokens_own",
  "agent_token_weight_input",
  "agent_token_weight_output",
  "agent_token_weight_cache_read",
  "agent_token_weight_cache_write",
  "gateway_models",
  "card_fee_percent",
  "card_fee_fixed",
  "security_activation",
  // What a sandbox second costs g1t: runner minutes are charged at each
  // machine's rate, in rows of their own.
  "sandbox_second",
  "sandbox_base_second",
  "sandbox_cpu_second",
]);

/**
 * What a minute of a machine costs g1t at Cloudflare's list prices with
 * every vCPU busy: memory, disk and the Durable Object behind it (128 MB)
 * for every second, and its vCPUs.
 */
function busyMinuteMicros(instance: InstanceType): number {
  return 60 * (instance.memoryGib * 2.5 + instance.diskGb * 0.07 + 0.125 * 12.5 + instance.vcpu * 20);
}

/** A retired meter: agents' models and tokens, and the AI Gateway. */
function retired(meter: string): boolean {
  return meter.startsWith("agent_") || meter === "gateway_models";
}

/** What the page says when billing cannot be reached: the published defaults. */
const DEFAULT_FREE: Required<FreeTier> = {
  trialWorkspaceMicros: 5_000_000,
  trialMonthlyPoolMicros: 100_000_000,
  ossPoolMicros: 50_000_000,
  ossRepoMicros: 4_000_000,
  freePrivateStorageBytes: 1_000_000_000,
  auditRetentionDays: 7,
  planAuditRetentionDays: 90,
  minChargeMicros: 5_000_000,
  gitOperationsIncluded: 50_000,
  paidStartCeilingMicros: 100_000_000,
  overageForgiveCostMicros: 50_000_000,
};

const DEFAULT_PLAN: FeaturePlan = {
  feature: "plan",
  title: "g1t",
  monthlyCents: 2100,
  includes: [
    "$10 of usage each month, used first: runner minutes at their flat rate, everything else g1t runs at cost plus 20%",
    "Everyone in the workspace at one price, never per person",
    "Unlimited projects, previews and repositories",
    "Checks, workflows, the merge queue, deployments, semantic search, and Security and quality on private repositories",
    "Usage past $10 is charged the same way, up to your spend limit",
  ],
  overage:
    "Everything g1t runs is metered from the first unit, priced from what it costs g1t plus 20%: runner minutes at a fixed rate for each machine, the rest at cost plus 20%. Your own runners cost nothing. Unused included usage does not roll over.",
};

/** How each part of a workspace is charged. */
const WORKSPACE_CHARGES: { what: string; how: string; soon?: boolean }[] = [
  {
    what: "People chatting",
    how: "Included on every plan, the free one too: channels, direct messages, threads, mentions and live delivery. No seats, and history is never cut off.",
  },
  { what: "Docs", how: "Included on every plan, like chat: pages, live editing and history.", soon: true },
  {
    what: "Your coding agents",
    how: "Nothing from g1t. Coding agents you already use connect through the MCP server and the API with your access tokens; their models are billed by whoever runs them. What they start on g1t, such as checks and workflows, is charged like anyone else's.",
  },
  {
    what: "Files in chat and Docs",
    how: "The storage meter, at cost plus 20%, past what is free.",
    soon: true,
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do people pay to use Chat?",
    a: "No. Messages, channels, threads and live delivery are included on every plan, with no per-person price and no limit on history. A workspace on the plan can add as many people as it likes at the same price.",
  },
  {
    q: "Does using my coding agent with g1t cost extra?",
    a: "No. Claude Code, Codex, Cursor and other coding agents connect through g1t's MCP server and API with your access tokens, at no charge. Their models are billed by whoever runs them. What they start on g1t, such as checks and workflows, is charged like anything else.",
  },
  {
    q: "Does adding the whole company cost more?",
    a: "No. There are no seats. People who only chat cost nothing.",
  },
  {
    q: "What does moving from GitHub cost, and can we leave again?",
    a: "Moving in is an import: bring repositories across from GitHub with every branch, tag and their work items. Your code is plain git and g1t is MIT licensed, so leaving is a git clone, and the core forge runs on your own machine with Docker Compose.",
  },
  {
    q: "Is Docs included?",
    a: "Docs is coming soon. When it ships, pages, editing and history are included on every plan, like chat. Files are on the storage meter.",
  },
];

/** The ways to reach g1t about an enterprise account. */
const ENTERPRISE_MAIL = "mailto:support@g1t.sh?subject=Enterprise%20billing%20for%20g1t";

const HOW = [
  {
    title: "Our cost, passed through",
    body: "Every runner minute, build and app request costs g1t money at Cloudflare. Builds and app traffic are charged at that cost plus 20%, from the first second and the first request; runner minutes at a fixed rate for each machine, set from its cost plus 20% and never under its cost with every vCPU busy. Use a little, pay a little.",
  },
  {
    title: "Prices follow costs, by themselves",
    body: "Every day, sandbox, build and app costs are checked against what Cloudflare billed g1t; when one moves, its price moves with it, and the change is listed below. The rest are Cloudflare's published prices, marked as such.",
  },
  {
    title: "The 20% is the overhead",
    body: "It pays for running g1t and for building and keeping up the features you use. The same 20% on everything, and nothing bundled in.",
  },
  {
    title: "Your own runners are free",
    body: "Checks, workflows and the merge queue on your own hardware cost nothing here.",
  },
  {
    title: "No seats, ever",
    body: "Once a workspace is on the plan, add as many people as you like. It pays one flat price for the plan, and for what it uses past what the plan includes.",
  },
  {
    title: "Prices exclude tax",
    body: "Every price here is before tax. Stripe adds sales tax, VAT or GST where it applies, worked out from the billing address, and shows it as its own line before you pay and on every receipt and invoice. A valid business tax ID is applied where the law says so.",
  },
  {
    title: "No card fee on top",
    body: "Stripe's card processing fee is part of the price. Paying by card, by bank transfer or by invoice costs the same: the price, plus tax where it applies.",
  },
];

/** One row of the free-and-plan table. */
type Row = { what: string; free: string; plan: string; note?: string };

function rows(tier: Required<FreeTier>): Row[] {
  return [
    {
      what: "Chat",
      free: "Included, for the people already in the workspace",
      plan: "Included, for unlimited members",
      note: "Channels, direct messages, threads, mentions and live delivery. History is never cut off.",
    },
    {
      what: "Docs (coming soon)",
      free: "Included",
      plan: "Included",
      note: "Pages, live editing and history, once Docs ships.",
    },
    {
      what: "The forge",
      free: "Free",
      plan: "Included",
      note: "Public and private repositories, work items, pull requests, reviews, protected branches, code owners, search and Explore.",
    },
    {
      what: "Checks, workflows, merge queue",
      free: "After a card check: the trial, and the open-source pool for checks, workflows and the merge queue on public repositories",
      plan: "From the plan's included usage, then by the runner minute, at a fixed rate for each machine",
    },
    {
      what: "Projects and previews",
      free: "Not available: deployments run on g1t's machines",
      plan: "Unlimited, and never charged for. An app no one visits costs nothing.",
    },
    {
      what: "Deployments",
      free: "Not available",
      plan: "Builds by the second, app requests, CPU time and custom domains, each from the first at cost plus 20%",
    },
    {
      what: "Semantic search",
      free: "After a card check, from the trial",
      plan: "From the plan's included usage, then at cost plus 20%",
    },
    {
      what: "Private storage",
      free: `${gigabytes(tier.freePrivateStorageBytes)}, never charged. Past it, pushes to private repositories stop until you make room or start the plan.`,
      plan: `${gigabytes(tier.freePrivateStorageBytes)} free, then at cost plus 20%. Pushes never stop.`,
      note: "Public repository storage is free, with a 5 GB limit per workspace on every plan.",
    },
    {
      what: "Git operations",
      free: `${count(tier.gitOperationsIncluded)} a month, never charged. Past it, slowed to 60 an hour until the month turns.`,
      plan: `${count(tier.gitOperationsIncluded)} a month free, then at cost plus 20%. Never slowed.`,
      note: "Clones, fetches and pushes through g1t.",
    },
    {
      what: "Actions cache",
      free: "2 GiB an entry and 10 GiB a repository, never charged",
      plan: "The same limits, with what it stores at cost plus 20%",
    },
    {
      what: "Audit log",
      free: `${tier.auditRetentionDays} days, with export`,
      plan: `${tier.planAuditRetentionDays} days, with export`,
      note: "Longer by arrangement. Older entries are deleted each day.",
    },
    {
      what: "Single sign-on",
      free: "Not available",
      plan: "Included, at no extra price",
      note: "Your identity provider over SAML 2.0, OpenID Connect or OAuth 2.0, requiring it of members, and SCIM provisioning.",
    },
    {
      what: "Secret scanning, push protection, vulnerability alerts, security updates",
      free: "Included",
      plan: "Included",
      note: "Custom patterns, validity checks, code scanning, dependency review and the security overview on private repositories come with the plan, with no price of their own: their scans are charged at cost plus 20%. On public repositories they are free.",
    },
    { what: "Single sign-on", free: "On every plan, once it is built", plan: "On every plan, once it is built" },
    {
      what: "Members",
      free: "Only the people already in it: a free workspace cannot add members, invite people or invite outside collaborators",
      plan: "Unlimited, never per seat",
      note: "Each person can own one free workspace. More workspaces need the plan.",
    },
    {
      what: "Usage past what is included",
      free: "Not possible: a free workspace never runs up a bill",
      plan: "Priced from cost plus 20%, up to a spend limit you set. No quotas: only your limit stops anything.",
    },
  ];
}

export default function Pricing({ loaderData }: Route.ComponentProps) {
  const { book, unpriced, free } = loaderData;
  const checked = book?.prices
    .map((p) => p.checkedAt)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
  const given = Object.fromEntries(Object.entries(book?.free ?? {}).filter(([, value]) => value != null));
  const tier: Required<FreeTier> = { ...DEFAULT_FREE, ...given };
  const plan = book?.plans?.find((p) => p.feature === "plan") ?? DEFAULT_PLAN;
  const price = plan.monthlyCents / 100;
  const dollars = wholeDollars;
  // What g1t's own metered work is marked up, from the price book: one figure today.
  const runMarkups = (book?.prices ?? [])
    .filter((p) => !SHOWN_APART.has(p.meter) && p.meter !== "security_activation" && p.costMicros > 0)
    .map((p) => p.markupPercent);
  const markup = runMarkups.length && Math.min(...runMarkups) === Math.max(...runMarkups) ? `${runMarkups[0]}%` : "20%";
  // Price changes, without the retired agent and model meters.
  const changes = (book?.changes ?? []).filter((change) => !retired(change.meter));
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm font-medium text-accent">Pricing</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">What g1t runs, priced from cost plus {markup}.</h1>
      <p className="mt-3 max-w-2xl text-muted">
        People chatting and the forge are free for everyone. Everything g1t runs is priced from what it costs g1t plus {markup}: runner minutes at a fixed rate
        for each machine, the rest at cost plus {markup}. Your own runners are free, connecting your coding agents costs nothing, and there are no seats. The
        numbers on this page are the live price book g1t charges from. Prices exclude tax, which is added where it applies.
      </p>
      <Card asChild tone="plain" className="mt-6 grid gap-px overflow-hidden bg-line text-sm sm:grid-cols-2 lg:grid-cols-4">
        <ul>
          {[
            ["What g1t runs", `At cost + ${markup}`, "Sandboxes, builds, hosting, storage, search and scans"],
            ["Your own runners", "Free", "Checks and workflows on your hardware"],
            ["Your coding agents", "Free to connect", "Through the MCP server and the API"],
            ["People", "No seats", "Everyone in the workspace at one price"],
          ].map(([what, price, about]) => (
            <li key={what} className="bg-surface px-4 py-3">
              <p className="text-xs text-muted">{what}</p>
              <p className="mt-0.5 font-medium">{price}</p>
              <p className="mt-0.5 text-xs text-faint">{about}</p>
            </li>
          ))}
        </ul>
      </Card>
      {free && (
        <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="font-medium">Free while g1t is being built out.</span>{" "}
          <span className="text-muted">Usage is recorded at these prices but not charged for now. The plan is charged.</span>
        </div>
      )}

      <section className="mt-10 rounded-xl border border-accent/40 bg-surface p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {plan.title}
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium tracking-normal text-accent">Recommended</span>
          </h2>
          <p>
            <span className="text-3xl font-semibold tabular-nums">${price}</span> <span className="text-sm text-muted">a month per workspace</span>
            <span className="block text-right text-xs text-faint">Plus tax where it applies</span>
          </p>
        </div>
        <p className="mt-2 text-sm text-muted">The plan for a team that ships: unlimited members, checks, the merge queue and deployments.</p>
        <p className="mt-3 text-sm text-fg-soft">
          One price for the whole team: a 10-person team pays ${price} a month, not ${price} a person.
        </p>
        <ul className="mt-4 space-y-1.5 text-sm text-muted">
          {plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-accent">
                ✓
              </span>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-faint">{plan.overage}</p>
        <div className="mt-5 grid gap-5 border-t border-line pt-5 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Where the ${price} goes</p>
            <p className="mt-1 text-muted">
              $10 comes back to you as usage: runner minutes, builds and deployments, priced from cost plus 20%, used before anything else. The other $10 pays
              for running g1t, the free forge for everyone, and the people building it.
            </p>
          </div>
          <div>
            <p className="font-medium">No quotas</p>
            <p className="mt-1 text-muted">
              No count of projects, previews, builds, requests or git operations ever stops a workspace on the plan. Past the $10, usage is charged at the same
              prices, and only your spend limit stops it. Unused included usage does not roll over.
            </p>
          </div>
        </div>
        <p className="mt-5 text-sm text-muted">An owner starts the plan from the workspace's Billing page.</p>
      </section>

      <section id="workspace" className="mt-14">
        <h2 className="text-xl font-semibold tracking-tight">Chat, Docs and your coding agents</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          People talking costs g1t very little, so it is included. So is connecting the coding agents you already use.
        </p>
        <Card tone="plain" className="mt-4 overflow-hidden">
          <dl className="divide-y divide-line text-sm">
            {WORKSPACE_CHARGES.map((row) => (
              <div key={row.what} className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
                <dt className="font-medium">
                  {row.what}
                  {row.soon && (
                    <span className="ml-2 inline-block rounded bg-raised px-1.5 py-0.5 text-xs font-normal whitespace-nowrap text-muted">Coming soon</span>
                  )}
                </dt>
                <dd className="text-muted">{row.how}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Free and the plan, side by side</h2>
      <p className="mt-1 text-sm text-muted">Secret scanning, push protection, vulnerability alerts and security updates are free everywhere, on every plan.</p>
      {/* On a phone, one row at a time with both answers under it; a table that wide would scroll. */}
      <Card asChild tone="plain" divided className="mt-4 text-sm sm:hidden">
        <ul>
          {rows(tier).map((row) => (
            <li key={row.what} className="px-4 py-3">
              <p className="font-medium">{row.what}</p>
              {row.note && <p className="text-xs text-faint">{row.note}</p>}
              <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-xs leading-5 text-faint">Free</dt>
                <dd className="text-muted">{row.free}</dd>
                <dt className="text-xs leading-5 text-faint">{plan.title}</dt>
                <dd className="text-muted">{row.plan}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </Card>
      <Card tone="plain" className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-xl text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">
                <span className="sr-only">What</span>
              </th>
              <th className="px-4 py-2.5 font-medium">Free</th>
              <th className="px-4 py-2.5 font-medium">
                {plan.title}, ${price} a month
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows(tier).map((row) => (
              <tr key={row.what} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-medium">{row.what}</p>
                  {row.note && <p className="text-xs text-faint">{row.note}</p>}
                </td>
                <td className="px-4 py-3 text-muted">{row.free}</td>
                <td className="px-4 py-3 text-muted">{row.plan}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="mt-3 text-sm text-muted">
        Git operations cost g1t money too: Cloudflare charges g1t $0.15 per 1,000. {count(tier.gitOperationsIncluded)} a month is far more than an active
        workspace uses.
      </p>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">No card, no compute</h2>
      <div className="mt-3 max-w-3xl space-y-3 text-sm text-muted">
        <p>Checks, workflows, the merge queue, deployments and semantic search run on g1t's machines. They need the plan, or a card check.</p>
        <p>
          The reason: compute costs g1t real money from the first second, and free compute draws people who use it to mine cryptocurrency. A card check is the
          smallest gate that stops that, with one trial per card.
        </p>
        <p>
          A card check is never charged. Stripe saves and verifies the card, with 3-D Secure where your bank asks for it. Nothing is charged until an owner
          starts the plan, and then the same card is used, without asking for it again. The trial needs a credit or debit card; prepaid cards can still pay for
          the plan.
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card asChild className="p-5">
          <section>
            <h3 className="font-medium">The trial</h3>
            <p className="mt-1.5 text-sm text-muted">
              {dollars(tier.trialWorkspaceMicros)} of usage, once per workspace and once per card, after a card check with a credit or debit card. It comes from
              a {dollars(tier.trialMonthlyPoolMicros)} pool each month for everyone; when a month's pool is given out, new trials wait until the 1st. The trial
              does not cover deployments and never turns into a charge. If the last run on a trial goes past it, g1t covers the difference.
            </p>
          </section>
        </Card>
        <Card asChild className="p-5">
          <section>
            <h3 className="font-medium">The open-source pool</h3>
            <p className="mt-1.5 text-sm text-muted">
              Checks, workflows and the merge queue on public repositories, after a card check: {dollars(tier.ossPoolMicros)} a month in all, up to{" "}
              {dollars(tier.ossRepoMicros)} a month per repository. When the pool or a repository's share is used up, the work waits for the month to turn, or
              the workspace pays as usual.
            </p>
          </section>
        </Card>
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Limits, and how to raise them</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">g1t lets usage run ahead of payment only so far. Limits keep a mistake small, for you and for g1t.</p>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">{dollars(tier.paidStartCeilingMicros)} in the first month</p>
            <p className="mt-1 text-muted">
              A workspace on the plan can use up to {dollars(tier.paidStartCeilingMicros)} in its first month. After that, the limit grows with payments that
              clear.
            </p>
          </li>
        </Card>
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">Your own spend limit</p>
            <p className="mt-1 text-muted">
              Owners set a monthly spend limit anywhere up to the highest limit the workspace has had, with no approval. Once, you can raise it yourself to
              twice that.
            </p>
          </li>
        </Card>
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">Prepay to raise it now</p>
            <p className="mt-1 text-muted">
              Prepaying from $25 raises what you can use by the same amount, at once. From $1,000 you can also pay by bank transfer.
            </p>
          </li>
        </Card>
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">Raise my limit</p>
            <p className="mt-1 text-muted">
              Need more? Ask from Billing with the amount, why, and what you expect to spend. You get an answer within one business day, in the app and by
              email.
            </p>
          </li>
        </Card>
      </ul>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">When usage runs high</h2>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">A spike pauses new work</p>
            <p className="mt-1 text-muted">
              When an hour's spend is five times your usual hour, and at least $5, new compute waits for an owner to choose Keep going or Stop. Runs already
              going finish.
            </p>
          </li>
        </Card>
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">Alerts at 50, 75, 90 and 100%</p>
            <p className="mt-1 text-muted">Of the plan's included usage, your spend limit and g1t's limit: in the app and by email.</p>
          </li>
        </Card>
        <Card asChild className="p-4">
          <li>
            <p className="font-medium">Spent more than you meant to? Tell us</p>
            <p className="mt-1 text-muted">
              Tell us from Billing what happened. Once in 12 months, g1t can credit back usage you did not mean, always including its 20% on it. Larger credits,
              or a second one within 12 months, are reviewed by a person.
            </p>
          </li>
        </Card>
      </ul>
      <p className="mt-3 text-sm text-muted">
        No card is charged less than {dollars(tier.minChargeMicros)} when a month closes, so a payment's fee is never most of it. Smaller amounts carry over to
        the next invoice. Charges at a limit always go through.
      </p>

      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        {HOW.map((item) => (
          <Card asChild key={item.title} className="p-5">
            <section>
              <h2 className="font-medium">{item.title}</h2>
              <p className="mt-1.5 text-sm text-muted">{item.body}</p>
            </section>
          </Card>
        ))}
      </div>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Usage</h2>
      <p className="mt-1 text-sm text-muted">
        {checked ? (
          <>
            Last checked against Cloudflare's bill <TimeAgo at={checked} />.
          </>
        ) : (
          "Starting from Cloudflare's published prices; checked against its bill daily."
        )}
      </p>
      <Card tone="plain" className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm sm:min-w-xl">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">What</th>
              <th className="px-4 py-2.5 font-medium">Costs g1t</th>
              {/* The markup is in what you pay; on a phone the column gives way. */}
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Markup</th>
              <th className="px-4 py-2.5 font-medium">You pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {machines().map((instance) => (
              <tr key={instance.machine}>
                <td className="px-4 py-3">
                  <p className="font-medium">Runner minutes, {instance.label === "standard" ? "standard machine" : instance.label}</p>
                  <p className="text-xs text-faint">{machineSize(instance)}. Each job's time rounded up to the minute; checks, workflows and the merge queue</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">Up to {money(busyMinuteMicros(instance))} a minute</td>
                <td className="hidden px-4 py-3 tabular-nums sm:table-cell">Fixed rate</td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums">{money(instance.microsPerMinute)} a minute</td>
              </tr>
            ))}
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Your own runners</p>
                <p className="text-xs text-faint">Checks, workflows and the merge queue on your own hardware</p>
              </td>
              <td className="px-4 py-3 text-muted">Nothing</td>
              <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
              <td className="px-4 py-3 text-muted">Free</td>
            </tr>
            <tr>
              <td className="px-4 py-3">
                <p className="font-medium">Projects, previews and apps</p>
                <p className="text-xs text-faint">Having them. An app's requests and CPU time are charged below.</p>
              </td>
              <td className="px-4 py-3 text-muted">Next to nothing</td>
              <td className="hidden px-4 py-3 tabular-nums sm:table-cell">—</td>
              <td className="px-4 py-3 text-muted">Not charged</td>
            </tr>
            {unpriced && (
              <tr>
                <td colSpan={4} className="px-4 py-3">
                  <Unavailable what="The metered prices" compact />
                </td>
              </tr>
            )}
            {(book?.prices ?? [])
              .filter((price) => !SHOWN_APART.has(price.meter))
              .map((price) => (
                <tr key={price.meter}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{price.title}</p>
                    <p className="text-xs text-faint">
                      {price.meter === "actions_cache" ? "On the plan only. A free workspace is never charged for it. " : ""}
                      {price.source === "cloudflare" ? "Measured from Cloudflare's bill" : "Cloudflare's published price"}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">{perUnit(price, price.costMicros)}</td>
                  <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{price.markupPercent}%</td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums">{perUnit(price, price.priceMicros)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Enterprise</h2>
      <p className="mt-1 text-sm text-muted">For organizations with several workspaces: one invoice and one limit. The prices are the ones on this page.</p>
      <Card asChild className="mt-4 p-5">
        <section>
          <ul className="grid gap-3 text-sm sm:grid-cols-2">
            <li>
              <p className="font-medium">Consolidated invoicing</p>
              <p className="text-muted">One monthly invoice for every workspace, paid by card or bank transfer.</p>
            </li>
            <li>
              <p className="font-medium">Custom terms</p>
              <p className="text-muted">One limit across every workspace, invoice terms and a billing contact, set with you.</p>
            </li>
            <li>
              <p className="font-medium">Security on every plan</p>
              <p className="text-muted">
                The audit log with export, {tier.planAuditRetentionDays} days or longer by arrangement, and secret push protection, for every workspace.
              </p>
            </li>
            <li>
              <p className="font-medium">
                Single sign-on <span className="ml-1 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">Coming</span>
              </p>
              <p className="text-muted">Through your identity provider, on every plan once it is built. Not available yet.</p>
            </li>
          </ul>
          <a
            href={ENTERPRISE_MAIL}
            className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong"
          >
            Write to us about enterprise
            <ArrowUpRight size={14} />
          </a>
        </section>
      </Card>

      <h2 className="mt-14 text-xl font-semibold tracking-tight">Price changes</h2>
      {book && changes.length > 0 ? (
        <Card asChild tone="plain" divided className="mt-4">
          <ul>
            {changes.map((change) => {
              const title = book.prices.find((p) => p.meter === change.meter)?.title ?? change.meter;
              // What you pay moved: the cost, the markup, or both.
              const before = change.oldCostMicros * (100 + (change.oldMarkupPercent ?? change.markupPercent));
              const after = change.newCostMicros * (100 + change.markupPercent);
              const up = after > before;
              const fresh = after === before || before === 0;
              return (
                <li key={`${change.meter}-${change.createdAt}`} className="px-4 py-3 text-sm">
                  <p>
                    <span className="font-medium">{title}</span>{" "}
                    {fresh ? (
                      <span className="text-muted">new</span>
                    ) : (
                      <span className={up ? "text-warn" : "text-accent"}>
                        {up ? "up" : "down"} {Math.abs((after / before - 1) * 100).toFixed(1)}%
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {change.effectiveAt ? (
                      <>
                        {change.reason} · <span className="text-fg-soft">takes effect {change.effectiveAt.slice(0, 10)}</span>
                      </>
                    ) : (
                      <>
                        {change.reason} · <TimeAgo at={change.createdAt} />
                      </>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : unpriced ? (
        <div className="mt-4">
          <Unavailable what="Price changes" />
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">None yet. When a price moves, it is listed here with why.</p>
      )}

      <h2 id="faq" className="mt-14 text-xl font-semibold tracking-tight">
        Questions
      </h2>
      <Card asChild tone="plain" divided className="mt-4">
        <dl>
          {FAQ.map((item) => (
            <div key={item.q} className="px-4 py-4 text-sm">
              <dt className="font-medium">{item.q}</dt>
              <dd className="mt-1.5 text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <a href="https://docs.g1t.sh/guides/usage-and-billing/" className="mt-12 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
        How usage and billing work
        <ArrowUpRight size={14} />
      </a>
    </main>
  );
}
