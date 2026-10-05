/**
 * Sales on a workspace's page: where it stands, who on the team has it,
 * the next step, and notes; and its invoices from g1t. Plain forms.
 */
import { CalendarClock, ExternalLink, FileDown, MessageSquarePlus, Save, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import type { SalesRecord, WorkspaceInvoice } from "@g1t/contracts";

import { Badge, Button, EmptyState, Field, Input, Notice, Section, Select, Textarea, When } from "~/components/ui";
import { usd } from "~/lib/money";
import type { SectionError } from "~/lib/review";
import { STAGES, signalMeta, stageMeta } from "~/lib/signals";

export function SignalBadge({ kind }: { kind: string }) {
  const meta = signalMeta(kind);
  return (
    <span title={meta.about || undefined}>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </span>
  );
}

export function StageBadge({ stage }: { stage: string | null | undefined }) {
  const meta = stageMeta(stage);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** A staff member, as "you" when it is the one looking. */
export function StaffName({ email, me }: { email: string | null | undefined; me: string }) {
  if (!email) return <span className="text-faint">Unassigned</span>;
  const mine = email.toLowerCase() === me.toLowerCase();
  return (
    <span title={email} className="inline-flex min-w-0 items-center gap-1">
      <UserRound size={12} className="shrink-0 text-faint" />
      <span className="truncate font-mono text-xs text-fg-soft">{mine ? "you" : email}</span>
    </span>
  );
}

/** Whether a follow-up day (YYYY-MM-DD) is today or past, UTC. */
function isDue(day: string | null, today = new Date().toISOString().slice(0, 10)): boolean {
  return day != null && day.slice(0, 10) <= today;
}

export function SalesSection({
  sales,
  unavailable,
  me,
  pathname,
  salesError,
  noteError,
  done,
}: {
  sales: SalesRecord | null;
  unavailable: string | null;
  me: string;
  pathname: string;
  salesError: SectionError;
  noteError: SectionError;
  done: string | null;
}) {
  const values = salesError?.values;
  const record = sales;
  return (
    <Section
      id="sales"
      title="Sales"
      description={
        record?.updatedAt ? (
          <>
            Where it stands with g1t, and what the team is doing about it. Updated <When at={record.updatedAt} time />.
          </>
        ) : (
          "Where it stands with g1t, and what the team is doing about it."
        )
      }
      actions={record && <StageBadge stage={record.stage} />}
    >
      {unavailable ? (
        <Notice tone="warn">Billing did not answer for sales records: {unavailable}</Notice>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Stage, owner and next step */}
          <form method="post" action={`${pathname}#sales`} className="space-y-4">
            <input type="hidden" name="intent" value="sales" />
            {done && <Notice tone="ok">{done}</Notice>}
            {salesError && <Notice tone="error">{salesError.error}</Notice>}
            {record?.nextStep && (
              <div
                className={`flex gap-2.5 rounded-md border px-3 py-2.5 text-sm ${
                  isDue(record.nextAt) ? "border-warn/40 bg-warn/8" : "border-line bg-bg"
                }`}
              >
                <CalendarClock size={16} className={`mt-0.5 shrink-0 ${isDue(record.nextAt) ? "text-warn" : "text-faint"}`} />
                <div className="min-w-0">
                  <p className="text-fg-soft">{record.nextStep}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    {record.nextAt ? (
                      <>
                        {isDue(record.nextAt) ? "Due " : "On "}
                        <When at={`${record.nextAt.slice(0, 10)}T00:00:00Z`} />
                      </>
                    ) : (
                      "No date"
                    )}
                    {" · "}
                    <StaffName email={record.owner} me={me} />
                  </p>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Stage">
                <Select name="stage" defaultValue={values?.stage ?? record?.stage ?? "none"}>
                  {STAGES.map((entry) => (
                    <option key={entry.stage} value={entry.stage}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner" hint="Who on the team has it. Blank: nobody.">
                <Input name="owner" type="email" placeholder="you@g1t.sh" defaultValue={values?.owner ?? record?.owner ?? me} className="font-mono text-xs" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Field label="Next step">
                <Input name="nextStep" maxLength={200} placeholder="e.g. Call the owner about an enterprise plan" defaultValue={values?.nextStep ?? record?.nextStep ?? ""} />
              </Field>
              <Field label="By" hint="UTC.">
                <Input type="date" name="nextAt" defaultValue={values?.nextAt ?? record?.nextAt?.slice(0, 10) ?? ""} />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="quiet">
                <Save size={14} />
                Save
              </Button>
            </div>
          </form>

          {/* Notes */}
          <div>
            <form method="post" action={`${pathname}#notes`} id="notes" className="scroll-mt-20 space-y-2">
              <input type="hidden" name="intent" value="note" />
              {noteError && <Notice tone="error">{noteError.error}</Notice>}
              <Field label="Add a note" hint="Calls, emails, what they asked for. Staff only; signed with your email.">
                <Textarea name="text" rows={3} required maxLength={2000} defaultValue={noteError?.values?.text ?? ""} placeholder="e.g. Spoke to the owner: they want annual billing." />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="quiet">
                  <MessageSquarePlus size={14} />
                  Add note
                </Button>
              </div>
            </form>
            <NotesList notes={record?.notes ?? []} me={me} />
          </div>
        </div>
      )}
    </Section>
  );
}

function NotesList({ notes, me }: { notes: SalesRecord["notes"]; me: string }) {
  if (notes.length === 0) return <p className="mt-4 text-sm text-faint">No notes yet.</p>;
  const sorted = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ol className="mt-4 space-y-3">
      {sorted.map((note) => (
        <li key={note.id} className="border-l-2 border-merged/40 pl-3">
          <p className="text-sm break-words whitespace-pre-line text-fg-soft">{note.text}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-faint">
            <StaffName email={note.by} me={me} />
            <When at={note.createdAt} time />
          </p>
        </li>
      ))}
    </ol>
  );
}

// --- Invoices -----------------------------------------------------------------

const INVOICE_STATUS: Record<string, { label: string; tone: "plain" | "mint" | "warn" | "danger" | "info" }> = {
  open: { label: "Open", tone: "info" },
  paid: { label: "Paid", tone: "mint" },
  failed: { label: "Failed", tone: "danger" },
  overdue: { label: "Overdue", tone: "danger" },
  void: { label: "Void", tone: "plain" },
};

export function InvoiceStatus({ status }: { status: string }) {
  const { label, tone } = INVOICE_STATUS[status] ?? { label: status, tone: "plain" as const };
  return <Badge tone={tone}>{label}</Badge>;
}

/** A link to a page on Stripe; https only. */
function StripeLink({ url, children }: { url: string | null; children: ReactNode }) {
  if (!url || !url.startsWith("https://")) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-merged hover:underline">
      {children}
    </a>
  );
}

const REASON: Record<string, string> = { month: "Monthly", threshold: "Near the limit" };

export function WorkspaceInvoicesSection({ invoices, unavailable }: { invoices: WorkspaceInvoice[]; unavailable: string | null }) {
  const open = invoices.filter((invoice) => invoice.status === "open" || invoice.status === "failed");
  const owed = open.reduce((sum, invoice) => sum + invoice.amountMicros, 0);
  return (
    <Section
      id="invoices"
      title="Invoices"
      description={
        invoices.length > 0 && open.length > 0 ? (
          <>
            {open.length} not paid, {usd(owed)} in all. Monthly, and each time it is charged near its limit.
          </>
        ) : (
          "Monthly, and each time it is charged near its limit. Charged to the card on file."
        )
      }
    >
      {unavailable ? (
        <Notice tone="warn">Billing did not answer for invoices: {unavailable}</Notice>
      ) : invoices.length === 0 ? (
        <EmptyState title="No invoices yet" />
      ) : (
        <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
          <table className="w-full min-w-xl text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium sm:pl-5">Period</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Lines</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium sm:pr-5">On Stripe</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.invoiceId} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2.5 sm:pl-5">
                    <p className="text-fg-soft">{invoice.period}</p>
                    <p className="text-xs text-faint">
                      {REASON[invoice.reason] ?? invoice.reason} · <When at={invoice.createdAt} />
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <InvoiceStatus status={invoice.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    {invoice.lines.length === 0 ? (
                      <span className="text-xs text-faint">—</span>
                    ) : (
                      <details className="group">
                        <summary className="cursor-pointer list-none text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
                          {invoice.lines.length} line{invoice.lines.length === 1 ? "" : "s"}
                          <span className="text-faint group-open:hidden"> · show</span>
                        </summary>
                        <ul className="mt-1.5 space-y-0.5 text-xs">
                          {invoice.lines.map((line, index) => (
                            <li key={index} className="tabular flex justify-between gap-3">
                              <span className="text-fg-soft">{line.description}</span>
                              <span className="text-faint">{usd(line.amountMicros)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right whitespace-nowrap">{usd(invoice.amountMicros)}</td>
                  <td className="px-4 py-2.5 text-xs sm:pr-5">
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      <StripeLink url={invoice.hostedUrl}>
                        Page
                        <ExternalLink size={12} />
                      </StripeLink>
                      <StripeLink url={invoice.pdfUrl}>
                        PDF
                        <FileDown size={12} />
                      </StripeLink>
                      {!invoice.hostedUrl && !invoice.pdfUrl && <span className="text-faint">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
