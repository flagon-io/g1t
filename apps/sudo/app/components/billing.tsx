/**
 * The billing sections shared by a workspace's page and an enterprise's:
 * confirmations, terms, credit, the Stripe billing link, the ledger and the
 * audit log. Plain forms; sudo ships no JavaScript.
 */
import { CreditCard, Gift, ScrollText, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AdminAction, AdminOwner, BillingLink, LedgerEntry, Terms } from "@g1t/contracts";

import { Avatar, Badge, Button, EmptyState, Field, Input, Notice, Section, Select, Textarea, When } from "~/components/ui";
import { dollarsField, usd } from "~/lib/money";
import type { Review, SectionError } from "~/lib/review";

export function Hidden({ values }: { values: Record<string, string> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

export function Figure({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

/** Owners' usernames, each with their email beneath (and on hover). */
export function Owners({ owners, compact = false }: { owners: AdminOwner[]; compact?: boolean }) {
  if (owners.length === 0) return <span className="text-faint">No owner</span>;
  if (compact) {
    return (
      <span className="flex flex-col gap-0.5">
        {owners.map((owner) => (
          <span key={owner.username} title={owner.email ?? "No email"} className="min-w-0 truncate">
            <span className="font-mono text-fg-soft">{owner.username}</span>
            {owner.email && <span className="block truncate text-xs text-faint">{owner.email}</span>}
          </span>
        ))}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {owners.map((owner) => (
        <li key={owner.username} title={owner.email ?? "No email"} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-xs">
          <Avatar name={owner.username} size={14} square={false} />
          <span className="font-mono">{owner.username}</span>
          {owner.email && <span className="text-faint">{owner.email}</span>}
        </li>
      ))}
    </ul>
  );
}

// --- Confirmation ------------------------------------------------------------

function describeTerms(terms: Terms): [string, string][] {
  return [
    ["Terms", terms.kind === "custom" ? "Custom" : terms.kind === "comped" ? "Comped" : "Standard"],
    ["Discount", terms.kind === "custom" ? `${terms.discountPercent}%` : "—"],
    ["Limit", terms.ceilingMicros == null ? "By trust" : usd(terms.ceilingMicros)],
    ["Until", terms.until ? terms.until.slice(0, 10) : "No end"],
    ["Note", terms.note || "—"],
  ];
}

/** Where a confirmed change lands, when its result is shown in place. */
const RESULT_ANCHOR: Partial<Record<Review["intent"], string>> = { "billing-link": "billing-link", invoice: "invoices" };

export function ReviewPanel({ review, pathname }: { review: Review; pathname: string }) {
  let title: string;
  let body: ReactNode;
  let danger = false;
  let confirm = "Confirm";
  if (review.intent === "terms") {
    const before = describeTerms(review.before);
    const after = describeTerms(review.after);
    title = "Confirm the new terms";
    danger = review.after.kind === "comped";
    body = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1.5 pr-4 font-medium" />
                <th className="py-1.5 pr-4 font-medium">Now</th>
                <th className="py-1.5 font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {after.map(([label, value], index) => (
                <tr key={label} className="border-t border-line align-top">
                  <td className="py-1.5 pr-4 text-muted">{label}</td>
                  <td className="py-1.5 pr-4 break-words text-faint">{before[index][1]}</td>
                  <td className={`py-1.5 break-words ${value !== before[index][1] ? "font-medium text-fg" : "text-muted"}`}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {review.after.kind === "comped" && (
          <p className="mt-3 text-sm text-warn">
            Comped: nothing will be charged{review.after.until ? ` until ${review.after.until.slice(0, 10)}` : ""}. Usage is still recorded
            at cost.
          </p>
        )}
      </>
    );
  } else if (review.intent === "attach") {
    title = `Bill ${review.workspace} to ${review.targetName}?`;
    body = (
      <p className="text-sm text-muted">
        From now on <span className="font-mono text-fg">{review.workspace}</span>'s usage is billed to{" "}
        <span className="text-fg">{review.targetName}</span> and counts against its limit and terms, not its own.
      </p>
    );
  } else if (review.intent === "detach") {
    title = `Move ${review.workspace} off ${review.from}?`;
    danger = true;
    body = (
      <p className="text-sm text-muted">
        <span className="font-mono text-fg">{review.workspace}</span> goes back to paying for itself, on its own terms and the limit
        its trust gives it. It may stop at once if its own limit is lower than what it owes.
      </p>
    );
  } else if (review.intent === "billing-email") {
    title = `Send ${review.name}'s invoices to ${review.after}?`;
    body = (
      <p className="text-sm text-muted">
        Stripe emails its invoices to <span className="font-mono text-fg">{review.after}</span>
        {review.before ? (
          <>
            {" "}
            instead of <span className="font-mono">{review.before}</span>
          </>
        ) : null}
        , from the next invoice on.{!review.before && " This also sets the enterprise up as a customer on Stripe."}
      </p>
    );
  } else if (review.intent === "invoice") {
    title = `Invoice ${review.name} now?`;
    confirm = "Send the invoice";
    body = (
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>Makes one Stripe invoice, with a line for each of its {review.workspaces} workspace{review.workspaces === 1 ? "" : "s"} for what it owes now.</li>
        <li>Net 30: due in 30 days.</li>
        <li>
          Stripe emails it to <span className="font-mono text-fg">{review.email ?? "the invoice email (none set yet)"}</span>, with a link to
          pay on Stripe's page.
        </li>
      </ul>
    );
  } else {
    title = `Make a Stripe billing link for ${review.workspace}?`;
    confirm = "Make the link";
    body = (
      <p className="text-sm text-muted">
        Opens a one-time session on Stripe's billing page for <span className="font-mono text-fg">{review.workspace}</span>'s
        customer, where they update their card and see their invoices. Anyone with the link can use it until it expires, so send it
        only to the workspace's owner. Making it is recorded with your email.
      </p>
    );
  }
  return (
    <section id="review" className={`scroll-mt-20 rounded-lg border p-4 sm:p-5 ${danger ? "border-warn/40 bg-warn/5" : "border-merged/40 bg-merged/5"}`}>
      <h2 className="font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{body}</div>
      <form method="post" action={`${pathname}#${RESULT_ANCHOR[review.intent] ?? "top"}`} className="mt-4 flex flex-wrap items-center gap-2">
        <Hidden values={review.fields} />
        <input type="hidden" name="intent" value={review.intent} />
        <input type="hidden" name="confirm" value="yes" />
        <Button type="submit" variant={danger ? "danger" : "lavender"}>
          {confirm}
        </Button>
        <Link to={pathname} className="px-2 text-sm text-muted hover:text-fg">
          Cancel
        </Link>
      </form>
    </section>
  );
}

// --- Terms -------------------------------------------------------------------

const KINDS: { value: Terms["kind"]; title: string; text: string }[] = [
  { value: "standard", title: "Standard", text: "Published prices; the limit comes from trust." },
  { value: "comped", title: "Comped", text: "Nothing charged. Usage still recorded at cost." },
  { value: "custom", title: "Custom", text: "A discount, a custom limit, or both." },
];

export function TermsForm({ terms, pathname, error }: { terms: Terms; pathname: string; error: SectionError }) {
  const values = error?.values;
  const kind = values?.kind ?? terms.kind;
  return (
    <Section
      id="terms"
      title="Terms"
      description={
        terms.setBy ? (
          <>
            Set by <span className="font-mono">{terms.setBy}</span> on <When at={terms.setAt} />
            {terms.note && <> · “{terms.note}”</>}
          </>
        ) : (
          "Standard, as everyone starts."
        )
      }
    >
      <form method="post" action={`${pathname}#review`} className="space-y-4">
        <input type="hidden" name="intent" value="terms" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Kind</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer gap-2.5 rounded-md border border-line bg-bg p-3 transition-colors hover:border-line-strong has-checked:border-merged/60 has-checked:bg-merged/8"
              >
                <input type="radio" name="kind" value={option.value} defaultChecked={kind === option.value} className="mt-0.5" required />
                <span>
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{option.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount %" hint="Custom only.">
            <Input name="discount" inputMode="numeric" pattern="\d{1,3}" placeholder="0" defaultValue={values?.discount ?? (terms.discountPercent ? String(terms.discountPercent) : "")} />
          </Field>
          <Field label="Limit $" hint="Unpaid usage allowed. Blank: trust decides.">
            <Input name="ceiling" inputMode="decimal" placeholder="By trust" defaultValue={values?.ceiling ?? dollarsField(terms.ceilingMicros)} />
          </Field>
          <Field label="Until" hint="Blank: no end. UTC.">
            <Input type="date" name="until" defaultValue={values?.until ?? (terms.until ? terms.until.slice(0, 10) : "")} />
          </Field>
        </div>
        <Field label="Note" hint="Required. Why, for whoever looks next.">
          <Textarea name="note" rows={2} required maxLength={500} defaultValue={values?.note ?? ""} placeholder="e.g. Design partner through launch" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Review terms</Button>
        </div>
      </form>
    </Section>
  );
}

// --- Credit -------------------------------------------------------------------

export function CreditForm({ workspaces, pathname, error }: { workspaces: string[]; pathname: string; error: SectionError }) {
  const values = error?.values;
  const single = workspaces.length === 1 ? workspaces[0] : null;
  return (
    <Section id="credit" title="Issue credit" description="A refund or goodwill. Added to the workspace's balance at once.">
      {workspaces.length === 0 ? (
        <p className="text-sm text-muted">Add a workspace first: credit goes to a workspace.</p>
      ) : (
        <form method="post" action={`${pathname}#credit`} className="space-y-4">
          <input type="hidden" name="intent" value="credit" />
          {error && <Notice tone="error">{error.error}</Notice>}
          {single ? (
            <input type="hidden" name="workspace" value={single} />
          ) : (
            <Field label="Workspace">
              <Select name="workspace" required defaultValue={values?.workspace ?? ""}>
                <option value="" disabled>
                  Choose a workspace
                </option>
                {workspaces.map((slug) => (
                  <option key={slug} value={slug}>
                    {slug}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Amount $" hint="Up to $10,000 at a time.">
            <Input name="amount" inputMode="decimal" required placeholder="25.00" defaultValue={values?.amount ?? ""} />
          </Field>
          <Field label="Note" hint="Required. Shown on the workspace's statement.">
            <Textarea name="note" rows={2} required maxLength={500} placeholder="e.g. Refund for the failed runs on Oct 2" defaultValue={values?.note ?? ""} />
          </Field>
          <Field
            label="Confirm"
            hint={
              <>
                Type the workspace's slug{single && <> (<span className="font-mono text-muted">{single}</span>)</>} to issue it.
              </>
            }
          >
            <Input name="confirmation" required placeholder={single ?? "workspace-slug"} className="font-mono" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="lavender">
              <Gift size={14} />
              Issue credit
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

// --- Stripe billing link -----------------------------------------------------

/**
 * Card details, invoices and receipts live on Stripe's own billing page.
 * sudo never shows a card field: staff send the customer a link instead.
 */
export function BillingLinkSection({
  link,
  pathname,
  error,
}: {
  link: BillingLink | null;
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section
      id="billing-link"
      title="Stripe billing page"
      description="Where the customer updates their card and sees invoices. g1t never takes card numbers."
    >
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error.error}</Notice>
        </div>
      )}
      {link ? (
        <div className="space-y-4">
          <Notice tone="info">Send this to the customer. g1t never takes card numbers; they enter them on Stripe.</Notice>
          <Field label="One-time link" hint={link.expiresNote}>
            <Input readOnly value={link.portalUrl} className="font-mono text-xs" aria-label="One-time Stripe billing link" />
          </Field>
          {link.loginUrl && (
            <Field label="Permanent sign-in page" hint={`The customer signs in with ${link.customerEmail ?? "the email Stripe has for them"}.`}>
              <Input readOnly value={link.loginUrl} className="font-mono text-xs" aria-label="Stripe billing sign-in page" />
            </Field>
          )}
          {!link.loginUrl && link.customerEmail && <p className="text-xs text-faint">Stripe has {link.customerEmail} for this customer.</p>}
        </div>
      ) : (
        <form method="post" action={`${pathname}#review`} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input type="hidden" name="intent" value="billing-link" />
          <p className="text-sm text-muted">
            Never take card details over the phone or by email. Make a link to Stripe's billing page and send it to the owner.
          </p>
          <Button type="submit" variant="quiet" className="shrink-0">
            <CreditCard size={14} />
            Make a link
          </Button>
        </form>
      )}
    </Section>
  );
}

// --- Ledger and audit ---------------------------------------------------------

const ENTRY_KIND: Record<string, string> = { top_up: "Top-up", usage: "Usage", credit: "Credit" };

export function LedgerSection({
  ledger,
  showWorkspace = false,
  description = "Recent lines of the statement, newest first.",
}: {
  ledger: LedgerEntry[];
  showWorkspace?: boolean;
  description?: ReactNode;
}) {
  return (
    <Section title="Ledger" description={description}>
      {ledger.length === 0 ? (
        <EmptyState title="Nothing yet" />
      ) : (
        <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium sm:pl-5">When</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 text-right font-medium sm:pr-5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pl-5">
                    <When at={entry.createdAt} time />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={entry.amountMicros > 0 ? "mint" : "plain"}>{ENTRY_KIND[entry.kind] ?? entry.kind}</Badge>
                      {showWorkspace && entry.workspace && (
                        <Link to={`/workspaces/${encodeURIComponent(entry.workspace)}`} className="font-mono text-xs text-merged hover:underline">
                          {entry.workspace}
                        </Link>
                      )}
                      <span className="break-words">{entry.description}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-faint">
                      {[
                        entry.repo && (entry.number != null ? `${entry.repo}#${entry.number}` : entry.repo),
                        entry.task,
                        entry.model,
                        entry.billedTo === "workspace" ? "own provider" : null,
                        entry.createdBy && `by ${entry.createdBy}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </td>
                  <td className={`tabular px-4 py-2.5 text-right whitespace-nowrap sm:pr-5 ${entry.amountMicros > 0 ? "text-accent" : "text-fg-soft"}`}>
                    {usd(entry.amountMicros, { signed: true })}
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

const ACTION: Record<string, string> = {
  terms: "Terms changed",
  create: "Enterprise created",
  attach: "Workspace added",
  detach: "Workspace removed",
  credit: "Credit issued",
  billing_link: "Billing link made",
  billing_email: "Invoice email set",
  invoice: "Invoice sent",
  dispute: "Payment disputed",
  stripe: "Stripe",
  webhook: "Webhook registered",
};

export function AuditSection({ audit, description = "Every change made in sudo, and by whom." }: { audit: AdminAction[]; description?: ReactNode }) {
  return (
    <Section title="Audit log" description={description}>
      {audit.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <ScrollText size={14} />
          No changes yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {audit.map((entry) => (
            <li key={entry.id} className="border-l-2 border-merged/40 pl-3">
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="font-medium text-merged">{ACTION[entry.action] ?? entry.action}</span>
                <span className="text-xs text-faint">
                  <When at={entry.createdAt} time />
                </span>
              </p>
              {entry.detail && <p className="mt-0.5 text-sm break-words text-fg-soft">{entry.detail}</p>}
              <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-faint">
                <UserRound size={11} />
                {entry.by}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
