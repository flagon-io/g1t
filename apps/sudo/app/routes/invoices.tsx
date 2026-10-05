import { ExternalLink } from "lucide-react";
import { Link } from "react-router";

import type { InvoiceSummary } from "@g1t/contracts";

import type { Route } from "./+types/invoices";
import { InvoiceStatus } from "~/components/sales";
import { Avatar, Badge, Button, EmptyState, Input, Notice, PageHeader, Select, Stat, When } from "~/components/ui";
import { monthLong } from "~/lib/chart";
import { INVOICE_STATUSES, accountPath, invoiceTotals, parseInvoiceStatus, parseMonth, safeUrl } from "~/lib/ledgers";
import { usd } from "~/lib/money";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Invoices · sudo" }, { name: "robots", content: "noindex, nofollow" }];

/** The most billing returns in one list. */
const MOST = 200;

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const status = parseInvoiceStatus(url.searchParams.get("status"));
  const month = parseMonth(url.searchParams.get("month"));
  const result = await settle(admin.allInvoices({ status: status ?? undefined, month: month ?? undefined }));
  const invoices = result.ok ? result.value : [];
  return {
    status,
    month,
    invoices,
    totals: invoiceTotals(invoices),
    capped: invoices.length >= MOST,
    error: result.ok ? null : result.error,
  };
}

const STATUS_LABEL: Record<string, string> = { open: "Open", overdue: "Overdue", failed: "Failed", paid: "Paid", void: "Void" };
const REASON: Record<string, string> = { month: "Monthly", threshold: "Near the limit", manual: "Sent by staff" };

export default function Invoices({ loaderData }: Route.ComponentProps) {
  const { status, month, invoices, totals, capped, error } = loaderData;
  const filtered = status != null || month != null;
  const scope = [status ? STATUS_LABEL[status].toLowerCase() : null, month ? `in ${monthLong(month)}` : null].filter(Boolean).join(", ");

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Invoices"
        description="Every invoice g1t has sent, newest first: workspaces' monthly and near-the-limit invoices, and enterprises' net-30 ones."
      />

      {error ? (
        <div className="mt-6">
          <Notice tone="warn">Billing did not answer for invoices: {error}</Notice>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={filtered ? `Invoices, ${scope}` : "Invoices"} value={`${totals.count}${capped ? "+" : ""}`} hint={capped ? `The newest ${MOST}` : "Void ones count for nothing"} />
          <Stat label="Amount" value={usd(totals.amountMicros)} hint="Everything not void" />
          <Stat label="Paid" value={usd(totals.paidMicros)} tone={totals.paidMicros > 0 ? "mint" : undefined} />
          <Stat
            label="Outstanding"
            value={usd(totals.outstandingMicros)}
            hint={`${totals.outstanding} open, overdue or failed`}
            tone={totals.outstanding > 0 ? "warn" : undefined}
          />
        </div>
      )}

      <form method="get" action="/invoices" className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select name="status" defaultValue={status ?? ""} aria-label="Status" className="sm:w-44">
          <option value="">Any status</option>
          {INVOICE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </Select>
        <Input type="month" name="month" defaultValue={month ?? ""} aria-label="Month" className="sm:w-48" />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="quiet" className="py-2">
            Apply
          </Button>
          {filtered && (
            <Link to="/invoices" className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      {!error &&
        (invoices.length === 0 ? (
          <div className="mt-4">
            <EmptyState title={filtered ? "No invoices match" : "No invoices yet"}>
              {filtered ? "Try another status or month, or clear the filters." : "Invoices appear here as months close and workspaces are charged near their limits."}
            </EmptyState>
          </div>
        ) : (
          <>
            {/* Phones: one card per invoice. */}
            <ul className="mt-4 space-y-2 md:hidden">
              {invoices.map((invoice) => (
                <li key={invoice.invoiceId} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Customer invoice={invoice} />
                    <span className="tabular shrink-0 text-sm font-medium">{usd(invoice.amountMicros)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <InvoiceStatus status={invoice.status} />
                    <span className="text-muted">{invoice.period}</span>
                    <span className="text-faint">· {REASON[invoice.reason] ?? invoice.reason}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3 text-xs text-faint">
                    <Dates invoice={invoice} />
                    <StripeLink url={invoice.hostedUrl} />
                  </div>
                </li>
              ))}
            </ul>

            {/* Wider screens: a table. */}
            <div className="mt-4 hidden overflow-x-auto rounded-lg border border-line md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">For</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Sent · paid</th>
                    <th className="px-4 py-2.5 font-medium">On Stripe</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.invoiceId} className="border-b border-line align-top last:border-0 hover:bg-surface/60">
                      <td className="px-4 py-3">
                        <Customer invoice={invoice} />
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-fg-soft">{invoice.period}</p>
                        <p className="text-xs text-faint">{REASON[invoice.reason] ?? invoice.reason}</p>
                      </td>
                      <td className="tabular px-4 py-3 text-right whitespace-nowrap">{usd(invoice.amountMicros)}</td>
                      <td className="px-4 py-3">
                        <InvoiceStatus status={invoice.status} />
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted">
                        <Dates invoice={invoice} />
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <StripeLink url={invoice.hostedUrl} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {capped && <p className="mt-3 text-xs text-faint">Only the newest {MOST} are listed; filter by month or status to see older ones.</p>}
          </>
        ))}
    </main>
  );
}

function Customer({ invoice }: { invoice: InvoiceSummary }) {
  const path = accountPath(invoice.account);
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={invoice.name} size={18} />
      <span className={`truncate ${invoice.kind === "workspace" ? "font-mono text-[0.8125rem]" : "font-medium"}`}>{invoice.name}</span>
    </span>
  );
  return (
    <div className="min-w-0">
      {path ? (
        <Link to={path} className="block hover:underline hover:underline-offset-4">
          {name}
        </Link>
      ) : (
        name
      )}
      <div className="mt-1.5">
        {invoice.kind === "enterprise" ? <Badge tone="lavender">Enterprise</Badge> : <Badge>Workspace</Badge>}
      </div>
    </div>
  );
}

function Dates({ invoice }: { invoice: InvoiceSummary }) {
  return (
    <span>
      <When at={invoice.createdAt} />
      {invoice.paidAt ? (
        <span className="text-accent">
          {" · "}paid <When at={invoice.paidAt} />
        </span>
      ) : null}
    </span>
  );
}

function StripeLink({ url }: { url: string | null }) {
  const safe = safeUrl(url);
  if (!safe) return <span className="text-faint">—</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-merged hover:underline">
      Stripe
      <ExternalLink size={12} />
    </a>
  );
}
