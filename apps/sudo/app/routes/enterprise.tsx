import { ArrowLeft, ExternalLink, Mail, Plus, Send, Trash2 } from "lucide-react";
import { data, Link, redirect, useLocation } from "react-router";

import { type AdminOwner, type EnterpriseInvoice, type Limit, httpStatus } from "@g1t/contracts";

import type { Route } from "./+types/enterprise";
import { AllowancesForm, AuditSection, CreditForm, CreditList, Figure, LedgerSection, ReviewPanel, TermsForm } from "~/components/billing";
import { Avatar, Badge, Button, EmptyState, ExposureBar, Field, Input, Notice, Section, StateBadge, TermsBadge, TrustBadge, When } from "~/components/ui";
import { type Subject, billingAction } from "~/lib/billing-actions.server";
import { usd } from "~/lib/money";
import { type ActionData, type SectionError, doneMessage } from "~/lib/review";
import { admin, identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import { fullDiscount } from "~/lib/terms";
import { legacyAccountPath } from "~/lib/workspaces";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.detail.summary.account.name ?? "Enterprise"} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

const ENTERPRISE_ID = /^ent_[a-z0-9_-]{1,80}$/;

async function load(raw: string) {
  const id = raw.trim().toLowerCase();
  if (!ENTERPRISE_ID.test(id)) {
    // A workspace's id or slug: its own page.
    const path = legacyAccountPath(id);
    if (path) throw redirect(path);
    throw data("That is not an enterprise.", { status: 404 });
  }
  const result = await admin.account(id);
  if (!result.ok) throw data(result.error.message, { status: httpStatus(result.error) });
  const detail = result.value;
  const { account } = detail.summary;
  if (account.kind !== "enterprise") throw data("That is not an enterprise.", { status: 404 });
  const subject: Subject = {
    kind: "enterprise",
    accountId: account.id,
    name: account.name,
    terms: account.terms,
    workspaces: account.workspaces,
    billingEmail: account.billingEmail ?? null,
  };
  return { detail, subject };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  requireStaff(context);
  const { detail } = await load(params.id);
  const slugs = detail.summary.account.workspaces;
  const listed = await identity.workspaces();
  const people = new Map(listed.map((workspace) => [workspace.slug, { name: workspace.name, owners: workspace.owners }]));
  // Members older than identity's list: look them up one by one.
  const missing = slugs.filter((slug) => !people.has(slug)).slice(0, 25);
  for (const found of await Promise.all(missing.map((slug) => identity.workspace(slug)))) {
    if (found) {
      people.set(found.slug, {
        name: found.name,
        owners: found.members.filter((member) => member.role === "owner").map(({ username, email }) => ({ username, email })),
      });
    }
  }
  const limits = new Map(detail.workspaces.map((limit) => [limit.workspace, limit]));
  const shares = new Map((detail.summary.byWorkspace ?? []).map((share) => [share.workspace, share]));
  const members = slugs.map((slug) => ({
    slug,
    name: people.get(slug)?.name ?? null,
    owners: people.get(slug)?.owners ?? ([] as AdminOwner[]),
    limit: limits.get(slug) ?? null,
    chargedMicros: shares.get(slug)?.chargedMicros ?? 0,
  }));
  const credits = await settle(admin.credits());
  return {
    detail,
    members,
    credits: credits.ok ? credits.value.grants.filter((grant) => slugs.includes(grant.workspace)) : [],
    creditsError: credits.ok ? null : credits.error,
    done: doneMessage(request.url),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // What is acted on comes from billing, not from the form.
  const { subject } = await load(params.id);
  return billingAction(request, staff, subject, `/enterprises/${encodeURIComponent(subject.accountId)}`);
}

type Member = Route.ComponentProps["loaderData"]["members"][number];

export default function Enterprise({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, members, credits, creditsError, done } = loaderData;
  const { summary } = detail;
  const { account, limit } = summary;
  const { pathname } = useLocation();
  const result = actionData as ActionData | undefined;
  const review = result && "review" in result ? result.review : null;
  const sent = result && "invoice" in result ? result.invoice : null;
  const error = (section: string): SectionError => (result && "error" in result && result.section === section ? result : null);

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <Link to="/enterprises" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Enterprises
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={account.name} size={40} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{account.name}</h1>
            <p className="mt-0.5 text-xs text-faint">
              Enterprise since <When at={account.createdAt} /> · pays for {members.length} workspace{members.length === 1 ? "" : "s"}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="lavender">Enterprise</Badge>
              <TermsBadge terms={account.terms} />
              {!fullDiscount(account.terms) && <TrustBadge trust={limit.trust} />}
              <StateBadge state={limit.state} />
            </div>
          </div>
        </div>
        <p className="text-xs text-faint">
          Billing account id <span className="font-mono">{account.id}</span>
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error("top") && <Notice tone="error">{error("top")?.error}</Notice>}
        {limit.message && <Notice tone={limit.state === "stopped" ? "error" : limit.state === "warning" ? "warn" : "info"}>{limit.message}</Notice>}
        {review && <ReviewPanel review={review} pathname={pathname} />}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 sm:col-span-2">
          <p className="mb-2 text-xs text-muted">Usage this month against the limit, all workspaces together</p>
          <ExposureBar limit={limit} wide />
          <p className="mt-2 text-xs text-faint">
            Limit from trust {usd(limit.trustCeilingMicros)}
            {account.terms.ceilingMicros != null && <> · custom limit {usd(account.terms.ceilingMicros)}</>}
          </p>
        </div>
        <Figure label="Charged this month" value={usd(summary.chargedMicros)} hint={`Cost to g1t ${usd(summary.costMicros)}`} />
        <Figure label="Paid ever" value={usd(summary.paidMicros)} hint={`Margin this month ${usd(summary.chargedMicros - summary.costMicros)}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <MembersSection members={members} pathname={pathname} error={error("members")} />
          <InvoicesSection
            email={account.billingEmail ?? null}
            invoices={account.invoices ?? []}
            sent={sent}
            pathname={pathname}
            error={error("invoices")}
          />
          <TermsForm terms={account.terms} pathname={pathname} error={error("terms")} />
          <AllowancesForm
            allowances={account.allowances}
            comped={fullDiscount(account.terms)}
            pathname={pathname}
            error={error("allowances")}
          />
          <LedgerSection ledger={detail.ledger} showWorkspace description="Recent lines for every workspace it pays for, newest first." />
        </div>
        <div className="space-y-6">
          <CreditForm workspaces={account.workspaces} pathname={pathname} error={error("credit")} />
          <Section
            id="credits"
            title="Credits"
            description={`${usd(credits.reduce((sum, grant) => sum + grant.leftMicros, 0), { cents: true })} left to spend across its workspaces.`}
          >
            {creditsError ? (
              <Notice tone="warn">Billing did not answer for credits: {creditsError}</Notice>
            ) : (
              <CreditList grants={credits} pathname={pathname} error={error("credits")} showWorkspace />
            )}
          </Section>
          <AuditSection audit={detail.audit} />
        </div>
      </div>
    </main>
  );
}

function MembersSection({ members, pathname, error }: { members: Member[]; pathname: string; error: SectionError }) {
  return (
    <Section id="members" title="Workspaces" description="Billed together: one bill, one limit, one set of terms.">
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {members.length === 0 ? (
        <EmptyState title="No workspaces yet">Add one below to bill it to this enterprise.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {members.map((member) => (
            <li key={member.slug} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 grow items-start gap-2.5">
                <Avatar name={member.slug} size={22} />
                <div className="min-w-0">
                  <Link to={`/workspaces/${encodeURIComponent(member.slug)}`} className="font-medium hover:underline hover:underline-offset-4">
                    {member.name ?? member.slug}
                  </Link>
                  <p className="truncate text-xs text-faint">
                    <span className="font-mono">{member.slug}</span>
                    {member.owners.length > 0 && (
                      <>
                        {" · "}
                        {member.owners.map((owner, index) => (
                          <span key={owner.username} title={owner.email ?? "No email"}>
                            {index > 0 && ", "}
                            {owner.username}
                          </span>
                        ))}
                      </>
                    )}
                  </p>
                  {member.limit?.message && <p className="mt-1 text-xs text-muted">{member.limit.message}</p>}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 sm:w-56 sm:justify-end">
                <p className="tabular text-right text-xs text-muted">
                  Charged <span className="text-fg-soft">{usd(member.chargedMicros)}</span>
                  {member.limit && <MemberState limit={member.limit} />}
                </p>
                <DetachButton workspace={member.slug} pathname={pathname} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <form method="post" action={`${pathname}#review`} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <input type="hidden" name="intent" value="attach" />
        <Field label="Add a workspace" className="grow">
          <Input name="workspace" required placeholder="workspace-slug" defaultValue={error?.values?.workspace ?? ""} className="font-mono" />
        </Field>
        <Button type="submit" variant="quiet">
          <Plus size={14} />
          Add
        </Button>
      </form>
    </Section>
  );
}

function MemberState({ limit }: { limit: Limit }) {
  if (limit.state === "ok") return null;
  return (
    <span className="mt-1 block">
      <StateBadge state={limit.state} />
    </span>
  );
}

function DetachButton({ workspace, pathname }: { workspace: string; pathname: string }) {
  return (
    <form method="post" action={`${pathname}#review`} className="shrink-0">
      <input type="hidden" name="intent" value="detach" />
      <input type="hidden" name="workspace" value={workspace} />
      <button
        type="submit"
        aria-label={`Remove ${workspace}`}
        title={`Remove ${workspace}`}
        className="rounded-md border border-line p-2 text-muted transition-colors hover:border-danger/50 hover:text-danger"
      >
        <Trash2 size={14} />
      </button>
    </form>
  );
}

// --- Invoices -----------------------------------------------------------------

const INVOICE_STATUS: Record<string, { label: string; tone: "plain" | "mint" | "warn" | "danger" | "info" }> = {
  open: { label: "Open", tone: "info" },
  paid: { label: "Paid", tone: "mint" },
  overdue: { label: "Overdue", tone: "danger" },
  void: { label: "Void", tone: "plain" },
};

function InvoiceStatus({ status }: { status: string }) {
  const { label, tone } = INVOICE_STATUS[status] ?? { label: status, tone: "plain" as const };
  return <Badge tone={tone}>{label}</Badge>;
}

/** Stripe's hosted invoice page, the one the customer pays on; https only. */
function StripeLink({ url }: { url: string | null }) {
  if (!url || !url.startsWith("https://")) return <span className="text-faint">—</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-merged hover:underline">
      Stripe
      <ExternalLink size={12} />
    </a>
  );
}

function InvoicesSection({
  email,
  invoices,
  sent,
  pathname,
  error,
}: {
  email: string | null;
  invoices: EnterpriseInvoice[];
  sent: EnterpriseInvoice | null;
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section id="invoices" title="Invoices" description="One Stripe invoice for every workspace it pays for, net 30, emailed by Stripe.">
      <div className="space-y-4">
        {error && <Notice tone="error">{error.error}</Notice>}
        {sent && (
          <Notice tone="ok">
            Invoice sent: {usd(sent.amountMicros)} for {sent.period}. <StripeLink url={sent.hostedUrl} />
          </Notice>
        )}

        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="billing-email" />
          <Field label="Invoices go to" hint={email ? "Stripe emails each invoice here." : "Not set yet. Needed before an invoice can be sent."} className="grow">
            <Input name="email" type="email" required placeholder="billing@acme.com" defaultValue={error?.values?.email ?? email ?? ""} />
          </Field>
          <Button type="submit" variant="quiet">
            <Mail size={14} />
            {email ? "Change" : "Set"}
          </Button>
        </form>

        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="intent" value="invoice" />
          <p className="text-sm text-muted">An invoice goes out on its own when each month closes. Send one now for what it owes so far.</p>
          <Button type="submit" variant="quiet" className="shrink-0">
            <Send size={14} />
            Send invoice now
          </Button>
        </form>

        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <div className="-mx-4 -mb-4 overflow-x-auto border-t border-line sm:-mx-5 sm:-mb-5">
            <table className="w-full min-w-xl text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:pl-5">Period</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Lines</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium sm:pr-5">Page</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.invoiceId} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2.5 sm:pl-5">
                      <p>{invoice.period}</p>
                      <p className="text-xs text-faint">
                        <When at={invoice.createdAt} />
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <InvoiceStatus status={invoice.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <ul className="space-y-0.5 text-xs">
                        {invoice.lines.map((line) => (
                          <li key={line.workspace} className="tabular">
                            <span className="font-mono text-fg-soft">{line.workspace}</span>
                            <span className="text-faint">: {usd(line.amountMicros)}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right whitespace-nowrap">{usd(invoice.amountMicros)}</td>
                    <td className="px-4 py-2.5 text-xs sm:pr-5">
                      <StripeLink url={invoice.hostedUrl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
