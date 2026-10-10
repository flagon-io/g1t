/**
 * Billing settings' newer sections: the plan at a glance with the upcoming
 * invoice, prepaid AI credit with auto-reload, the budget's alerts, the
 * payment method (kept on Stripe), add-ons, invoice details and the
 * invoices. Cards and payment methods are handled on Stripe's own page:
 * g1t has no card form. Each form posts to the billing route's action with
 * an `intent`.
 */
import { ArrowUpRight, Bell, Bot, CreditCard, FileText, Mail, Plus, ReceiptText, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, Link } from "react-router";

import type { AiCredit, BillingDetails, FeatureState, Limit, UsageReport } from "@g1t/contracts";

import { PLUS_TAX, type PlanStatus, cardFeeCents, dollars, feeAndTax, wholeDollars } from "../lib/billing";
import { money } from "../lib/usage";
import { Card } from "./billing";
import { ErrorText, SubmitButton } from "./ui";
import { SelectField } from "./ui/select";
import { Skeleton } from "./ui/skeleton";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

function Dollar({ name, defaultValue, label, className }: { name: string; defaultValue?: string; label: string; className?: string }) {
  return (
    <span className={`flex items-center rounded-md border border-line bg-bg px-2 focus-within:border-accent-dim ${className ?? ""}`}>
      <span className="text-sm text-muted">$</span>
      <input
        name={name}
        inputMode="decimal"
        aria-label={label}
        defaultValue={defaultValue}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        className="w-20 bg-transparent px-1 py-1.5 text-sm tabular-nums outline-none"
      />
    </span>
  );
}

function whole(micros: number): string {
  return String(Math.round(micros / 1_000_000));
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
  staff,
  error,
}: {
  slug: string;
  state: FeatureState | null;
  status: PlanStatus;
  details: BillingDetails | null;
  report: UsageReport | null;
  owner: boolean;
  enabled: boolean;
  staff: boolean;
  error?: string;
}) {
  const plan = state?.plan;
  const subscription = state?.subscription ?? null;
  const on = ["paid", "canceling", "comped", "enterprise", "past_due"].includes(status.kind);
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
          <span className={`rounded-full px-2 py-0.5 text-xs ${on && status.kind !== "past_due" && status.kind !== "canceling" ? "bg-success/15 text-success" : status.kind === "free" || status.kind === "trial" ? "border border-line text-muted" : "bg-warn/15 text-warn"}`}>
            {status.label}
            {status.kind === "canceling" && subscription?.periodEnd ? `, ${new Date(subscription.periodEnd).toLocaleDateString()}` : ""}
          </span>
        </>
      }
      about={
        on
          ? `Billing period ${period}. One price for the workspace, never per seat.`
          : "The forge is free: repositories, issues, pull requests, reviews, search and the audit log. Agents, checks, workflows and deployments need the plan, or the trial."
      }
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">${((plan?.monthlyCents ?? 2000) / 100).toFixed(0)}</span>
          <span className="text-sm text-muted"> / month</span>
          <span className="block text-xs text-faint">with {wholeDollars(report?.included?.of ?? 10_000_000)} of usage included</span>
          {status.kind !== "comped" && status.kind !== "enterprise" && (
            <span className="block text-xs text-faint">
              {plan?.cardFeeCents ? `+ ${dollars(plan.cardFeeCents * 10_000)} card processing fee, ` : ""}
              {plan?.cardFeeCents ? PLUS_TAX : "Plus tax where it applies"}
            </span>
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
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (report.included.used / Math.max(1, report.included.of)) * 100)}%` }} />
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
          <p className="text-xs text-faint">Including add-ons and usage, from g1t's ledger{upcoming ? `; the month closes ${new Date(upcoming.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}.</p>
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
        <Link to={`/${slug}/-/usage`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg">
          <FileText size={14} /> Usage
        </Link>
        <a href="#invoices" className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg">
          <ReceiptText size={14} /> Invoices
        </a>
        {owner && enabled && (
          <Form method="post" className="contents">
            <input type="hidden" name="feature" value="plan" />
            {status.kind === "free" || status.kind === "trial" ? (
              <SubmitButton variant="accent" name="intent" value="subscribe" pending="Opening Stripe…">
                <CreditCard size={14} />
                Start the g1t plan
              </SubmitButton>
            ) : status.kind === "canceling" ? (
              <SubmitButton variant="accent" name="intent" value="resume" pending="Saving…">
                Keep the plan
              </SubmitButton>
            ) : status.kind === "paid" && subscription ? (
              <SubmitButton variant="quiet" name="intent" value="cancel" pending="Saving…">
                Downgrade to free at the period's end
              </SubmitButton>
            ) : null}
          </Form>
        )}
        <a href="mailto:sales@g1t.sh?subject=Custom%20needs" className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <Mail size={14} /> Custom needs? Contact us
        </a>
      </div>
      {staff && enabled && (status.kind === "free" || status.kind === "trial") && (
        <p className="mt-3 text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</p>
      )}
      {(status.kind === "free" || status.kind === "trial") && (
        <p className="mt-3 text-xs text-faint">
          Starting the plan gives $5 of AI credit, once. Your first month starts at a {wholeDollars(100_000_000)} limit on usage past
          what is included, so a stolen card cannot run up a bill.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- AI credit ----------------------------------------------------------------------------------

/** Prepaid AI credit: the balance, buying more, and auto-reload. */
export function AiCreditCard({ credit, owner, enabled, staff, error }: { credit: AiCredit; owner: boolean; enabled: boolean; staff: boolean; error?: string }) {
  const rate = credit.agentRateMicros;
  const fee = credit.cardFee;
  // What is chosen, so the fee shows before Stripe's page does.
  const [chosenCents, setChosenCents] = useState(2_500);
  const chosenFee = cardFeeCents(chosenCents, fee);
  const stripeFee = `Stripe's ${(fee.percentMicros / 10_000).toFixed(1)}% + ${dollars(fee.fixedCents * 10_000)}`;
  const feeText = !fee.on
    ? `${feeAndTax(0)}.`
    : chosenCents > 0
      ? `On $${(chosenCents / 100).toLocaleString("en-US")}: ${feeAndTax(chosenFee).replace(/^C/, "c")} (the fee is ${stripeFee}, its own line at checkout).`
      : `A card processing fee (${stripeFee}) is its own line at checkout, ${PLUS_TAX}.`;
  const choose = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const amount = String(data.get("amount") ?? "");
    const dollarsChosen = amount === "custom" ? Number(String(data.get("custom") ?? "").replace(/[$,\s]/g, "")) : Number(amount);
    setChosenCents(Number.isFinite(dollarsChosen) && dollarsChosen > 0 ? Math.round(dollarsChosen * 100) : 0);
  };
  return (
    <Card
      id="ai-credit"
      tone={credit.blocked ? "warn" : "plain"}
      icon={<Bot size={16} />}
      title="AI credit"
      about={
        credit.freeViaDiscount
          ? "Agent and AI Gateway usage is free for this workspace under its discount: shown at its price, then the discount."
          : credit.postpaid
            ? "This workspace's enterprise is invoiced for Agent and AI Gateway usage after use: no credit needed."
            : `Prepaid credit for Agent and AI Gateway usage, spent before anything else. Models at the provider's price${credit.modelMarkupPercent ? ` plus ${credit.modelMarkupPercent}%` : ""}, plus the agent rate${rate > 0 ? ` (${dollars(rate)} per million tokens)` : ""}. Credit expires ${credit.expiresDays === 365 ? "1 year" : `${credit.expiresDays} days`} after purchase.`
      }
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{money(credit.balanceMicros)}</span>
          <span className="block text-xs text-faint">
            {credit.givenMicros > 0 ? `${money(credit.purchasedMicros)} bought, ${money(credit.givenMicros)} from g1t` : "left"}
          </span>
        </p>
      }
    >
      {credit.blocked && (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm">
          Out of AI credit, with this month's included usage used: new runs on g1t's models wait until you buy credit or turn on
          auto-reload. Runs on your own model provider keep going.
        </p>
      )}
      {!credit.freeViaDiscount && !credit.postpaid && (
        <>
          {credit.canBuy && owner && enabled ? (
            <Form method="post" className="mt-4" onChange={(event) => choose(event.currentTarget)}>
              <input type="hidden" name="intent" value="buy-ai-credit" />
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="mb-2 text-xs text-muted">Buy AI credit</legend>
                {credit.presetsCents.map((cents) => (
                  <label key={cents} className="cursor-pointer">
                    <input type="radio" name="amount" value={String(cents / 100)} defaultChecked={cents === 2_500} className="peer sr-only" />
                    <span className="inline-block rounded-md border border-line px-3 py-1.5 text-sm tabular-nums peer-checked:border-accent peer-checked:bg-accent/10 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-dim">
                      ${cents / 100}
                    </span>
                  </label>
                ))}
                <label className="cursor-pointer">
                  <input type="radio" name="amount" value="custom" className="peer sr-only" />
                  <span className="inline-block rounded-md border border-line px-3 py-1.5 text-sm peer-checked:border-accent peer-checked:bg-accent/10">Custom</span>
                </label>
                <Dollar name="custom" label="Custom amount in dollars" />
                <SubmitButton variant="accent" match={{ intent: "buy-ai-credit" }} pending="Opening Stripe…">
                  <Plus size={14} /> Buy AI credit
                </SubmitButton>
              </fieldset>
              <p className="mt-2 text-xs text-faint">
                ${credit.minCents / 100} to ${(credit.maxCents / 100).toLocaleString("en-US")}, on Stripe's page. {feeText}
                {staff ? " Test mode: card 4242 4242 4242 4242." : ""}
              </p>
            </Form>
          ) : !credit.canBuy ? (
            <p className="mt-4 text-sm text-muted">AI credit is for workspaces on the g1t plan. Starting the plan comes with $5 of it.</p>
          ) : (
            <p className="mt-4 text-sm text-muted">An owner buys AI credit.</p>
          )}
          {credit.canBuy && <AutoReload credit={credit} owner={owner && enabled} />}
        </>
      )}
      {credit.grants.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted hover:text-fg">Purchases and grants</summary>
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {credit.grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span className="min-w-0">
                  {grant.kind === "purchased" ? "Bought" : grant.source === "upgrade" ? "For starting the plan" : "From g1t"}{" "}
                  <span className="text-faint">· {new Date(grant.createdAt).toLocaleDateString()}{grant.expiresAt ? `, expires ${new Date(grant.expiresAt).toLocaleDateString()}` : ""}</span>
                </span>
                <span className="tabular-nums">
                  {money(grant.leftMicros)} <span className="text-faint">of {money(grant.amountMicros)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function AutoReload({ credit, owner }: { credit: AiCredit; owner: boolean }) {
  const r = credit.reload;
  return (
    <div className="mt-5 rounded-lg border border-line bg-bg/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Auto-reload</p>
        <span className={`rounded-full px-2 py-0.5 text-xs ${r.enabled ? "bg-success/15 text-success" : "border border-line text-muted"}`}>{r.enabled ? "On" : "Off"}</span>
      </div>
      {r.failedAt && (
        <p className="mt-2 text-sm text-danger">
          Turned off on {new Date(r.failedAt).toLocaleDateString()}: {r.error ?? "the card was declined"}. Update the card on Stripe, then turn it on again.
        </p>
      )}
      {owner ? (
        <Form method="post" className="mt-3 space-y-3 text-sm">
          <input type="hidden" name="intent" value="ai-reload" />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="enabled" defaultChecked={r.enabled} className="accent-[var(--color-accent)]" />
            Reload from the saved card
          </label>
          <div className="flex flex-wrap items-center gap-2 text-muted">
            When AI credit falls below <Dollar name="threshold" label="Threshold in dollars" defaultValue={whole(r.thresholdMicros)} />
            reload it to <Dollar name="target" label="Target in dollars" defaultValue={whole(r.targetMicros)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-muted">
            At most <Dollar name="monthly" label="Monthly maximum in dollars" defaultValue={whole(r.monthlyMaxMicros)} /> a month
            {(r.reloadedMicros ?? 0) > 0 && <span className="text-faint">· {money(r.reloadedMicros ?? 0)} reloaded this month</span>}
          </div>
          <SubmitButton variant="quiet" match={{ intent: "ai-reload" }} pending="Saving…">
            Save auto-reload
          </SubmitButton>
          <p className="text-xs text-faint">A reload that cannot be charged turns auto-reload off and tells the owners by email.</p>
        </Form>
      ) : (
        <p className="mt-2 text-sm text-muted">
          {r.enabled ? `Below ${money(r.thresholdMicros)}, back to ${money(r.targetMicros)}, at most ${money(r.monthlyMaxMicros)} a month.` : "Off."}
        </p>
      )}
    </div>
  );
}

// --- Budget alerts --------------------------------------------------------------------------------

/** The budget's alerts, whether it pauses usage, and its webhook: beside the spend limit. */
export function BudgetAlerts({ limit, owner, error }: { limit: Limit; owner: boolean; error?: string }) {
  const levels = limit.alertLevels ?? [100, 90, 75, 50];
  const pause = limit.pauseAtLimit ?? true;
  const spent = limit.spentMicros ?? 0;
  const of = limit.spendLimitMicros;
  return (
    <Card id="budget" icon={<Bell size={16} />} title="Budget alerts" about="On usage past what the plan includes, measured against the spend limit above. Each alert is emailed to the owners once a month.">
      {of != null && (
        <div className="mt-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted">Spent this month</span>
            <span className="tabular-nums">
              {money(spent)} <span className="text-faint">of {money(of)}</span>
            </span>
          </div>
          <div className="relative mt-1.5 h-1.5 rounded-full bg-line" role="presentation">
            <div className={`h-full rounded-full ${spent >= of ? "bg-danger" : spent * 4 >= of * 3 ? "bg-warn" : "bg-success"}`} style={{ width: `${Math.min(100, (spent / Math.max(1, of)) * 100)}%` }} />
            {levels.filter((l) => l < 100).map((l) => (
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
              <label key={level} className="flex items-center gap-1.5">
                <input type="checkbox" name="alert" value={String(level)} defaultChecked={levels.includes(level)} className="accent-[var(--color-accent)]" />
                {level}%
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="pause" defaultChecked={pause} className="accent-[var(--color-accent)]" />
            Pause usage at 100%
            <span className="text-xs text-faint">Off, the budget only alerts; g1t's own limit still applies.</span>
          </label>
          <label className="block">
            <span className="block text-xs text-muted">Webhook, told of each alert (optional)</span>
            <input name="webhook" type="url" placeholder="https://hooks.example.com/g1t" defaultValue={limit.budgetWebhook ?? ""} className={`mt-1 ${FIELD} max-w-md`} />
          </label>
          <SubmitButton variant="quiet" match={{ intent: "budget" }} pending="Saving…">
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

// --- Payment method -------------------------------------------------------------------------------

export function PaymentMethodCard({ details, owner, enabled, staff, error }: { details: BillingDetails | null; owner: boolean; enabled: boolean; staff: boolean; error?: string }) {
  const method = details?.paymentMethod;
  return (
    <Card
      id="payment"
      icon={<CreditCard size={16} />}
      title="Payment method"
      about="Cards are added, removed and made the default on Stripe's billing page. g1t never sees card numbers."
      aside={
        owner && enabled ? (
          <Form method="post">
            <SubmitButton variant="quiet" name="intent" value="portal" pending="Opening Stripe…">
              Manage in Stripe
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
            <span className="text-xs text-faint">default</span>
          </p>
        ) : (
          <p className="text-muted">No payment method yet. Starting the plan or buying AI credit saves the card you pay with.</p>
        )}
        {details?.unavailable && <p className="mt-2 text-xs text-warn">{details.unavailable}</p>}
        {staff && <p className="mt-2 text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</p>}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Add-ons ------------------------------------------------------------------------------------

export function AddOns({ plan, security, owner, enabled, error }: { plan: FeatureState | null; security: FeatureState | null; owner: boolean; enabled: boolean; error?: string }) {
  const planOn = !!plan?.on;
  const rows: { key: string; name: string; about: string; price: string; on: boolean; label: string; control: ReactNode }[] = [];
  if (security) {
    const status = security.subscription?.status;
    rows.push({
      key: "security",
      name: security.plan.title,
      about: `Custom patterns, validity checks, code scanning and dependency review on private repositories. ${
        security.plan.cardFeeCents ? `Plus a ${dollars(security.plan.cardFeeCents * 10_000)} card processing fee a month, and tax where it applies.` : "Plus tax where it applies."
      }`,
      price: `$${(security.plan.monthlyCents / 100).toFixed(security.plan.monthlyCents % 100 ? 2 : 0)} / month`,
      on: security.on,
      label: security.included ? "Included" : status === "canceling" ? "Ends at the period's end" : security.on ? "On" : "Off",
      control:
        !owner || !enabled || security.included ? null : (
          <Form method="post">
            <input type="hidden" name="feature" value="security" />
            {!security.on ? (
              <SubmitButton variant="quiet" name="intent" value="subscribe" pending="Opening Stripe…">
                Turn on
              </SubmitButton>
            ) : status === "canceling" ? (
              <SubmitButton variant="quiet" name="intent" value="resume" pending="Saving…">
                Keep it on
              </SubmitButton>
            ) : (
              <SubmitButton variant="quiet" name="intent" value="cancel" pending="Saving…">
                Turn off
              </SubmitButton>
            )}
          </Form>
        ),
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
    <section id="add-ons" className="mb-6 scroll-mt-20 overflow-hidden rounded-xl border border-line bg-surface">
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

// --- Invoice details ------------------------------------------------------------------------------

const TAX_IDS: [string, string][] = [
  ["", "None"],
  ["eu_vat", "EU VAT"],
  ["gb_vat", "UK VAT"],
  ["us_ein", "US EIN"],
  ["ca_bn", "Canadian BN"],
  ["au_abn", "Australian ABN"],
  ["ch_vat", "Swiss VAT"],
  ["no_vat", "Norwegian VAT"],
  ["in_gst", "Indian GST"],
  ["jp_cn", "Japanese corporate number"],
  ["br_cnpj", "Brazilian CNPJ"],
  ["mx_rfc", "Mexican RFC"],
  ["sg_uen", "Singapore UEN"],
  ["nz_gst", "New Zealand GST"],
  ["za_vat", "South African VAT"],
];

/** What Stripe's check of a tax ID found. */
const TAX_ID_STATUS: Record<string, string> = {
  verified: "Verified by Stripe.",
  pending: "Stripe is checking it.",
  unverified: "Stripe could not verify it. Check the number.",
  unavailable: "Stripe cannot check this kind of ID.",
};

const LANGUAGES: [string, string][] = [
  ["", "Automatic"],
  ["en", "English"],
  ["en-GB", "English (UK)"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
];

export function InvoiceDetailsCard({ details, owner, enabled, error }: { details: BillingDetails | null; owner: boolean; enabled: boolean; error?: string }) {
  const a = details?.address;
  const disabled = !owner || !enabled;
  return (
    <Card
      id="details"
      icon={<ReceiptText size={16} />}
      title="Invoice details"
      about="Who invoices are for. Kept on the workspace's Stripe customer and printed on every invoice. Tax is worked out from the address."
    >
      {details?.customer && !details.taxLocation && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-sm ${details.taxAddressNeededAt ? "border-warn/40 bg-warn/5" : "border-line bg-bg/40 text-muted"}`}>
          {details.taxAddressNeededAt
            ? "Add the billing address: Stripe needs at least the country (and in the US the ZIP code) to work out tax, so g1t is not charging the card until it is here."
            : "No billing address yet. Stripe needs at least the country (and in the US the ZIP code) to work out tax before g1t charges the card."}
        </p>
      )}
      {(details?.taxExempt === "exempt" || details?.taxExempt === "reverse") && (
        <p className="mt-3 text-xs text-muted">
          {details.taxExempt === "exempt" ? "Tax exempt: no tax is added." : "Reverse charge: you account for the tax yourself, and invoices say so."}
        </p>
      )}
      <Form method="post" className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <input type="hidden" name="intent" value="details" />
        <fieldset disabled={disabled} className="contents">
          <label className="block">
            <span className="text-xs text-muted">Invoice email</span>
            <input name="email" type="email" defaultValue={details?.email ?? ""} className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Company name</span>
            <input name="name" defaultValue={details?.name ?? ""} className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-muted">Address</span>
            <input name="line1" placeholder="Street" defaultValue={a?.line1 ?? ""} className={`mt-1 ${FIELD}`} />
            <input name="line2" placeholder="Suite, floor (optional)" aria-label="Address line 2" defaultValue={a?.line2 ?? ""} className={`mt-2 ${FIELD}`} />
          </label>
          <div className="grid grid-cols-2 gap-3 sm:col-span-2 sm:grid-cols-4">
            <input name="city" placeholder="City" aria-label="City" defaultValue={a?.city ?? ""} className={FIELD} />
            <input name="state" placeholder="State or region" aria-label="State or region" defaultValue={a?.state ?? ""} className={FIELD} />
            <input name="postalCode" placeholder="Postal code" aria-label="Postal code" defaultValue={a?.postalCode ?? ""} className={FIELD} />
            <input name="country" placeholder="Country (US)" aria-label="Country, two letters" maxLength={2} defaultValue={a?.country ?? ""} className={`${FIELD} uppercase`} />
          </div>
          <label className="block">
            <span className="text-xs text-muted">Tax ID</span>
            <span className="mt-1 flex gap-2">
              <SelectField
                name="taxIdType"
                defaultValue={details?.taxIdType ?? ""}
                aria-label="Kind of tax ID"
                className="h-auto w-auto shrink-0 px-2.5 py-1.5"
                options={TAX_IDS.map(([value, label]) => ({ value, label }))}
              />
              <input name="taxId" defaultValue={details?.taxId ?? ""} aria-label="Tax ID" className={FIELD} />
            </span>
            {details?.taxId && details.taxIdStatus && (
              <span className="mt-1 block text-xs text-faint">{TAX_ID_STATUS[details.taxIdStatus] ?? `Stripe's check: ${details.taxIdStatus}`}</span>
            )}
          </label>
          <label className="block">
            <span className="text-xs text-muted">Purchase order</span>
            <input name="poNumber" defaultValue={details?.poNumber ?? ""} className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Invoice language</span>
            <SelectField
              name="language"
              defaultValue={details?.language ?? ""}
              aria-label="Invoice language"
              className="mt-1 h-auto px-2.5 py-1.5"
              options={LANGUAGES.map(([value, label]) => ({ value, label }))}
            />
          </label>
          {!disabled && (
            <div className="flex items-end">
              <SubmitButton variant="quiet" match={{ intent: "details" }} pending="Saving…">
                Save invoice details
              </SubmitButton>
            </div>
          )}
        </fieldset>
      </Form>
      {!owner && <p className="mt-3 text-xs text-faint">An owner changes these.</p>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Invoices ---------------------------------------------------------------------------------------

const STATUS: Record<string, string> = { paid: "Paid", open: "Open", void: "Void", uncollectible: "Uncollectible", draft: "Draft" };

export function InvoicesCard({ details }: { details: BillingDetails | null }) {
  const invoices = details?.invoices ?? [];
  return (
    <section id="invoices" className="mb-6 scroll-mt-20 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="px-5 pt-5">
        <h2 className="font-medium">Invoices</h2>
        <p className="mt-1 text-sm text-muted">The plan, add-ons, AI credit and each month's usage, as Stripe sent them.</p>
      </div>
      {invoices.length === 0 ? (
        <p className="px-5 py-5 text-sm text-faint">No invoices yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
              <span className="w-24 shrink-0 text-muted tabular-nums">{new Date(invoice.createdAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</span>
              <span className="min-w-0 flex-1 truncate">{invoice.description ?? invoice.number ?? invoice.id}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${invoice.status === "paid" ? "bg-success/15 text-success" : invoice.status === "open" ? "bg-warn/15 text-warn" : "border border-line text-muted"}`}>
                {STATUS[invoice.status] ?? invoice.status}
              </span>
              <span className="w-20 text-right tabular-nums">{money(invoice.totalCents * 10_000)}</span>
              <span className="flex gap-3 text-xs">
                {invoice.hostedUrl && (
                  <a href={invoice.hostedUrl} className="text-muted hover:text-fg">
                    View
                  </a>
                )}
                {invoice.pdfUrl && (
                  <a href={invoice.pdfUrl} className="text-muted hover:text-fg">
                    PDF
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Stripe's sections while Stripe is asked: the same shapes. */
export function StripeSkeleton() {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        Loading from Stripe…
      </span>
      {[5.5, 14, 8].map((rem, i) => (
        <div key={i} className="mb-6 rounded-xl border border-line bg-surface p-5" aria-hidden="true" style={{ minHeight: `${rem}rem` }}>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-3 h-3 w-72 max-w-full" />
          <Skeleton className="mt-4 h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
