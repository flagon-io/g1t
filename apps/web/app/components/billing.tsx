/**
 * The billing page's sections: the spend-spike banner (also in the app
 * shell), alerts, the g1t plan, the trial, the spend limit and its range,
 * Raise my limit, credits from g1t, Prepay, the run and issue caps, and "Spent more than you
 * meant to?". Each posts to the billing route's action with an `intent`.
 */
import { ArrowUpRight, CreditCard, Gauge, Gift, Landmark, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Form } from "react-router";

import type { Credits, Entitlements, FeatureState, Limit, LimitRequest, MeterUsage, UsageAlert } from "@g1t/contracts";

import {
  CAPS,
  CREDIT_KIND,
  PLUS_TAX,
  PREPAY,
  type PlanStatus,
  alertText,
  alertTone,
  cardFeeCents,
  creditLine,
  dollars,
  gigabytes,
  requestStatus,
  share,
  shortDay,
  shownMeters,
  spendRange,
  wholeDollars,
} from "../lib/billing";
import { ErrorText, SubmitButton } from "./ui";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";

/** An error the action returned, for the section it belongs to. */
export type SectionError = { section: string; error: string } | null | undefined;

function errorFor(error: SectionError, section: string): string | undefined {
  return error && error.section === section ? error.error : undefined;
}

const CONTROL =
  "rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm tabular-nums outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

/** A dollar amount field: a `$` and a number. */
function DollarInput({ name, defaultValue, placeholder, label }: { name: string; defaultValue?: string; placeholder?: string; label: string }) {
  return (
    <span className="flex items-center rounded-md border border-line bg-bg px-2 focus-within:border-accent-dim">
      <span className="text-sm text-muted">$</span>
      <input
        name={name}
        inputMode="decimal"
        aria-label={label}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        className="w-24 bg-transparent px-1 py-1.5 text-sm tabular-nums outline-none placeholder:text-faint"
      />
    </span>
  );
}

/** A bordered card with a heading, a line about it, and a tone. */
export function Card({
  id,
  title,
  icon,
  aside,
  about,
  tone = "plain",
  children,
}: {
  id?: string;
  title: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  about?: ReactNode;
  tone?: "plain" | "accent" | "warn" | "danger";
  children?: ReactNode;
}) {
  const tones = {
    plain: "border-line bg-surface",
    accent: "border-accent/40 bg-accent/5",
    warn: "border-warn/40 bg-warn/5",
    danger: "border-danger/40 bg-danger/5",
  };
  return (
    <section id={id} className={`mb-6 scroll-mt-20 rounded-xl border p-5 ${tones[tone]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h2 className="flex flex-wrap items-center gap-2 font-medium">
            {icon && <span className="text-accent">{icon}</span>}
            {title}
          </h2>
          {about && <div className="mt-1 max-w-2xl text-sm text-muted">{about}</div>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One meter: how much of something is used. */
export function Meter({
  used,
  of,
  label,
  detail,
  calm = false,
}: {
  used: number;
  of: number | null;
  label: string;
  detail?: ReactNode;
  /** Reaching the end is ordinary, not a warning: the plan's included usage, past which usage simply goes on demand. */
  calm?: boolean;
}) {
  const part = share(used, of);
  const bar = calm ? "bg-success" : of != null && used >= of ? "bg-danger" : part >= 0.75 ? "bg-warn" : "bg-success";
  return (
    <div className="mt-4">
      <div className="flex flex-wrap justify-between gap-x-4 text-sm">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">
          {dollars(used)}
          {of != null && <span className="text-faint"> of {dollars(of)}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
        <div className={`h-full ${bar}`} style={{ width: `${Math.max(part * 100, part > 0 ? 2 : 0)}%` }} />
      </div>
      {detail && <p className="mt-1.5 text-xs text-faint">{detail}</p>}
    </div>
  );
}

// --- Spike ------------------------------------------------------------------------

// In its own module, so the app shell carries it without the billing page.
export { SpikeBanner } from "./spike-banner";

// --- Alerts -----------------------------------------------------------------------

export function Alerts({ alerts }: { alerts: UsageAlert[] }) {
  const shown = alerts.filter((alert) => alert.level >= 50).sort((a, b) => b.level - a.level);
  if (shown.length === 0) return null;
  return (
    <ul className="mb-6 space-y-2">
      {shown.map((alert) => {
        const tone = alertTone(alert.level);
        return (
          <li
            key={`${alert.meter}-${alert.level}`}
            className={`flex gap-2.5 rounded-lg border px-4 py-2.5 text-sm ${
              tone === "stopped" ? "border-danger/40 bg-danger/5" : tone === "warning" ? "border-warn/40 bg-warn/5" : "border-line bg-surface"
            }`}
          >
            <Gauge size={15} className={`mt-0.5 shrink-0 ${tone === "stopped" ? "text-danger" : tone === "warning" ? "text-warn" : "text-muted"}`} />
            <span>{alert.message || alertText(alert)}</span>
          </li>
        );
      })}
    </ul>
  );
}

// --- The plan -----------------------------------------------------------------------

const STATUS_TONE: Record<PlanStatus["kind"], "plain" | "accent" | "warn"> = {
  free: "plain",
  trial: "plain",
  paid: "accent",
  canceling: "warn",
  past_due: "warn",
  comped: "accent",
  enterprise: "accent",
};

export function PlanCard({
  state,
  status,
  entitlements,
  owner,
  enabled,
  live,
  meters,
  error,
}: {
  state: FeatureState | null;
  status: PlanStatus;
  entitlements: Entitlements | null;
  owner: boolean;
  enabled: boolean;
  live: boolean;
  /** This month's usage by meter, from billing's `usage_meters`. */
  meters: MeterUsage[] | null;
  error?: string;
}) {
  const plan = state?.plan;
  const subscription = state?.subscription ?? null;
  const on = ["paid", "canceling", "comped", "enterprise"].includes(status.kind);
  return (
    <Card
      id="plan"
      tone={STATUS_TONE[status.kind]}
      icon={<Sparkles size={16} />}
      title={
        <>
          {plan?.title ?? "g1t"}
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              status.kind === "past_due" || status.kind === "canceling"
                ? "bg-warn/15 text-warn"
                : on
                  ? "bg-success/15 text-success"
                  : "border border-line text-muted"
            }`}
          >
            {status.label}
            {status.kind === "canceling" && subscription?.periodEnd ? `, ${new Date(subscription.periodEnd).toLocaleDateString()}` : ""}
          </span>
        </>
      }
      about={
        on
          ? "Everything on g1t for the workspace: agents, checks, workflows, the merge queue, deployments and semantic search."
          : "The forge is free: repositories, issues, pull requests, reviews, search and the audit log. Anything that runs compute needs the plan, or the trial."
      }
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">${((plan?.monthlyCents ?? 2000) / 100).toFixed(0)}</span>
          <span className="text-sm text-muted"> / month</span>
          <span className="block text-xs text-faint">per workspace, never per seat</span>
          <span className="block text-xs text-faint">
            {plan?.cardFeeCents ? `+ ${dollars(plan.cardFeeCents * 10_000)} card processing fee, ${PLUS_TAX}` : "Plus tax where it applies"}
          </span>
        </p>
      }
    >
      {plan && (
        <ul className="mt-4 grid gap-1.5 text-sm text-muted sm:grid-cols-2">
          {plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-success">✓</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {plan && <p className="mt-3 text-xs text-faint">{plan.overage}</p>}

      {on && entitlements?.includedMicros ? (
        <Meter
          label="Included usage this month"
          used={entitlements.includedUsedMicros ?? 0}
          of={entitlements.includedMicros}
          calm
          detail="Used first, at cost plus 20%. Past it, usage goes on at the same prices. It starts again on the 1st; what is unused does not carry over."
        />
      ) : null}
      {meters && <MonthUsage meters={meters} on={on} comped={status.kind === "comped"} entitlements={entitlements} />}

      {status.kind === "comped" || status.kind === "enterprise" ? (
        <p className="mt-4 text-sm text-muted">
          {status.kind === "comped"
            ? "This workspace has a 100% discount from g1t: the plan and its usage are shown at their price, and nothing is charged."
            : "An enterprise pays for this workspace, on its own invoice."}
        </p>
      ) : !enabled ? (
        <p className="mt-4 text-sm text-muted">Payments are not set up on this g1t, so the plan cannot be started here.</p>
      ) : !owner ? (
        <p className="mt-4 text-sm text-muted">An owner manages the plan.</p>
      ) : (
        <Form method="post" className="mt-5 flex flex-wrap items-center gap-3">
          <input type="hidden" name="feature" value={plan?.feature ?? "plan"} />
          {status.kind === "free" || status.kind === "trial" ? (
            <SubmitButton variant="accent" name="intent" value="subscribe" pending="Opening Stripe…">
              <CreditCard size={14} />
              Start the g1t plan
            </SubmitButton>
          ) : status.kind === "canceling" ? (
            <SubmitButton variant="accent" name="intent" value="resume" pending="Saving…">
              Keep the plan
            </SubmitButton>
          ) : null}
          {(status.kind === "paid" || status.kind === "canceling" || status.kind === "past_due") && (
            <SubmitButton variant={status.kind === "past_due" ? "accent" : "quiet"} name="intent" value="portal" pending="Opening Stripe…">
              {status.kind === "past_due" ? "Update payment on Stripe" : "Manage on Stripe"}
              <ArrowUpRight size={14} />
            </SubmitButton>
          )}
          {status.kind === "paid" && subscription && (
            <SubmitButton variant="quiet" name="intent" value="cancel" pending="Saving…">
              End at the end of the period
            </SubmitButton>
          )}
          {!live && (status.kind === "free" || status.kind === "trial") && (
            <span className="text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</span>
          )}
        </Form>
      )}
      <ErrorText>{error}</ErrorText>
      {(status.kind === "free" || status.kind === "trial") && (
        <p className="mt-4 text-xs text-faint">
          Your first month starts at a {wholeDollars(100_000_000)} limit on usage past what is included, so a stolen card cannot run
          up a bill. It rises as payments clear, and you can prepay or ask to raise it at once.
        </p>
      )}
    </Card>
  );
}

/**
 * This month's usage, one line per meter, in dollars at cost plus 20% and
 * in what was used. No quotas: every line is metered from the first unit.
 */
function MonthUsage({
  meters,
  on,
  comped,
  entitlements,
}: {
  meters: MeterUsage[];
  on: boolean;
  comped: boolean;
  entitlements: Entitlements | null;
}) {
  const freeStorage = gigabytes(entitlements?.freePrivateStorageBytes ?? 1_000_000_000);
  const freeGit = (entitlements?.gitOperationsIncluded ?? 50_000).toLocaleString("en-US");
  const rows = shownMeters(meters, on);
  const total = rows.reduce((sum, row) => sum + row.micros, 0);
  return (
    <div className="mt-4 rounded-lg border border-line bg-bg/40 p-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs font-medium text-muted">This month's usage</p>
        <p className="text-xs text-faint">At cost plus 20%</p>
      </div>
      <ul className="mt-2 divide-y divide-line/60">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline justify-between gap-4 py-2 text-sm">
            <span className="min-w-0">
              <span>{row.label}</span>
              {(row.quantity || row.micros === 0) && (
                <span className="block truncate text-xs text-faint">{row.quantity ?? "None yet"}</span>
              )}
            </span>
            <span className={`shrink-0 tabular-nums ${row.micros > 0 ? "" : "text-faint"}`}>{dollars(row.micros)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-line pt-2.5 text-sm">
        {/* At price, before the plan's included usage, the trial and the pools paid
            their part: Usage shows what was charged. */}
        <span className="font-medium">Total at price</span>
        <span className="font-medium tabular-nums">{dollars(total)}</span>
      </div>
      <p className="mt-2 text-xs text-faint">
        {comped
          ? "What this workspace's usage comes to at price. Its 100% discount takes all of it off."
          : on
            ? `Drawn from the included usage first, then charged up to your spend limit. Projects, previews and repositories are never charged, and the first ${freeStorage} of private storage and ${freeGit} git operations a month are free. App traffic, custom domains, storage and git operations are counted through the month and charged when it closes.`
            : `The forge is free: ${freeStorage} of private storage and ${freeGit} git operations a month. Agents run from the trial, and checks, workflows and the merge queue on public repositories from the open-source pool; together they pay part of this total: Usage shows what was charged.`}
      </p>
    </div>
  );
}

// --- The trial -----------------------------------------------------------------------

export function TrialCard({
  entitlements,
  trialMicros,
  owner,
  enabled,
  error,
}: {
  entitlements: Entitlements | null;
  trialMicros: number;
  owner: boolean;
  enabled: boolean;
  error?: string;
}) {
  const verified = entitlements?.trialVerified ?? false;
  const left = entitlements?.trialMicrosLeft ?? 0;
  return (
    <Card
      id="trial"
      icon={<ShieldCheck size={16} />}
      title={`Try it with ${wholeDollars(trialMicros)} of usage`}
      about={
        verified
          ? left > 0
            ? "Your trial pays for agents, checks and workflows until it is used. It is given once per workspace."
            : "This workspace has no trial left. Start the plan to keep going."
          : "Once per workspace, after a card check: Stripe saves and verifies the card with 3-D Secure and charges nothing. The trial needs a credit or debit card; prepaid cards can still pay for the plan."
      }
    >
      {verified && left > 0 && <Meter label="Trial used" used={Math.max(0, trialMicros - left)} of={trialMicros} />}
      {!verified && enabled && owner && (
        <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
          <SubmitButton variant="quiet" name="intent" value="card-check" pending="Opening Stripe…">
            <ShieldCheck size={14} />
            Check a card
          </SubmitButton>
          <span className="text-xs text-faint">Trials come from a monthly pool; when it is given out, new ones start on the 1st.</span>
        </Form>
      )}
      {!verified && !owner && <p className="mt-3 text-sm text-muted">An owner can do the card check.</p>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Spend limit -----------------------------------------------------------------------

export function SpendLimitCard({ limit, owner, error }: { limit: Limit; owner: boolean; error?: string }) {
  const range = spendRange(limit);
  const spent = limit.spentMicros ?? 0;
  const spendLimit = limit.spendLimitMicros;
  const mode = limit.defaultSpendLimit ? "automatic" : spendLimit == null ? "full" : "fixed";
  const tone = limit.state === "stopped" ? "danger" : limit.state === "warning" ? "warn" : "plain";
  return (
    <Card
      id="limit"
      tone={tone}
      icon={<Gauge size={16} />}
      title="Spend limit"
      about="What on-demand usage may reach this month, past what the plan includes. At the limit new work waits; runs already going finish."
      aside={limit.firstMonth ? <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">First month</span> : null}
    >
      {limit.account.startsWith("ent_") && (
        <p className="mt-2 text-sm text-muted">
          Paid for by the <span className="font-medium text-fg">{limit.accountName}</span> enterprise: these figures are for all of its
          workspaces together.
        </p>
      )}
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Meter
          label="Charged this month"
          used={spent}
          of={spendLimit}
          detail={
            mode === "automatic"
              ? "Automatic: $200, or twice last month's spend, within what is available."
              : mode === "fixed"
                ? "A limit you set."
                : "As high as is available."
          }
        />
        <Meter
          label="Not yet paid"
          used={limit.exposureMicros}
          of={limit.ceilingMicros}
          detail={limit.growth ?? "Charged to the card as it nears the limit, so work keeps going."}
        />
      </div>
      {limit.message && <p className="mt-4 text-sm">{limit.message}</p>}

      <div className="mt-5 rounded-lg border border-line bg-bg/40 p-4 text-sm">
        <p>
          {range.selfServeMicros == null ? (
            "No ceiling: set any limit."
          ) : (
            <>
              You can set up to <span className="font-medium tabular-nums">{wholeDollars(range.selfServeMicros)}</span> yourself: the
              highest limit this workspace has had{(limit.prepaidMicros ?? 0) > 0 ? ", plus what is prepaid" : ""}.
            </>
          )}
        </p>
        <p className="mt-1 text-muted">
          {range.raiseOnceMicros != null ? (
            <>
              Once, you can raise it yourself to <span className="tabular-nums text-fg">{wholeDollars(range.raiseOnceMicros)}</span>.
              Past that, prepay or use Raise my limit.
            </>
          ) : range.raisedAt ? (
            <>The one-time raise was used on {new Date(range.raisedAt).toLocaleDateString()}. Prepay or use Raise my limit for more.</>
          ) : range.selfServeMicros != null ? (
            "For more, prepay or use Raise my limit."
          ) : null}
        </p>
      </div>

      {owner && (
        <Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="spend-limit" />
          <fieldset>
            <legend className="text-xs text-muted">Your monthly spend limit</legend>
            <RadioGroup name="mode" defaultValue={mode} className="mt-2 gap-2.5 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="automatic" />
                Automatic
              </label>
              <label className="flex cursor-pointer flex-wrap items-center gap-2">
                <RadioGroupItem value="fixed" />
                Fixed at
                <DollarInput
                  name="limit"
                  label="Spend limit in dollars"
                  defaultValue={mode === "fixed" && spendLimit != null ? String(spendLimit / 1_000_000) : ""}
                  placeholder={range.selfServeMicros != null ? String(range.selfServeMicros / 1_000_000) : "500"}
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="full" />
                Everything available{range.selfServeMicros != null ? ` (${wholeDollars(range.selfServeMicros)})` : ""}
              </label>
              {range.raiseOnceMicros != null && (
                <label className="flex cursor-pointer items-center gap-2">
                  <RadioGroupItem value="raise" />
                  Use my one-time raise, to the amount above or up to {wholeDollars(range.raiseOnceMicros)}
                </label>
              )}
            </RadioGroup>
          </fieldset>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <SubmitButton variant="quiet" match={{ intent: "spend-limit" }} pending="Saving…">
              Save limit
            </SubmitButton>
            <a href="#raise" className="text-sm text-muted hover:text-fg">
              Need more? Raise my limit
            </a>
          </div>
          <ErrorText>{error}</ErrorText>
        </Form>
      )}
    </Card>
  );
}

// --- Raise my limit -----------------------------------------------------------------------

function RequestList({ requests }: { requests: LimitRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
      {requests.map((request) => (
        <li key={request.id} className="px-4 py-2.5">
          <p className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {request.kind === "limit" ? `Asked for ${wholeDollars(request.amountMicros)}` : "Told g1t about this month"}
              <span className="text-faint"> · {new Date(request.createdAt).toLocaleDateString()}</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                request.status === "approved"
                  ? "bg-success/15 text-success"
                  : request.status === "declined"
                    ? "bg-danger/15 text-danger"
                    : "border border-line text-muted"
              }`}
            >
              {requestStatus(request)}
            </span>
          </p>
          {request.answer && <p className="mt-1 text-muted">{request.answer}</p>}
        </li>
      ))}
    </ul>
  );
}

export function RaiseCard({ requests, owner, error }: { requests: LimitRequest[]; owner: boolean; error?: string }) {
  const mine = requests.filter((request) => request.kind === "limit");
  const waiting = mine.some((request) => request.status === "open");
  return (
    <Card
      id="raise"
      title="Raise my limit"
      about="Ask g1t for a higher limit than you can set yourself. A person reads it and answers within one business day, in the app and by email. Nothing about price is negotiated."
    >
      {owner && !waiting && (
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="kind" value="limit" />
          <div className="flex flex-wrap gap-4">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">Limit you need</span>
              <DollarInput name="amount" label="Limit you need in dollars" placeholder="2000" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">What you expect to spend a month</span>
              <DollarInput name="expected" label="Expected monthly spend in dollars" placeholder="1500" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">What it is for</span>
            <textarea
              name="reason"
              rows={2}
              maxLength={2000}
              placeholder="A launch next week: agents on 40 issues across three projects."
              className={`${CONTROL} w-full`}
            />
          </label>
          <SubmitButton variant="quiet" match={{ intent: "request", kind: "limit" }} pending="Sending…">
            Send the request
          </SubmitButton>
          <ErrorText>{error}</ErrorText>
        </Form>
      )}
      {owner && waiting && <p className="mt-3 text-sm text-muted">Your request is with g1t. You can send another once it is answered.</p>}
      {!owner && <p className="mt-3 text-sm text-muted">An owner can ask.</p>}
      <RequestList requests={mine} />
    </Card>
  );
}

// --- Prepay -----------------------------------------------------------------------

/**
 * Credit g1t gave the workspace: what is left, each grant in a line with
 * its expiry, and what each was for. Spent before anything prepaid.
 */
export function CreditsCard({ credits }: { credits: Credits }) {
  const open = credits.grants.filter((grant) => grant.state === "open");
  const past = credits.grants.filter((grant) => grant.state !== "open");
  return (
    <Card
      id="credits"
      icon={<Gift size={16} />}
      title="Credits from g1t"
      about="Credit g1t gave this workspace. It pays for usage before anything prepaid, the soonest-expiring first. Unused credit stops counting when it expires."
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="block text-xs text-muted">Credit left</span>
          <span className="text-xl font-semibold tabular-nums">{dollars(credits.leftMicros)}</span>
        </p>
      }
    >
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {[...open, ...past].map((grant) => (
          <li key={grant.id} className={`px-3.5 py-2.5 text-sm ${grant.state === "open" ? "" : "text-muted"}`}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`tabular-nums ${grant.state === "open" ? "font-medium" : ""}`}>{creditLine(grant)}</span>
              <span className="rounded-full border border-line px-2 py-px text-xs text-muted">{CREDIT_KIND[grant.kind]}</span>
            </p>
            <p className="mt-0.5 text-xs text-faint">
              {grant.kind === "refund" && grant.refundFor ? `For ${grant.refundFor}. ` : ""}
              {grant.note} · given {shortDay(grant.createdAt)}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function PrepayCard({
  prepaidMicros,
  owner,
  live,
  cardFee,
  error,
}: {
  prepaidMicros: number;
  owner: boolean;
  live: boolean;
  /** The card fee as billing charges it, to show it before paying. */
  cardFee?: { on: boolean; percentMicros: number; fixedCents: number } | null;
  error?: string;
}) {
  const fees = PREPAY.presets.map((amount) => `${dollars(cardFeeCents(amount * 100, cardFee) * 10_000)} on ${wholeDollars(amount * 1_000_000)}`);
  return (
    <Card
      id="prepay"
      icon={<Landmark size={16} />}
      title="Prepay"
      about="Pay for usage in advance. It raises what you can use before work stops by the same amount, at once, and usage draws it down."
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="block text-xs text-muted">Prepaid balance</span>
          <span className="text-xl font-semibold tabular-nums">{dollars(prepaidMicros)}</span>
        </p>
      }
    >
      {owner ? (
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="prepay" />
          <div className="flex flex-wrap items-center gap-2">
            {PREPAY.presets.map((amount) => (
              <SubmitButton key={amount} variant="quiet" name="amount" value={amount} match={{ intent: "prepay" }} pending="Opening Stripe…">
                {wholeDollars(amount * 1_000_000)}
              </SubmitButton>
            ))}
            <span className="text-sm text-muted">or</span>
            <DollarInput name="custom" label="Amount to prepay in dollars" placeholder="250" />
            {/* An empty amount, so a preset's press is not this button's: the typed amount is used. */}
            <SubmitButton variant="accent" name="amount" value="" match={{ intent: "prepay" }} pending="Opening Stripe…">
              <CreditCard size={14} />
              Prepay
            </SubmitButton>
          </div>
          <RadioGroup name="method" defaultValue="card" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <RadioGroupItem value="card" />
              By card, with 3-D Secure ({wholeDollars(PREPAY.min * 1_000_000)} to {wholeDollars(PREPAY.maxCard * 1_000_000)})
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <RadioGroupItem value="bank_transfer" />
              By bank transfer (from {wholeDollars(PREPAY.bankFrom * 1_000_000)}; counted when it arrives)
            </label>
          </RadioGroup>
          <p className="text-xs text-faint">
            {cardFee?.on ? `By card, a card processing fee is its own line (${fees.join(", ")}); a bank transfer has none. ` : ""}
            Tax is added where it applies, from your billing address; what you prepay is credited in full.
          </p>
          {!live && <p className="text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</p>}
          <ErrorText>{error}</ErrorText>
        </Form>
      ) : (
        <p className="mt-3 text-sm text-muted">An owner can prepay.</p>
      )}
    </Card>
  );
}

// --- Caps -----------------------------------------------------------------------

export function CapsCard({ entitlements, owner, error }: { entitlements: Entitlements; owner: boolean; error?: string }) {
  return (
    <Card
      id="caps"
      title="Caps on agents"
      about={
        <>
          The most one agent run may spend, and the most the agents on one issue may spend in all, so an agent stuck in a loop stops on
          its own. Blank goes back to {wholeDollars(CAPS.run.default)} and {wholeDollars(CAPS.issue.default)}. A cap g1t set for this
          workspace wins.
        </>
      }
    >
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:max-w-md">
        <div>
          <dt className="text-xs text-muted">Per run</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{wholeDollars(entitlements.runCapMicros)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Per issue</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{wholeDollars(entitlements.issueCapMicros)}</dd>
        </div>
      </dl>
      {owner && (
        <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
          <input type="hidden" name="intent" value="caps" />
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">
              Per run ({wholeDollars(CAPS.run.min)} to {wholeDollars(CAPS.run.max)})
            </span>
            <DollarInput name="run" label="Run cap in dollars" defaultValue={String(entitlements.runCapMicros / 1_000_000)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">
              Per issue ({wholeDollars(CAPS.issue.min)} to {wholeDollars(CAPS.issue.max)})
            </span>
            <DollarInput name="issue" label="Issue cap in dollars" defaultValue={String(entitlements.issueCapMicros / 1_000_000)} />
          </label>
          <SubmitButton variant="quiet" match={{ intent: "caps" }} pending="Saving…">
            Save caps
          </SubmitButton>
        </Form>
      )}
      <ErrorText>{error}</ErrorText>
      <p className="mt-3 text-xs text-faint">
        {entitlements.maxConcurrentAgents} agents at a time{entitlements.maxRunMinutes ? `, ${entitlements.maxRunMinutes} minutes a run` : ""}
        {entitlements.firstMonth ? " in the first month" : ""}.
      </p>
    </Card>
  );
}

// --- Overage -----------------------------------------------------------------------

export function OverageCard({ requests, owner, error }: { requests: LimitRequest[]; owner: boolean; error?: string }) {
  const mine = requests.filter((request) => request.kind === "overage");
  const waiting = mine.some((request) => request.status === "open");
  return (
    <Card
      id="overage"
      title="Spent more than you meant to? Tell us."
      about="A loop that ran all night, a workflow on every push: say what happened. g1t can credit usage you did not mean, once in 12 months; larger credits, or a second one within 12 months, are reviewed by a person."
    >
      {owner && !waiting && (
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="kind" value="overage" />
          <textarea
            name="reason"
            rows={2}
            maxLength={2000}
            aria-label="What happened"
            placeholder="An agent kept retrying a failing check on Tuesday night."
            className={`${CONTROL} w-full`}
          />
          <SubmitButton variant="quiet" match={{ intent: "request", kind: "overage" }} pending="Sending…">
            Tell g1t
          </SubmitButton>
          <ErrorText>{error}</ErrorText>
        </Form>
      )}
      {owner && waiting && <p className="mt-3 text-sm text-muted">g1t has your note and answers within one business day.</p>}
      {!owner && <p className="mt-3 text-sm text-muted">An owner can tell g1t.</p>}
      <RequestList requests={mine} />
    </Card>
  );
}
