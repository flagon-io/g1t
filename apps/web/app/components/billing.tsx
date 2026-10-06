/**
 * The billing page's sections: the spend-spike banner (also in the app
 * shell), alerts, the g1t plan, the trial, the spend limit and its range,
 * Raise my limit, Prepay, the run and issue caps, and "Spent more than you
 * meant to?". Each posts to the billing route's action with an `intent`.
 */
import { AlertTriangle, ArrowUpRight, CreditCard, Gauge, Landmark, OctagonX, Play, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Form } from "react-router";

import type { Entitlements, FeatureState, Limit, LimitRequest, MeterUsage, UsageAlert } from "@g1t/contracts";

import {
  CAPS,
  PREPAY,
  type PlanStatus,
  alertText,
  alertTone,
  dollars,
  gigabytes,
  requestStatus,
  share,
  shownMeters,
  spendRange,
  wholeDollars,
} from "../lib/billing";
import { Button, ErrorText } from "./ui";
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
  const bar = calm ? "bg-accent" : of != null && used >= of ? "bg-danger" : part >= 0.75 ? "bg-warn" : "bg-accent";
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

/**
 * Compute paused by a spend spike, with the owners' choice: keep going for
 * 24 hours, or stop. Also a hold by g1t, which only g1t lifts. Posts to the
 * workspace's billing page, so it works from anywhere in the app.
 */
export function SpikeBanner({
  slug,
  entitlements,
  owner,
  compact = false,
}: {
  slug: string;
  entitlements: Pick<Entitlements, "paused" | "spike">;
  owner: boolean;
  compact?: boolean;
}) {
  const spike = entitlements.spike?.status === "open" ? entitlements.spike : null;
  if (!spike && !entitlements.paused) return null;
  const text = spike
    ? `Spending spiked: ${dollars(spike.hourMicros)} in the last hour, against a usual ${dollars(spike.averageMicros)}. New agents, checks and builds wait until an owner decides; work already running finishes.`
    : `g1t paused new compute for this workspace: ${entitlements.paused}`;
  return (
    <div
      id="spike"
      role="alert"
      className={
        compact
          ? "flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm"
          : "mb-6 scroll-mt-20 rounded-xl border border-danger/40 bg-danger/5 p-5"
      }
    >
      <p className={compact ? "flex items-center gap-2" : "flex gap-2.5 text-sm"}>
        <AlertTriangle size={compact ? 15 : 17} className="shrink-0 text-danger" />
        <span>{compact ? (spike ? `${slug}: spending spiked, so new compute is paused.` : `${slug}: new compute is paused.`) : text}</span>
      </p>
      {spike && owner ? (
        <Form method="post" action={`/${slug}/-/billing`} className={compact ? "flex gap-2" : "mt-4 flex flex-wrap gap-2"}>
          <input type="hidden" name="intent" value="spike" />
          <Button variant="accent" type="submit" name="decision" value="keep">
            <Play size={14} />
            Keep going
          </Button>
          <Button variant="quiet" type="submit" name="decision" value="stop">
            <OctagonX size={14} />
            Stop
          </Button>
        </Form>
      ) : spike ? (
        <p className={compact ? "text-xs text-muted" : "mt-3 text-sm text-muted"}>An owner chooses Keep going or Stop on Billing.</p>
      ) : (
        <p className={compact ? "text-xs text-muted" : "mt-3 text-sm text-muted"}>
          Write to <a href="mailto:hey@flagon.io" className="underline underline-offset-2">hey@flagon.io</a> to have it looked at.
        </p>
      )}
      {!compact && spike && (
        <p className="mt-3 text-xs text-faint">
          Keep going lets work start again for 24 hours, unless spending doubles again first. Stop keeps new compute paused until you
          choose Keep going.
        </p>
      )}
    </div>
  );
}

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
  busy,
  meters,
  error,
}: {
  state: FeatureState | null;
  status: PlanStatus;
  entitlements: Entitlements | null;
  owner: boolean;
  enabled: boolean;
  live: boolean;
  busy: boolean;
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
                  ? "bg-accent/15 text-accent"
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
        </p>
      }
    >
      {plan && (
        <ul className="mt-4 grid gap-1.5 text-sm text-muted sm:grid-cols-2">
          {plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-accent">✓</span>
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
            ? "g1t covers this workspace's plan. Its usage is still recorded at what it costs, and shown as given."
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
            <Button variant="accent" type="submit" name="intent" value="subscribe" disabled={busy}>
              <CreditCard size={14} />
              Start the g1t plan
            </Button>
          ) : status.kind === "canceling" ? (
            <Button variant="accent" type="submit" name="intent" value="resume" disabled={busy}>
              Keep the plan
            </Button>
          ) : null}
          {(status.kind === "paid" || status.kind === "canceling" || status.kind === "past_due") && (
            <Button variant={status.kind === "past_due" ? "accent" : "quiet"} type="submit" name="intent" value="portal" disabled={busy}>
              {status.kind === "past_due" ? "Update payment on Stripe" : "Manage on Stripe"}
              <ArrowUpRight size={14} />
            </Button>
          )}
          {status.kind === "paid" && subscription && (
            <Button variant="quiet" type="submit" name="intent" value="cancel" disabled={busy}>
              End at the end of the period
            </Button>
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
        <span className="font-medium">Total</span>
        <span className="font-medium tabular-nums">{dollars(total)}</span>
      </div>
      <p className="mt-2 text-xs text-faint">
        {comped
          ? "What this workspace's usage would cost. g1t covers it."
          : on
            ? `Drawn from the included usage first, then charged up to your spend limit. Projects, previews and repositories are never charged, and the first ${freeStorage} of private storage and ${freeGit} git operations a month are free. App traffic, custom domains, storage and git operations are counted through the month and charged when it closes.`
            : `The forge is free: ${freeStorage} of private storage and ${freeGit} git operations a month. Agents run from the trial or the open-source pool.`}
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
  busy,
  error,
}: {
  entitlements: Entitlements | null;
  trialMicros: number;
  owner: boolean;
  enabled: boolean;
  busy: boolean;
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
          <Button variant="quiet" type="submit" name="intent" value="card-check" disabled={busy}>
            <ShieldCheck size={14} />
            Check a card
          </Button>
          <span className="text-xs text-faint">Trials come from a monthly pool; when it is given out, new ones start on the 1st.</span>
        </Form>
      )}
      {!verified && !owner && <p className="mt-3 text-sm text-muted">An owner can do the card check.</p>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

// --- Spend limit -----------------------------------------------------------------------

export function SpendLimitCard({ limit, owner, busy, error }: { limit: Limit; owner: boolean; busy: boolean; error?: string }) {
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
            <Button variant="quiet" type="submit" disabled={busy}>
              Save limit
            </Button>
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
                  ? "bg-accent/15 text-accent"
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

export function RaiseCard({ requests, owner, busy, error }: { requests: LimitRequest[]; owner: boolean; busy: boolean; error?: string }) {
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
          <Button variant="quiet" type="submit" disabled={busy}>
            Send the request
          </Button>
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

export function PrepayCard({ prepaidMicros, owner, live, busy, error }: { prepaidMicros: number; owner: boolean; live: boolean; busy: boolean; error?: string }) {
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
              <Button key={amount} variant="quiet" type="submit" name="amount" value={amount} disabled={busy}>
                {wholeDollars(amount * 1_000_000)}
              </Button>
            ))}
            <span className="text-sm text-muted">or</span>
            <DollarInput name="custom" label="Amount to prepay in dollars" placeholder="250" />
            <Button variant="accent" type="submit" disabled={busy}>
              <CreditCard size={14} />
              Prepay
            </Button>
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

export function CapsCard({ entitlements, owner, busy, error }: { entitlements: Entitlements; owner: boolean; busy: boolean; error?: string }) {
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
          <Button variant="quiet" type="submit" disabled={busy}>
            Save caps
          </Button>
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

export function OverageCard({ requests, owner, busy, error }: { requests: LimitRequest[]; owner: boolean; busy: boolean; error?: string }) {
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
          <Button variant="quiet" type="submit" disabled={busy}>
            Tell g1t
          </Button>
          <ErrorText>{error}</ErrorText>
        </Form>
      )}
      {owner && waiting && <p className="mt-3 text-sm text-muted">g1t has your note and answers within one business day.</p>}
      {!owner && <p className="mt-3 text-sm text-muted">An owner can tell g1t.</p>}
      <RequestList requests={mine} />
    </Card>
  );
}
