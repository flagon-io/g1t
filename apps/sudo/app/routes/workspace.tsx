import { ArrowLeft, Building2, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { data, Link, useLocation } from "react-router";

import { type AccountSummary, type AdminAction, type Entitlements, type Limit, type Overage, type Terms, httpStatus } from "@g1t/contracts";

import type { Route } from "./+types/workspace";
import {
  AllowancesForm,
  AuditSection,
  BillingLinkSection,
  CreditForm,
  Figure,
  LedgerSection,
  Owners,
  PaymentForm,
  ReviewPanel,
  TermsForm,
} from "~/components/billing";
import { MonthsChart } from "~/components/charts";
import { SalesSection, StageBadge, WorkspaceInvoicesSection } from "~/components/sales";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ExposureBar,
  Field,
  Input,
  Notice,
  Section,
  Select,
  StateBadge,
  TermsBadge,
  Textarea,
  TrustBadge,
  When,
  trustAbout,
} from "~/components/ui";
import { type Subject, billingAction } from "~/lib/billing-actions.server";
import { parseSlug, text } from "~/lib/forms";
import { usd } from "~/lib/money";
import { type ActionData, DONE, type SectionError, doneKey } from "~/lib/review";
import { SALES_INTENTS, salesAction } from "~/lib/sales-actions.server";
import { goodwillWarning, spikeLabel } from "~/lib/pricing";
import { admin, entitlements as entitlementsOf, identity, priceBook } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import type { Enterprise } from "~/lib/workspaces";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.name ?? "Workspace"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

/** Whether an audit line is about `slug`, in an enterprise's log. */
function mentions(action: AdminAction, slug: string): boolean {
  // A slug is letters, digits and hyphens, none special in a pattern.
  return new RegExp(`(^|[^a-z0-9-])${slug}($|[^a-z0-9-])`).test(action.detail.toLowerCase());
}

async function load(raw: string) {
  const parsed = parseSlug(raw);
  if (!parsed.ok) throw data("That is not a workspace slug.", { status: 404 });
  const slug = parsed.value;
  const [person, result] = await Promise.all([identity.workspace(slug), admin.account(slug)]);
  if (!result.ok) throw data(result.error.message, { status: httpStatus(result.error) });
  const detail = result.value;
  const { account } = detail.summary;
  const billedTo: Enterprise | null = account.kind === "enterprise" ? { id: account.id, name: account.name } : null;
  const known = person != null || billedTo != null || account.createdAt !== "" || detail.ledger.length > 0 || detail.audit.length > 0;
  if (!known) throw data(`There is no workspace called ${slug}.`, { status: 404 });
  const subject: Subject = { kind: "workspace", slug, accountId: account.id, terms: account.terms, billedTo };
  return { slug, person, detail, billedTo, subject };
}

/** Sales and invoices are newer billing methods; a page still opens without them. */
const SALES_DONE = new Set(["sales", "note"]);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  const { slug, person, detail, billedTo, subject } = await load(params.slug);
  const { summary } = detail;
  // On an enterprise, the limit is the enterprise's and the figures are
  // this workspace's share of its bill.
  const limit = (billedTo && detail.workspaces.find((member) => member.workspace === slug)) || summary.limit;
  const share = billedTo ? summary.byWorkspace?.find((row) => row.workspace === slug) : null;
  const figures = billedTo
    ? { charged: share?.chargedMicros ?? 0, cost: share?.costMicros ?? 0, paid: share?.paidMicros ?? 0 }
    : { charged: summary.chargedMicros, cost: summary.costMicros, paid: summary.paidMicros };
  const [enterprises, sales, invoices, plan, overages, book] = await Promise.all([
    billedTo
      ? Promise.resolve([])
      : admin
          .accounts()
          .then((rows: AccountSummary[]) =>
            rows
              .filter((row) => row.account.kind === "enterprise")
              .map((row) => ({ id: row.account.id, name: row.account.name, members: row.account.workspaces.length })),
          ),
    settle(admin.sales(slug)),
    settle(admin.workspaceInvoices(slug)),
    settle(entitlementsOf(slug)),
    settle(admin.overages()),
    settle(priceBook()),
  ]);
  const done = doneKey(request.url);
  return {
    me: staff.email,
    slug,
    name: person?.name ?? slug,
    person,
    billedTo,
    terms: subject.terms,
    allowances: summary.account.allowances,
    limit,
    figures,
    months: summary.months ?? [],
    enterprises,
    sales: sales.ok ? sales.value : null,
    salesError: sales.ok ? null : sales.error,
    invoices: invoices.ok ? invoices.value : [],
    invoicesError: invoices.ok ? null : invoices.error,
    entitlements: plan.ok ? plan.value : null,
    entitlementsError: plan.ok ? null : plan.error,
    overage: overages.ok ? (overages.value.find((row) => row.workspace === slug) ?? null) : null,
    forgiveCap: (book.ok && book.value.free?.overageForgiveCostMicros) || 50_000_000,
    ledger: billedTo ? detail.ledger.filter((entry) => !entry.workspace || entry.workspace === slug) : detail.ledger,
    audit: billedTo ? detail.audit.filter((entry) => mentions(entry, slug)) : detail.audit,
    done: done && !SALES_DONE.has(done) ? DONE[done] : null,
    salesDone: done && SALES_DONE.has(done) ? DONE[done] : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // What is acted on comes from billing and identity, not from the form.
  const { slug, subject } = await load(params.slug);
  const path = `/workspaces/${encodeURIComponent(slug)}`;
  const form = await request.clone().formData();
  if (SALES_INTENTS.has(text(form, "intent"))) return salesAction(form, staff, slug, path);
  return billingAction(request, staff, subject, path);
}

const SECTIONS = [
  { id: "members", label: "Members" },
  { id: "sales", label: "Sales" },
  { id: "plan", label: "Plan" },
  { id: "billing", label: "Billing" },
  { id: "invoices", label: "Invoices" },
  { id: "ledger", label: "Ledger" },
  { id: "audit", label: "Audit log" },
];

export default function Workspace({ loaderData, actionData }: Route.ComponentProps) {
  const {
    me,
    slug,
    name,
    person,
    billedTo,
    terms,
    allowances,
    limit,
    figures,
    months,
    enterprises,
    sales,
    salesError,
    invoices,
    invoicesError,
    entitlements,
    entitlementsError,
    overage,
    forgiveCap,
    ledger,
    audit,
    done,
    salesDone,
  } = loaderData;
  const { pathname } = useLocation();
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const link = result && "link" in result ? result.link : null;
  const error = (section: string): SectionError => (result && "error" in result && result.section === section ? result : null);
  const owners = person?.members.filter((member) => member.role === "owner") ?? [];

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <Link to="/workspaces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Workspaces
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={slug} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-0.5 text-xs text-faint">
              <span className="font-mono">{slug}</span>
              {person && (
                <>
                  {" · "}created <When at={person.createdAt} />
                </>
              )}
            </p>
            {person?.description && <p className="mt-1 text-sm text-muted">{person.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {billedTo && <Badge tone="lavender">Billed to {billedTo.name}</Badge>}
              <TermsBadge terms={terms} />
              {terms.kind !== "comped" && <TrustBadge trust={limit.trust} />}
              <StateBadge state={limit.state} />
              {sales && sales.stage !== "none" && <StageBadge stage={sales.stage} />}
            </div>
          </div>
        </div>
        {owners.length > 0 && (
          <div className="text-xs">
            <p className="mb-1.5 text-faint">Owners</p>
            <Owners owners={owners} />
          </div>
        )}
      </div>

      <nav aria-label="On this page" className="mt-6 -mx-4 overflow-x-auto px-4">
        <ul className="flex gap-1 border-b border-line text-sm">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="block border-b-2 border-transparent px-2.5 py-2 whitespace-nowrap text-muted transition-colors hover:border-line-strong hover:text-fg">
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-6 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error("top") && <Notice tone="error">{error("top")?.error}</Notice>}
        {limit.message && <Notice tone={limit.state === "stopped" ? "error" : limit.state === "warning" ? "warn" : "info"}>{limit.message}</Notice>}
        {review && <ReviewPanel review={review} pathname={pathname} />}
      </div>

      {/* People */}
      <Section id="members" title="Members" description="Everyone in the workspace. Owners manage its members and billing." className="mt-6">
        {!person ? (
          <Notice tone="warn">Identity has no record of {slug}; only billing knows it. It may have been deleted.</Notice>
        ) : person.members.length === 0 ? (
          <EmptyState title="No members" />
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
            <table className="w-full min-w-120 text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:pl-5">Member</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium sm:pr-5">Joined</th>
                </tr>
              </thead>
              <tbody>
                {person.members.map((member) => (
                  <tr key={member.username} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 sm:pl-5">
                      <span className="inline-flex items-center gap-2 font-mono">
                        <Avatar name={member.username} size={18} square={false} />
                        <Link to={`/users/${member.username}`} className="hover:underline">
                          {member.username}
                        </Link>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 break-all text-muted">{member.email ?? <span className="text-faint">—</span>}</td>
                    <td className="px-4 py-2.5">{member.role === "owner" ? <Badge tone="lavender">Owner</Badge> : <Badge>Member</Badge>}</td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pr-5">
                      <When at={member.joined} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Sales */}
      <div className="mt-6">
        <SalesSection
          sales={sales}
          unavailable={salesError}
          me={me}
          pathname={pathname}
          salesError={error("sales")}
          noteError={error("note")}
          done={salesDone}
        />
      </div>

      {/* Plan */}
      <div className="mt-6">
        <PlanSection entitlements={entitlements} unavailable={entitlementsError} />
      </div>

      {/* Billing */}
      <h2 id="billing" className="mt-10 scroll-mt-20 text-lg font-semibold tracking-tight">
        Billing
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <LimitCard limit={limit} terms={terms} billedTo={billedTo} />
        <Figure label="Charged this month" value={usd(figures.charged)} hint={`Cost to g1t ${usd(figures.cost)}`} />
        <Figure label="Paid ever" value={usd(figures.paid)} hint={`Margin this month ${usd(figures.charged - figures.cost)}`} />
      </div>

      <Section
        title="Last six months"
        description={billedTo ? `${billedTo.name}'s figures: every workspace it pays for, together.` : "What it was charged, against what its usage cost g1t."}
        className="mt-6"
      >
        <MonthsChart wide months={months} label={`${billedTo ? billedTo.name : name}: charged and cost by month`} />
      </Section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <BilledToSection billedTo={billedTo} enterprises={enterprises} pathname={pathname} error={error("billed-to")} />
          {billedTo ? (
            <Section id="terms" title="Terms" description={`Charged on ${billedTo.name}'s terms while it pays for this workspace.`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TermsBadge terms={terms} />
                <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}#terms`} className="text-sm text-merged hover:underline hover:underline-offset-4">
                  Change them on {billedTo.name}
                </Link>
              </div>
            </Section>
          ) : (
            <>
              <TermsForm terms={terms} pathname={pathname} error={error("terms")} />
              <AllowancesForm allowances={allowances} comped={terms.kind === "comped"} pathname={pathname} error={error("allowances")} />
            </>
          )}
          <WorkspaceInvoicesSection invoices={invoices} unavailable={invoicesError} />
          <div id="ledger" className="scroll-mt-20">
            <LedgerSection
              ledger={ledger}
              description={billedTo ? `This workspace's lines among ${billedTo.name}'s latest 100.` : "Recent lines of the statement, newest first."}
            />
          </div>
        </div>

        <div className="space-y-6">
          <BillingLinkSection link={link} pathname={pathname} error={error("billing-link")} />
          {!billedTo && terms.kind !== "comped" && (
            <GoodwillForm overage={overage} cap={forgiveCap} pathname={pathname} error={error("goodwill")} />
          )}
          <PaymentForm workspace={slug} pathname={pathname} error={error("payment")} />
          <CreditForm workspaces={[slug]} pathname={pathname} error={error("credit")} />
          <div id="audit" className="scroll-mt-20">
            <AuditSection
              audit={audit}
              description={
                billedTo ? (
                  <>
                    Changes about this workspace in {billedTo.name}'s log.{" "}
                    <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}`} className="text-merged hover:underline">
                      Full log
                    </Link>
                  </>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The limit, and in words how it is made: trust, the owners' own spend
 * limit (or the default), the most they may set, and how it grows.
 */
function LimitCard({ limit, terms, billedTo }: { limit: Limit; terms: Terms; billedTo: Enterprise | null }) {
  const lines: { label: string; value: ReactNode }[] = [];
  if (billedTo) {
    lines.push({ label: "Limit", value: <>{billedTo.name}'s, shared by every workspace it pays for</> });
  } else if (terms.kind !== "comped") {
    lines.push({ label: "From trust", value: <>{usd(limit.trustCeilingMicros)}. {trustAbout(limit.trust)}</> });
  }
  if (terms.ceilingMicros != null) lines.push({ label: "Custom limit", value: usd(terms.ceilingMicros) });
  if (!billedTo && terms.kind !== "comped") {
    lines.push({
      label: "Owners' limit",
      value: limit.defaultSpendLimit ? (
        <>The default, {usd(limit.spendLimitMicros ?? 200_000_000)} a month: they have not chosen one</>
      ) : limit.spendLimitMicros == null ? (
        "None of their own: they use everything available"
      ) : (
        <>{usd(limit.spendLimitMicros)} a month, chosen by the owners</>
      ),
    });
    if (limit.availableMicros !== undefined) {
      lines.push({
        label: "Available",
        value:
          limit.availableMicros == null ? (
            "No ceiling"
          ) : (
            <>Up to {usd(limit.availableMicros)}: the most owners may set; past it, they contact g1t</>
          ),
      });
    }
  }
  if (limit.growth) lines.push({ label: "Grows", value: limit.growth });

  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:col-span-2">
      <p className="mb-2 text-xs text-muted">
        Usage this month against the limit{billedTo && <> · shared with every workspace {billedTo.name} pays for</>}
      </p>
      <ExposureBar limit={limit} wide />
      {lines.length > 0 && (
        <dl className="mt-3 space-y-1 text-xs">
          {lines.map((line) => (
            <div key={line.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-faint">{line.label}</dt>
              <dd className="text-fg-soft">{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function BilledToSection({
  billedTo,
  enterprises,
  pathname,
  error,
}: {
  billedTo: Enterprise | null;
  enterprises: { id: string; name: string; members: number }[];
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section id="billed-to" title="Billed to" description="Whether the workspace pays for itself, or an enterprise pays for it.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {billedTo ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            <Link to={`/enterprises/${encodeURIComponent(billedTo.id)}`} className="font-medium text-fg hover:underline hover:underline-offset-4">
              {billedTo.name}
            </Link>{" "}
            pays for it, under its limit and terms.
          </p>
          <form method="post" action={`${pathname}#review`}>
            <input type="hidden" name="intent" value="detach" />
            <Button type="submit" variant="danger">
              <LogOut size={14} />
              Move off
            </Button>
          </form>
        </div>
      ) : enterprises.length === 0 ? (
        <p className="text-sm text-muted">
          Itself. There are no enterprises to move it onto yet;{" "}
          <Link to="/enterprises/new" className="text-merged hover:underline hover:underline-offset-4">
            create one
          </Link>
          .
        </p>
      ) : (
        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="attach" />
          <Field label="Itself. Move onto" className="grow">
            <Select name="target" required defaultValue={error?.values?.target ?? ""}>
              <option value="" disabled>
                Choose an enterprise
              </option>
              {enterprises.map((enterprise) => (
                <option key={enterprise.id} value={enterprise.id}>
                  {enterprise.name} ({enterprise.members} workspace{enterprise.members === 1 ? "" : "s"})
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="quiet">
            <Building2 size={14} />
            Move
          </Button>
        </form>
      )}
    </Section>
  );
}

const PLAN_LABEL: Record<string, string> = { free: "Free", paid: "The g1t plan", internal: "Internal (comped)", enterprise: "Enterprise" };

function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1e9) * 100) / 100} GB`;
}

/** What billing tells every service about the workspace now: plan, caps, pause, trial and what the plan gives it. */
function PlanSection({ entitlements: e, unavailable }: { entitlements: Entitlements | null; unavailable: string | null }) {
  if (!e) {
    return (
      <Section id="plan" title="Plan and entitlements">
        <Notice tone="warn">Billing did not answer for entitlements{unavailable ? `: ${unavailable}` : "."}</Notice>
      </Section>
    );
  }
  const spike = e.spike ? spikeLabel(e.spike.status) : null;
  const facts: [string, string][] = [
    ["Compute", e.compute ? "Yes" : e.plan === "free" && e.trialVerified && e.trialMicrosLeft > 0 ? "On the trial" : "No"],
    ["Card check", e.trialVerified ? "Done" : "Not yet"],
    ["Trial left", usd(e.trialMicrosLeft)],
    ["First month", e.firstMonth ? "Yes" : "No"],
    ["Agents at once", String(e.maxConcurrentAgents)],
    ["Longest run", e.maxRunMinutes ? `${e.maxRunMinutes} min` : "The guardrails'"],
    ["Run cap", usd(e.runCapMicros)],
    ["Issue cap", usd(e.issueCapMicros)],
    ["Ceiling", e.ceilingMicros >= 1e15 ? "None" : usd(e.ceilingMicros)],
    ["Not yet paid", usd(e.exposureMicros)],
    ["Held by reservations", usd(e.heldMicros ?? 0)],
    ["Prepaid", usd(e.prepaidMicros ?? 0)],
    ["Included usage", e.includedMicros ? `${usd(e.includedUsedMicros ?? 0)} of ${usd(e.includedMicros)}` : "—"],
    ["Private storage", `${gigabytes(e.privateStorageBytes)} of ${gigabytes(e.freePrivateStorageBytes)}`],
    ["Open-source pool paid", usd(e.ossPaidMicros)],
    ["Build minutes", `${Math.ceil(e.buildSecondsUsed / 60)} of ${Math.floor(e.buildSecondsIncluded / 60)}`],
    [
      "Git operations",
      e.gitOperations != null
        ? `${e.gitOperations.toLocaleString("en-US")}${e.gitOperationsIncluded ? ` of ${e.gitOperationsIncluded.toLocaleString("en-US")}` : ""}`
        : "—",
    ],
    ["Audit log", `${e.auditRetentionDays} days`],
  ];
  return (
    <Section
      id="plan"
      title="Plan and entitlements"
      description="What billing tells every service that starts compute for this workspace, now."
      actions={
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={e.plan === "free" ? "plain" : e.plan === "internal" ? "mint" : "lavender"}>{PLAN_LABEL[e.plan] ?? e.plan}</Badge>
          {spike && <Badge tone={spike.tone === "plain" ? "plain" : spike.tone}>{spike.label}</Badge>}
        </span>
      }
    >
      {e.paused && (
        <div className="mb-4">
          <Notice tone="error">Compute paused: {e.paused}</Notice>
        </div>
      )}
      {(e.alerts ?? []).length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {(e.alerts ?? []).map((alert) => (
            <li key={`${alert.meter}-${alert.level}`} className={alert.level >= 90 ? "text-warn" : "text-muted"}>
              {alert.level}% · {alert.message || `${alert.meter}: ${usd(alert.usedMicros)} of ${usd(alert.limitMicros)}`}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-faint">{label}</dt>
            <dd className="tabular text-right text-fg-soft">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-faint">Agents at once, the run and issue caps, and holds are set under Plan, pools and caps below.</p>
    </Section>
  );
}

/** A goodwill credit from the workspace's page; Overages shows the same math for the whole queue. */
function GoodwillForm({ overage, cap, pathname, error }: { overage: Overage | null; cap: number; pathname: string; error: SectionError }) {
  const values = error?.values;
  const quote = overage ? goodwillWarning(null, overage.goodwill, overage.lastGoodwillAt, cap) : null;
  return (
    <Section id="goodwill" title="Goodwill credit" description="For usage past what the owners meant. One click, once in 12 months; more needs a reason.">
      {overage ? (
        <dl className="mb-4 space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Over the typical month</dt>
            <dd className="tabular">{usd(overage.goodwill.overageMicros)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">g1t's margin, returned</dt>
            <dd className="tabular text-accent">{usd(overage.goodwill.marginMicros)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Real cost absorbed</dt>
            <dd className={`tabular ${quote?.overCap ? "text-danger" : "text-warn"}`}>{usd(overage.goodwill.absorbedMicros)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-line pt-1 font-medium">
            <dt>One-click credit</dt>
            <dd className="tabular">{usd(overage.goodwill.creditMicros)}</dd>
          </div>
          {!overage.goodwillAvailable && (
            <p className="pt-1 text-xs text-danger">
              A goodwill credit was given <When at={overage.lastGoodwillAt} />: another needs a reason.
            </p>
          )}
        </dl>
      ) : (
        <p className="mb-4 text-sm text-muted">Not in the Overages queue this month: give an amount and a reason.</p>
      )}
      <form method="post" action={`${pathname}#goodwill`} className="space-y-3">
        <input type="hidden" name="intent" value="goodwill" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount $" hint={overage ? "Blank: the one-click credit." : "Required here."}>
            <Input name="amount" inputMode="decimal" defaultValue={values?.amount ?? ""} />
          </Field>
          <Field label="Day of the usage" hint="Blank: billing chooses.">
            <Input type="date" name="day" defaultValue={values?.day ?? ""} />
          </Field>
        </div>
        <Field label="Reason" hint={`Needed past the one-click credit. Past ${usd(cap)} of real cost, use Overages to see it in red first.`}>
          <Textarea name="reason" rows={2} maxLength={500} defaultValue={values?.reason ?? ""} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="lavender">
            Give goodwill credit
          </Button>
        </div>
      </form>
    </Section>
  );
}
