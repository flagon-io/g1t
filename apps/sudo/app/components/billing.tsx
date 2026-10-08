/**
 * The billing sections shared by a workspace's page and an enterprise's:
 * confirmations, terms, plan, pools and caps, credit, bank transfers, the
 * Stripe billing link, the ledger and the audit log. Plain forms; sudo ships no JavaScript.
 */
import { CreditCard, Gift, Landmark, RotateCcw, ScrollText, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AdminAction, AdminOwner, Allowances, BillingLink, CreditGrant, Credits, LedgerEntry, Terms } from "@g1t/contracts";

import { Avatar, Badge, Button, EmptyState, Field, Input, Notice, Section, Select, Textarea, When } from "~/components/ui";
import { CREDIT_KINDS, CREDIT_PRESETS, EXPIRIES, kindLabel } from "~/lib/credits";
import { DISCOUNT_PRESETS, fullDiscount, percentOff, termsLabel } from "~/lib/terms";
import { actionLabel } from "~/lib/ledgers";
import { dollarsField, usd } from "~/lib/money";
import { givenParts } from "~/lib/pricing";
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
    ["Terms", termsLabel(terms)],
    ["Discount", `${percentOff(terms)}%`],
    [
      "Limit",
      fullDiscount(terms)
        ? terms.ceilingMicros == null
          ? "The default monthly budget, at cost"
          : `${usd(terms.ceilingMicros)} a month, at cost`
        : terms.ceilingMicros == null
          ? "By trust"
          : usd(terms.ceilingMicros),
    ],
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
    danger = fullDiscount(review.after);
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
        {fullDiscount(review.after) && (
          <p className="mt-3 text-sm text-warn">
            A 100% discount: nothing will be charged{review.after.until ? ` until ${review.after.until.slice(0, 10)}` : ""}. The workspace's
            statement still shows its usage at price, with the discount beside it.
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

/**
 * The account's terms: a discount (0, 25, 50, 100% or a custom percent),
 * a limit, an end date and why. A 100% discount charges nothing; the
 * workspace's statement still shows its usage at price. The custom percent
 * shows only for Custom, by CSS alone (`.terms-form` in app.css).
 */
export function TermsForm({ terms, pathname, error }: { terms: Terms; pathname: string; error: SectionError }) {
  const values = error?.values;
  const current = percentOff(terms);
  const preset = values?.preset ?? ((DISCOUNT_PRESETS as readonly number[]).includes(current) ? String(current) : "custom");
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
      <form method="post" action={`${pathname}#review`} className="terms-form space-y-4">
        <input type="hidden" name="intent" value="terms" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Discount</legend>
          <div className="flex flex-wrap overflow-hidden rounded-md border border-line bg-bg">
            {DISCOUNT_PRESETS.map((percent) => (
              <Segment key={percent} name="preset" value={String(percent)} checked={preset === String(percent)}>
                {percent === 0 ? "None" : `${percent}%`}
              </Segment>
            ))}
            <Segment name="preset" value="custom" checked={preset === "custom"}>
              Custom
            </Segment>
          </div>
          <p className="mt-1.5 text-xs text-faint">Off every usage charge. 100%: nothing is charged, and the statement shows usage at price with the discount beside it.</p>
        </fieldset>
        <div className="when-custom">
          <Field label="Custom discount %" hint="A whole percent, 1 to 100.">
            <Input name="discount" inputMode="numeric" pattern="\d{1,3}" placeholder="30" defaultValue={values?.discount ?? (preset === "custom" ? String(current) : "")} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Limit $" hint="Unpaid usage allowed; blank: trust decides. At 100%: g1t's monthly budget for it, at cost; blank: the default ($150).">
            <Input name="ceiling" inputMode="decimal" placeholder="By trust" defaultValue={values?.ceiling ?? dollarsField(terms.ceilingMicros)} />
          </Field>
          <Field label="Until" hint="Blank: no end. UTC.">
            <Input type="date" name="until" defaultValue={values?.until ?? (terms.until ? terms.until.slice(0, 10) : "")} />
          </Field>
        </div>
        <Field label="Reason" hint="Required. Why, for whoever looks next; at 100%, shown as the reason for the discount.">
          <Textarea name="note" rows={2} required maxLength={500} defaultValue={values?.note ?? ""} placeholder="e.g. g1t's own workspace" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Review terms</Button>
        </div>
      </form>
    </Section>
  );
}

// --- Plan, pools and caps -------------------------------------------------------

/** What staff have set beyond the terms, one line each; defaults left out. */
export function allowanceLines(allowances: Allowances | undefined, comped: boolean): string[] {
  const lines: string[] = [];
  if (comped) lines.push("The g1t plan, without its price (100% discount)");
  else if (allowances?.plan) lines.push("The g1t plan, without its price");
  if (!allowances) return lines;
  if (allowances.ossRepoMicros != null) lines.push(`Open-source pool: ${usd(allowances.ossRepoMicros)} a month for each public repository`);
  if (allowances.trialMicros != null) lines.push(`Trial: ${usd(allowances.trialMicros)}, outside the monthly pool`);
  if (allowances.maxConcurrentAgents != null) {
    lines.push(`${allowances.maxConcurrentAgents} agent${allowances.maxConcurrentAgents === 1 ? "" : "s"} at once`);
  }
  if (allowances.runCapMicros != null) lines.push(`Run cap: ${usd(allowances.runCapMicros)} a run`);
  if (allowances.issueCapMicros != null) lines.push(`Issue cap: ${usd(allowances.issueCapMicros)} an issue`);
  if (allowances.auditRetentionDays != null) lines.push(`Audit log: ${allowances.auditRetentionDays} days, in place of the plan's`);
  if (allowances.hold) lines.push(`Held: ${allowances.hold}`);
  return lines;
}

/**
 * The g1t plan without its price, the account's share of g1t's pools, and
 * staff's overrides of what owners set: agents at once, the run and issue
 * caps, the days of audit log kept (such as for an organization that pays
 * for longer), and a hold on new compute. Accounts on a 100% discount have the plan
 * anyway.
 */
export function AllowancesForm({
  allowances,
  comped,
  pathname,
  error,
}: {
  allowances: Allowances | undefined;
  comped: boolean;
  pathname: string;
  error: SectionError;
}) {
  const values = error?.values;
  const current: Allowances = allowances ?? { plan: false, ossRepoMicros: null, trialMicros: null };
  const lines = allowanceLines(allowances, comped);
  return (
    <Section
      id="allowances"
      title="Plan, pools and caps"
      description={
        comped
          ? "A 100% discount: the g1t plan is on without its price whatever is set here. The pools and caps still apply."
          : "The g1t plan without its price, this account's share of g1t's pools, and overrides of what owners set."
      }
    >
      <div className="mb-4 rounded-md border border-line bg-bg px-3.5 py-2.5 text-sm">
        <p className="text-xs text-faint">Set now</p>
        {lines.length === 0 ? (
          <p className="mt-0.5 text-muted">Nothing: the defaults.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {lines.map((line) => (
              <li key={line} className={line.startsWith("Held:") ? "text-danger" : "text-fg-soft"}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form method="post" action={`${pathname}#allowances`} className="space-y-4">
        <input type="hidden" name="intent" value="allowances" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" name="plan" defaultChecked={values ? values.plan === "on" : current.plan} className="mt-0.5" />
          <span>
            <span className="block font-medium">The g1t plan, without its price</span>
            <span className="block text-xs text-muted">
              Its included usage, storage and caps, with no $20 a month. Usage past it is charged as usual.
            </span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Open-source share $" hint="Each public repository, a month. Blank: the default ($2).">
            <Input name="oss" inputMode="decimal" placeholder="Default" defaultValue={values?.oss ?? dollarsField(current.ossRepoMicros)} />
          </Field>
          <Field label="Trial $" hint="Each workspace, outside the monthly pool. Blank: the default ($5).">
            <Input name="trial" inputMode="decimal" placeholder="Default" defaultValue={values?.trial ?? dollarsField(current.trialMicros)} />
          </Field>
          <Field label="Agents at once" hint="Blank: the plan's (2 in the first month or on the trial, then 10).">
            <Input
              name="agents"
              inputMode="numeric"
              pattern="\d{1,3}"
              placeholder="Default"
              defaultValue={values?.agents ?? (current.maxConcurrentAgents != null ? String(current.maxConcurrentAgents) : "")}
            />
          </Field>
          <Field label="Run cap $" hint="One run's spend, over the owners'. Blank: theirs, or $2.">
            <Input name="runCap" inputMode="decimal" placeholder="Owners'" defaultValue={values?.runCap ?? dollarsField(current.runCapMicros)} />
          </Field>
          <Field label="Issue cap $" hint="One issue's agents in all, over the owners'. Blank: theirs, or $10.">
            <Input name="issueCap" inputMode="decimal" placeholder="Owners'" defaultValue={values?.issueCap ?? dollarsField(current.issueCapMicros)} />
          </Field>
          <Field label="Audit log days" hint="Kept, in place of the plan's, longer or shorter, up to 400. Blank: the plan's (7 free, 90 on the plan).">
            <Input
              name="auditDays"
              inputMode="numeric"
              pattern="\d{1,3}"
              placeholder="Plan's"
              defaultValue={values?.auditDays ?? (current.auditRetentionDays != null ? String(current.auditRetentionDays) : "")}
            />
          </Field>
          <Field label="Hold" hint="Pauses new compute and tells the owners why. Blank: no hold.">
            <Input name="hold" maxLength={200} placeholder="No hold" defaultValue={values?.hold ?? current.hold ?? ""} />
          </Field>
        </div>
        <Field label="Note" hint="Required. Why, for whoever looks next.">
          <Textarea
            name="note"
            rows={2}
            required
            maxLength={500}
            defaultValue={values?.note ?? ""}
            placeholder="e.g. Open-source foundation, larger share through 2027"
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Save plan, pools and caps</Button>
        </div>
      </form>
    </Section>
  );
}

// --- Bank transfer ---------------------------------------------------------------

/**
 * Money that reached g1t outside Stripe's page, such as a bank transfer
 * for a $1,000+ prepayment, entered as a payment.
 */
export function PaymentForm({ workspace, pathname, error }: { workspace: string; pathname: string; error: SectionError }) {
  const values = error?.values;
  return (
    <Section
      id="payment"
      title="Record a bank transfer"
      description="Money that reached g1t's bank without Stripe's page, such as a $1,000+ prepayment. It goes on the statement as a payment and counts toward the limit at once."
    >
      <form method="post" action={`${pathname}#payment`} className="space-y-4">
        <input type="hidden" name="intent" value="payment" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount $" hint="As it arrived, up to $100,000.">
            <Input name="amount" inputMode="decimal" required placeholder="1,500.00" defaultValue={values?.amount ?? ""} />
          </Field>
          <Field label="Reference" hint="As the bank shows it. Each is recorded once.">
            <Input name="reference" required maxLength={100} className="font-mono" defaultValue={values?.reference ?? ""} />
          </Field>
        </div>
        <Field label="Note" hint="Required. Shown on the statement after “Paid by bank transfer”.">
          <Textarea
            name="note"
            rows={2}
            required
            maxLength={500}
            placeholder="e.g. Prepayment for October, invoice INV-0042"
            defaultValue={values?.note ?? ""}
          />
        </Field>
        <Field
          label="Confirm"
          hint={
            <>
              Type the workspace's slug (<span className="font-mono text-muted">{workspace}</span>) to record it.
            </>
          }
        >
          <Input name="confirmation" required placeholder={workspace} className="font-mono" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="lavender">
            <Landmark size={14} />
            Record the payment
          </Button>
        </div>
      </form>
    </Section>
  );
}

// --- Credit -------------------------------------------------------------------

/** A radio drawn as one button of a segmented row; still a plain radio without CSS. */
function Segment({ name, value, checked, children }: { name: string; value: string; checked: boolean; children: ReactNode }) {
  return (
    <label className="flex-1 cursor-pointer border-r border-line px-3 py-1.5 text-center text-sm whitespace-nowrap text-muted transition-colors last:border-r-0 hover:bg-raised hover:text-fg has-checked:bg-merged has-checked:font-medium has-checked:text-bg has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-merged">
      <input type="radio" name={name} value={value} defaultChecked={checked} className="sr-only" />
      {children}
    </label>
  );
}

/**
 * Credit for a workspace: a preset amount or a custom one, a kind, an
 * expiry, and a note. Fields that belong to one choice (the custom amount,
 * a refund's details, an expiry date) show only for it, by CSS alone
 * (`.credit-form` in app.css); without `:has()` every field shows and the
 * ones that do not apply are ignored. Over $100 the slug is typed out too.
 */
export function CreditForm({ workspaces, pathname, error }: { workspaces: string[]; pathname: string; error: SectionError }) {
  const values = error?.values;
  const single = workspaces.length === 1 ? workspaces[0] : null;
  const preset = values?.preset ?? "25";
  const kind = values?.kind ?? "promotional";
  const expires = values?.expires ?? "none";
  return (
    <Section
      id="credit"
      title="Give credit"
      description="Added to the balance at once and spent before anything paid in advance. The owners are emailed."
    >
      {workspaces.length === 0 ? (
        <p className="text-sm text-muted">Add a workspace first: credit goes to a workspace.</p>
      ) : (
        <form method="post" action={`${pathname}#credit`} className="credit-form space-y-4">
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
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-muted">Amount</legend>
            <div className="flex flex-wrap overflow-hidden rounded-md border border-line bg-bg">
              {CREDIT_PRESETS.map((dollars) => (
                <Segment key={dollars} name="preset" value={String(dollars)} checked={preset === String(dollars)}>
                  ${dollars}
                </Segment>
              ))}
              <Segment name="preset" value="custom" checked={preset === "custom"}>
                Custom
              </Segment>
            </div>
          </fieldset>
          <div className="when-custom space-y-4">
            <Field label="Custom amount $" hint="Up to $10,000 at a time.">
              <Input name="amount" inputMode="decimal" placeholder="15.00" defaultValue={values?.amount ?? ""} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-muted">Kind</legend>
            <div className="grid gap-2">
              {CREDIT_KINDS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer gap-2.5 rounded-md border border-line bg-bg px-3 py-2.5 transition-colors hover:border-line-strong has-checked:border-merged/60 has-checked:bg-merged/8"
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
          <div className="when-refund">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field label="Refund for" hint="Refunds only. On the statement and in the email.">
                <Input name="refundFor" maxLength={200} placeholder="the failed runs on Oct 2" defaultValue={values?.refundFor ?? ""} />
              </Field>
              <Field label="Day refunded" hint="Comes off what was paid that day. Blank: today.">
                <Input type="date" name="refundDay" defaultValue={values?.refundDay ?? ""} />
              </Field>
            </div>
          </div>
          <fieldset className="when-not-refund">
            <legend className="mb-1.5 text-sm font-medium text-muted">Expires</legend>
            <div className="flex flex-wrap overflow-hidden rounded-md border border-line bg-bg">
              {EXPIRIES.map((option) => (
                <Segment key={option.value} name="expires" value={option.value} checked={expires === option.value}>
                  {option.label}
                </Segment>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-faint">Unused credit stops counting then. A refund never expires.</p>
          </fieldset>
          <div className="when-date when-not-refund">
            <Field label="Expires on" hint="At the end of the day, UTC.">
              <Input type="date" name="expiresOn" defaultValue={values?.expiresOn ?? ""} />
            </Field>
          </div>
          <Field label="Note" hint="Required. On the workspace's statement and in the owners' email.">
            <Textarea name="note" rows={2} required maxLength={500} placeholder="e.g. Welcome to g1t" defaultValue={values?.note ?? ""} />
          </Field>
          <div className="when-custom">
            <Field
              label="Confirm"
              hint={
                <>
                  Over $100 only: type the workspace's slug{single && <> (<span className="font-mono text-muted">{single}</span>)</>}.
                </>
              }
            >
              <Input name="confirmation" placeholder={single ?? "workspace-slug"} className="font-mono" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="lavender">
              <Gift size={14} />
              Give credit
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

const GRANT_STATE: Record<CreditGrant["state"], { label: string; tone: "mint" | "plain" | "warn" | "danger" }> = {
  open: { label: "Open", tone: "mint" },
  used: { label: "Used", tone: "plain" },
  expired: { label: "Expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "danger" },
};

/**
 * Credits g1t gave, newest first: amount, kind, note, who, when, used,
 * left and expiry, and on an open one a form to take back what is left.
 */
export function CreditList({
  grants,
  pathname,
  error,
  showWorkspace = false,
}: {
  grants: CreditGrant[];
  pathname: string;
  error?: SectionError;
  showWorkspace?: boolean;
}) {
  if (grants.length === 0) return <EmptyState title="No credits given">Credit given from sudo shows here, with what is left of it.</EmptyState>;
  return (
    <ul className="-my-1 divide-y divide-line">
      {grants.map((grant) => {
        const state = GRANT_STATE[grant.state];
        const failed = error && error.values?.id === grant.id ? error.error : null;
        return (
          <li key={grant.id} id={`grant-${grant.id}`} className="scroll-mt-20 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular font-semibold">{usd(grant.amountMicros, { cents: true })}</span>
              <Badge tone="lavender">{kindLabel(grant.kind)}</Badge>
              <Badge tone={state.tone}>{state.label}</Badge>
              {showWorkspace && (
                <Link to={`/workspaces/${encodeURIComponent(grant.workspace)}#credits`} className="font-mono text-xs text-merged hover:underline">
                  {grant.workspace}
                </Link>
              )}
            </div>
            <p className="tabular mt-1 text-sm text-fg-soft">
              Used {usd(grant.usedMicros, { cents: true })} · left {usd(grant.leftMicros, { cents: true })}
              {grant.expiresAt ? (
                <>
                  {" "}
                  · {grant.state === "expired" ? "expired" : "expires"} <When at={grant.expiresAt} />
                </>
              ) : grant.kind === "refund" ? (
                " · never expires"
              ) : (
                " · no expiry"
              )}
            </p>
            <p className="mt-0.5 text-sm break-words">
              {grant.kind === "refund" && grant.refundFor && <span className="text-muted">For {grant.refundFor}{grant.refundDay ? ` (${grant.refundDay})` : ""}: </span>}
              {grant.note}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 font-mono text-xs text-faint">
              <UserRound size={11} />
              {grant.createdBy} · <When at={grant.createdAt} time />
            </p>
            {grant.closedAt && grant.state === "revoked" && (
              <p className="mt-1 text-xs text-muted">
                {usd(grant.closedMicros ?? 0, { cents: true })} taken back by {grant.closedBy} on <When at={grant.closedAt} />
                {grant.closedNote ? `: “${grant.closedNote}”` : ""}
              </p>
            )}
            {grant.closedAt && grant.state === "expired" && (grant.closedMicros ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted">{usd(grant.closedMicros ?? 0, { cents: true })} unused when it expired.</p>
            )}
            {grant.state === "open" && (
              <details className="mt-2" open={failed != null}>
                <summary className="cursor-pointer text-xs text-danger hover:underline">Revoke unused</summary>
                <form method="post" action={`${pathname}#grant-${grant.id}`} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="intent" value="revoke-credit" />
                  <input type="hidden" name="id" value={grant.id} />
                  {showWorkspace && <input type="hidden" name="workspace" value={grant.workspace} />}
                  <Field label="Why" hint={`Takes ${usd(grant.leftMicros, { cents: true })} off the balance. Kept in the audit log.`} className="flex-1">
                    <Input name="reason" required maxLength={500} placeholder="e.g. Given to the wrong workspace" defaultValue={failed ? (error?.values?.reason ?? "") : ""} />
                  </Field>
                  <Button type="submit" variant="danger" className="shrink-0">
                    Revoke {usd(grant.leftMicros, { cents: true })}
                  </Button>
                </form>
                {failed && (
                  <div className="mt-2">
                    <Notice tone="error">{failed}</Notice>
                  </div>
                )}
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A workspace's credits from g1t: what is left to spend, and each grant. */
export function CreditsSection({
  credits,
  unavailable,
  pathname,
  error,
}: {
  credits: Credits | null;
  unavailable: string | null;
  pathname: string;
  error: SectionError;
}) {
  return (
    <Section
      id="credits"
      title="Credits"
      description={
        credits
          ? `${usd(credits.leftMicros, { cents: true })} left to spend. Spent before anything paid in advance, the soonest-expiring first.`
          : "Credits from g1t, with what is left of each."
      }
    >
      {unavailable ? <Notice tone="warn">Billing did not answer for credits: {unavailable}</Notice> : <CreditList grants={credits?.grants ?? []} pathname={pathname} error={error} />}
    </Section>
  );
}

// --- Reset (testing) -----------------------------------------------------------

/**
 * Wipes a test workspace's billing so it starts again as a new customer.
 * Only while billing runs on Stripe's test key; billing refuses 100% discounts and
 * enterprise workspaces. The workspace, its members and repositories stay.
 */
export function ResetBillingForm({ workspace, pathname, error }: { workspace: string; pathname: string; error: SectionError }) {
  const values = error?.values;
  return (
    <Section
      id="reset"
      title="Reset billing (testing)"
      description="Wipes this workspace's billing: its ledger and balance, plan, limits, trial, invoices, holds, signals and cost rows. The workspace, its members and its repositories stay. Only while billing is on Stripe's test key."
    >
      <form method="post" action={`${pathname}#reset`} className="space-y-4">
        <input type="hidden" name="intent" value="reset" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <Field label="Why" hint="Required. Kept in the audit log.">
          <Textarea name="note" rows={2} required maxLength={500} placeholder="e.g. Test workspace, starting the customer walk-through again" defaultValue={values?.note ?? ""} />
        </Field>
        <Field
          label="Confirm"
          hint={
            <>
              Type the workspace's slug (<span className="font-mono text-muted">{workspace}</span>) to wipe its billing. It cannot be undone.
            </>
          }
        >
          <Input name="confirmation" required placeholder={workspace} className="font-mono" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="danger">
            <RotateCcw size={14} />
            Reset billing
          </Button>
        </div>
      </form>
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
                      <Badge tone={entry.creditKind ? "lavender" : entry.amountMicros > 0 ? "mint" : "plain"}>
                        {entry.creditKind ? `Credit · ${kindLabel(entry.creditKind)}` : (ENTRY_KIND[entry.kind] ?? entry.kind)}
                      </Badge>
                      {showWorkspace && entry.workspace && (
                        <Link to={`/workspaces/${encodeURIComponent(entry.workspace)}`} className="font-mono text-xs text-merged hover:underline">
                          {entry.workspace}
                        </Link>
                      )}
                      <span className="break-words">{entry.description}</span>
                      {givenParts(entry).map((part) => (
                        <Badge key={part.label} tone="lavender">
                          Given · {part.label} {usd(part.micros)}
                        </Badge>
                      ))}
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
                <span className="font-medium text-merged">{actionLabel(entry.action)}</span>
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
