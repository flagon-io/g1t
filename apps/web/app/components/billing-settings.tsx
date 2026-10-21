/**
 * Billing settings' newer sections: the plan at a glance with the upcoming
 * invoice, the budget's alerts, add-ons, and Billing on Stripe. The card,
 * billing address, tax IDs, invoices and receipts, and ending the plan, are
 * all managed on Stripe's own billing page (the customer portal): g1t has
 * no form for any of them. Each form posts to the billing route's action
 * with an `intent`.
 */
import { ArrowUpRight, Bell, CreditCard, FileText, Mail, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import type { BillingDetails, ComplimentaryMonth, FeatureState, Limit, UsageReport } from "@g1t/contracts";

import type { PlanStatus } from "../lib/billing";
import { money, wholeDollars } from "../lib/money";
import { Card } from "./billing";
import { ErrorText, SubmitButton } from "./ui";
import { Checkbox } from "./ui/checkbox";
import { Skeleton } from "./ui/skeleton";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

// --- Complimentary ------------------------------------------------------------------------------

/**
 * A complimentary enrollment's month: the allowance g1t gives, what is used,
 * metered and held against it, what is left and when it starts again. Past
 * it, new work that costs money stops: nothing is charged, card or not. An
 * owner can start the plan on the same billing from here.
 */
export function ComplimentaryCard({ month, owner, enabled, error }: { month: ComplimentaryMonth; owner: boolean; enabled: boolean; error?: string }) {
  const taken = month.usedMicros + (month.pendingMicros ?? 0) + (month.heldMicros ?? 0);
  const resets = new Date(month.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const charged = Boolean(month.chargePastAllowance);
  const used = month.unlimited ? 0 : Math.min(100, (taken / Math.max(1, month.allowanceMicros)) * 100);
  return (
    <Card
      id="complimentary"
      tone={!month.unlimited && month.remainingMicros <= 0 ? "warn" : "accent"}
      icon={<Sparkles size={16} />}
      title="Complimentary allowance"
      about={
        charged
          ? `Usage at its ordinary price, paid by g1t up to the allowance each calendar month (UTC). Past it, usage is charged to this workspace's card at the same prices, up to your spend limit. Unused allowance does not carry over.`
          : `Usage at its ordinary price, paid by g1t up to the allowance each calendar month (UTC). Past it, new work that costs money stops until ${resets}; nothing is ever charged for it, and unused allowance does not carry over.`
      }
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{month.unlimited ? "Unlimited" : money(month.allowanceMicros)}</span>
          {!month.unlimited && <span className="text-sm text-muted"> / month</span>}
          <span className="block text-xs text-faint">{month.feeCents ? `Fee ${money(month.feeCents * 10_000)} a month, invoiced` : "No monthly fee"}</span>
        </p>
      }
    >
      {!month.unlimited && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
            <div className={`h-full rounded-full ${month.remainingMicros <= 0 ? "bg-warn" : "bg-accent"}`} style={{ width: `${used}%` }} />
          </div>
        </div>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-faint">Used</dt>
          <dd className="tabular-nums">{money(month.usedMicros)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Metered, not billed yet</dt>
          <dd className="tabular-nums">{money((month.pendingMicros ?? 0) + (month.heldMicros ?? 0))}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Remaining</dt>
          <dd className="tabular-nums">{month.unlimited ? "Unlimited" : money(month.remainingMicros)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Starts again</dt>
          <dd>{resets}</dd>
        </div>
      </dl>
      {charged && !month.hasCard && (
        <p className="mt-4 text-sm text-muted">
          No card yet: past the allowance, work stops until one is added.{" "}
          {owner && enabled && (
            <Form method="post" className="inline">
              <SubmitButton variant="outline" name="intent" value="card-check" pending="Opening Stripe…">
                <CreditCard size={14} />
                Add a card
              </SubmitButton>
            </Form>
          )}
        </p>
      )}
      {owner && enabled && !month.unlimited && (
        <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
          <SubmitButton variant="outline" name="intent" value="convert" pending="Starting the plan…">
            <CreditCard size={14} />
            Start the g1t plan instead
          </SubmitButton>
          <span className="text-xs text-faint">
            $21 a month with usage past what is included charged, on this workspace's billing. Nothing changes until the first payment goes through.
          </span>
        </Form>
      )}
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}

// --- The plan ---------------------------------------------------------------------------------

/**
 * The plan at a glance: its name and standing, the billing period, the
 * included usage, and the upcoming invoice, from g1t's own ledger.
 */
export function PlanSummary({
  slug,
  state,
  status,
  details,
  report,
  owner,
  enabled,
  live,
  staff,
  firstMonthMicros,
  error,
}: {
  slug: string;
  state: FeatureState | null;
  status: PlanStatus;
  details: BillingDetails | null;
  report: UsageReport | null;
  owner: boolean;
  enabled: boolean;
  /** False while Stripe is in test mode, where cards are not real. */
  live: boolean;
  staff: boolean;
  /** The first month's limit on usage not yet paid for, from the price book. */
  firstMonthMicros?: number | null;
  error?: string;
}) {
  const plan = state?.plan;
  const subscription = state?.subscription ?? null;
  const on = ["paid", "canceling", "comped", "enterprise", "past_due", "complimentary"].includes(status.kind);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const period = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  const upcoming = details?.upcoming;
  return (
    <Card
      id="plan"
      tone={status.kind === "past_due" || status.kind === "canceling" ? "warn" : on ? "accent" : "plain"}
      icon={<Sparkles size={16} />}
      title={
        <>
          {plan?.title ?? "g1t"}
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${on && status.kind !== "past_due" && status.kind !== "canceling" ? "bg-success/15 text-success" : status.kind === "free" || status.kind === "trial" ? "border border-line text-muted" : "bg-warn/15 text-warn"}`}
          >
            {status.kind === "canceling" && subscription?.periodEnd ? `Ends on ${endsOn(subscription.periodEnd)}` : status.label}
          </span>
        </>
      }
      about={
        on
          ? `Usage month ${period}${subscription?.periodEnd ? `; the plan renews ${endsOn(subscription.periodEnd)}` : ""}. One price for the workspace, never per seat.`
          : "The forge is free: repositories, work items, pull requests, reviews, search and the audit log. Checks, workflows and deployments need the plan, or the trial."
      }
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">${((plan?.monthlyCents ?? 2100) / 100).toFixed(0)}</span>
          <span className="text-sm text-muted"> / month</span>
          <span className="block text-xs text-faint">with {wholeDollars(report?.included?.of ?? 10_000_000)} of usage included</span>
          {status.kind !== "comped" && status.kind !== "enterprise" && status.kind !== "complimentary" && (
            <span className="block text-xs text-faint">Plus tax where it applies</span>
          )}
        </p>
      }
    >
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {report?.included ? (
          <div className="rounded-lg border border-line bg-bg/40 p-3">
            <p className="flex justify-between text-sm">
              <span className="text-muted">Included usage</span>
              <span className="tabular-nums">
                {money(report.included.used)} <span className="text-faint">/ {money(report.included.of)}</span>
              </span>
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, (report.included.used / Math.max(1, report.included.of)) * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-faint">Used first; starts again on the 1st. Unused usage does not carry over.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-bg/40 p-3 text-sm">
            <p className="text-muted">Usage at price this month</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{report ? money(report.totals.priceMicros) : "—"}</p>
            {(report?.discountPercent ?? 0) > 0 && report && (
              <p className="text-xs text-faint">
                Discount ({report.discountPercent}%) −{money(report.totals.discountMicros)} · charged {money(report.totals.chargedMicros)}
              </p>
            )}
          </div>
        )}
        <div className="rounded-lg border border-line bg-bg/40 p-3 text-sm">
          <p className="flex justify-between">
            <span className="text-muted">Upcoming invoice</span>
            <span className="text-lg font-semibold tabular-nums">{upcoming ? money(upcoming.totalMicros) : "—"}</span>
          </p>
          <p className="text-xs text-faint">
            Including add-ons and usage, from g1t's ledger
            {upcoming
              ? `; the month closes ${new Date(upcoming.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
              : ""}
            .
          </p>
          {upcoming && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs text-muted hover:text-fg">View upcoming invoice</summary>
              <dl className="mt-1.5 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt className="text-muted">Plan and add-ons</dt>
                  <dd className="tabular-nums">{money(upcoming.subscriptionsMicros)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Usage owed, after included usage, credit and discount</dt>
                  <dd className="tabular-nums">{money(upcoming.usageMicros)}</dd>
                </div>
              </dl>
            </details>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          to={`/${slug}/-/usage`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg"
        >
          <FileText size={14} /> Usage
        </Link>
        {owner && enabled && (status.kind === "free" || status.kind === "trial") && (
          <Form method="post" className="contents">
            <input type="hidden" name="feature" value="plan" />
            <SubmitButton variant="accent" name="intent" value="subscribe" pending="Opening Stripe…">
              <CreditCard size={14} />
              Start the g1t plan
            </SubmitButton>
          </Form>
        )}
        {owner && enabled && subscription && (status.kind === "paid" || status.kind === "canceling" || status.kind === "past_due") && (
          // Ending the plan, keeping it after all, and the card it renews on
          // are all on Stripe's billing page.
          <Form method="post" className="contents">
            <input type="hidden" name="from" value="plan" />
            <SubmitButton variant={status.kind === "paid" ? "outline" : "accent"} name="intent" value="portal" pending="Opening Stripe…">
              {status.kind === "past_due" ? <CreditCard size={14} /> : null}
              {status.kind === "past_due" ? "Update payment method" : "Manage billing"}
              <ArrowUpRight size={14} />
            </SubmitButton>
          </Form>
        )}
        <a href="mailto:sales@g1t.sh?subject=Custom%20needs" className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <Mail size={14} /> Custom needs? Contact us
        </a>
      </div>
      {owner && enabled && subscription && status.kind === "paid" && (
        <p className="mt-3 text-xs text-faint">To end the plan at the end of the period, use Manage billing. Nothing more is charged for it after that.</p>
      )}
      {status.kind === "canceling" && (
        <p className="mt-3 text-sm text-muted">
          The plan ends at the end of the period and nothing more is charged for it.{" "}
          {owner ? "To keep it, use Manage billing." : "An owner or billing manager can keep it from Manage billing."}
        </p>
      )}
      {status.kind === "past_due" && (
        <p className="mt-3 text-sm text-warn">
          The last renewal payment failed, so the plan's features are stopped until it is paid.{" "}
          {owner ? "Update the payment method, and Stripe tries the payment again." : "An owner or billing manager can update the payment method."}
        </p>
      )}
      {staff && enabled && !live && (status.kind === "free" || status.kind === "trial") && (
        <p className="mt-3 text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</p>
      )}
      {(status.kind === "free" || status.kind === "trial") && (
        <p className="mt-3 text-xs text-faint">
          In its first month on the plan, a workspace can owe at most {wholeDollars(firstMonthMicros ?? 100_000_000)} of usage not yet paid for, past what is
          included, so a stolen card cannot run up a bill. Work waits at whichever comes first: that limit or your spend limit. After the first month, the limit
          grows as payments clear.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

/** A plan's last day as people read it: "Nov 12, 2026". */
export function endsOn(periodEnd: string): string {
  return new Date(periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// --- Budget alerts --------------------------------------------------------------------------------

/** The budget's alerts, whether it pauses usage, and its webhook: beside the spend limit. */
export function BudgetAlerts({ limit, owner, error }: { limit: Limit; owner: boolean; error?: string }) {
  const levels = limit.alertLevels ?? [100, 90, 75, 50];
  const pause = limit.pauseAtLimit ?? true;
  const spent = limit.spentMicros ?? 0;
  const of = limit.spendLimitMicros;
  return (
    <Card
      id="budget"
      icon={<Bell size={16} />}
      title="Budget alerts"
      about="On usage past what the plan includes, measured against the spend limit above. Each alert is emailed to the owners once a month."
    >
      {of != null && (
        <div className="mt-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted">Spent this month</span>
            <span className="tabular-nums">
              {money(spent)} <span className="text-faint">of {money(of)}</span>
            </span>
          </div>
          <div className="relative mt-1.5 h-1.5 rounded-full bg-line" role="presentation">
            <div
              className={`h-full rounded-full ${spent >= of ? "bg-danger" : spent * 4 >= of * 3 ? "bg-warn" : "bg-success"}`}
              style={{ width: `${Math.min(100, (spent / Math.max(1, of)) * 100)}%` }}
            />
            {levels
              .filter((l) => l < 100)
              .map((l) => (
                <span key={l} className="absolute -top-0.5 h-2.5 w-px bg-fg/40" style={{ left: `${l}%` }} />
              ))}
          </div>
        </div>
      )}
      {owner ? (
        <Form method="post" className="mt-4 space-y-3 text-sm">
          <input type="hidden" name="intent" value="budget" />
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="mb-1.5 text-xs text-muted">Alert at</legend>
            {[50, 75, 90, 100].map((level) => (
              <label key={level} className="flex cursor-pointer items-center gap-1.5 tabular-nums">
                <Checkbox name="alert" value={String(level)} defaultChecked={levels.includes(level)} />
                {level}%
              </label>
            ))}
          </fieldset>
          <label className="flex cursor-pointer flex-wrap items-center gap-2">
            <Checkbox name="pause" defaultChecked={pause} />
            Pause usage at 100%
            <span className="text-xs text-faint">Off, the budget only alerts; g1t's own limit still applies.</span>
          </label>
          <label className="block">
            <span className="block text-xs text-muted">Webhook, told of each alert (optional)</span>
            <input
              name="webhook"
              type="url"
              placeholder="https://hooks.example.com/g1t"
              defaultValue={limit.budgetWebhook ?? ""}
              className={`mt-1 ${FIELD} max-w-md`}
            />
          </label>
          <SubmitButton variant="outline" match={{ intent: "budget" }} pending="Saving…">
            Save alerts
          </SubmitButton>
        </Form>
      ) : (
        <p className="mt-3 text-sm text-muted">
          Alerts at {levels.map((l) => `${l}%`).join(", ") || "none"}; usage {pause ? "pauses" : "does not pause"} at 100%.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Billing on Stripe ---------------------------------------------------------------------------

/**
 * Billing on Stripe: the saved card, read-only, and one way to Stripe's
 * billing page, where the card, the billing address, tax IDs, invoices and
 * receipts are managed. Owners and billing managers only.
 */
export function BillingOnStripeCard({
  details,
  enabled,
  live,
  staff,
  error,
}: {
  details: BillingDetails | null;
  enabled: boolean;
  /** False while Stripe is in test mode, where cards are not real. */
  live: boolean;
  staff: boolean;
  error?: string;
}) {
  const method = details?.paymentMethod;
  return (
    <Card
      id="stripe"
      icon={<CreditCard size={16} />}
      title="Billing on Stripe"
      about="Your card, billing address, tax IDs, invoices and receipts are kept on Stripe's billing page. g1t never sees card numbers."
      aside={
        enabled ? (
          <Form method="post">
            <SubmitButton variant="outline" name="intent" value="portal" pending="Opening Stripe…">
              Manage billing
              <ArrowUpRight size={14} />
            </SubmitButton>
          </Form>
        ) : null
      }
    >
      <div className="mt-3 text-sm">
        {method ? (
          <p className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-line px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted">{method.brand ?? method.kind}</span>
            {method.last4 && (
              <span>
                ending <span className="font-mono">{method.last4}</span>
              </span>
            )}
            {method.expMonth && method.expYear && (
              <span className="text-muted">
                · expires {String(method.expMonth).padStart(2, "0")}/{method.expYear}
              </span>
            )}
          </p>
        ) : (
          <p className="text-muted">No card yet. Starting the plan saves the card you pay with.</p>
        )}
        {details?.unavailable && <p className="mt-2 text-xs text-warn">{details.unavailable}</p>}
        {staff && !live && <p className="mt-2 text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</p>}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Add-ons ------------------------------------------------------------------------------------

export function AddOns({ plan, security, error }: { plan: FeatureState | null; security: FeatureState | null; error?: string }) {
  const planOn = !!plan?.on;
  const rows: { key: string; name: string; about: string; price: string; on: boolean; label: string; control: ReactNode }[] = [];
  if (security) {
    rows.push({
      key: "security",
      name: security.plan.title,
      about:
        "Custom patterns, validity checks, code scanning and dependency review on private repositories. No price of its own: scans are charged at cost plus 20%.",
      price: "With the plan",
      on: security.on,
      label: security.on ? "On" : "Needs the plan",
      control: null,
    });
  }
  rows.push({
    key: "deployments",
    name: "Production deployments",
    about: "Previews per pull request and production on g1t.page, metered at cost plus 20%.",
    price: "With the plan",
    on: planOn,
    label: planOn ? "On" : "Needs the plan",
    control: null,
  });
  return (
    <section id="add-ons" className="mb-6 scroll-mt-[calc(var(--topbar-h)+1rem)] overflow-hidden rounded-xl border border-line bg-surface">
      <h2 className="px-5 pt-5 font-medium">Add-ons</h2>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
            <div className="min-w-0 flex-1 basis-60">
              <p className="font-medium">{row.name}</p>
              <p className="text-xs text-muted">{row.about}</p>
            </div>
            <span className="tabular-nums text-muted">{row.price}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${row.on ? "bg-success/15 text-success" : "border border-line text-muted"}`}>{row.label}</span>
            {row.control}
          </li>
        ))}
      </ul>
      {error && (
        <div className="px-5 pb-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </section>
  );
}

/** Billing on Stripe while Stripe is asked: the same shape. */
export function StripeSkeleton() {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Loading from Stripe…
      </span>
      {[5.5].map((rem, i) => (
        <div key={i} className="mb-6 rounded-xl border border-line bg-surface p-5" aria-hidden="true" style={{ minHeight: `${rem}rem` }}>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-3 h-3 w-72 max-w-full" />
          <Skeleton className="mt-4 h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
