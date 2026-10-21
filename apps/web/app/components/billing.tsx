/**
 * The billing page's sections: the spend-spike banner (also in the app
 * shell), alerts, the trial, the spend limit and its range,
 * Raise my limit, credits from g1t, Prepay, and "Spent more than you
 * meant to?". Each posts to the billing route's action with an `intent`.
 */
import { CreditCard, Gauge, Gift, Landmark, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Form } from "react-router";

import type { Credits, Entitlements, Limit, LimitRequest, UsageAlert } from "@g1t/contracts";

import { CREDIT_KIND, PREPAY, alertText, alertTone, creditLine, requestStatus, share, shortDay, spendRange } from "../lib/billing";
import { money, wholeDollars } from "../lib/money";
import { type Failed, isFailed } from "../lib/partial";
import { Unavailable } from "./boundary";
import { ErrorText, SubmitButton } from "./ui";
import { Badge } from "./ui/badge";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";

/** An error the action returned, for the section it belongs to. */
export type SectionError = { section: string; error: string } | null | undefined;

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
    <section id={id} className={`mb-6 scroll-mt-[calc(var(--topbar-h)+1rem)] rounded-xl border p-5 ${tones[tone]}`}>
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
          {money(used)}
          {of != null && <span className="text-faint"> of {money(of)}</span>}
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
            ? "Your trial pays for checks, workflows and deployments until it is used. It is given once per workspace."
            : "This workspace has no trial left. Start the plan to keep going."
          : "Once per workspace, after a card check: Stripe saves and verifies the card with 3-D Secure and charges nothing. The trial needs a credit or debit card; prepaid cards can still pay for the plan."
      }
    >
      {verified && left > 0 && <Meter label="Trial used" used={Math.max(0, trialMicros - left)} of={trialMicros} />}
      {!verified && enabled && owner && (
        <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
          <SubmitButton variant="outline" name="intent" value="card-check" pending="Opening Stripe…">
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
      aside={limit.firstMonth ? <Badge size="md">First month</Badge> : null}
    >
      {limit.account.startsWith("ent_") && (
        <p className="mt-2 text-sm text-muted">
          Paid for by the <span className="font-medium text-fg">{limit.accountName}</span> enterprise: these figures are for all of its workspaces together.
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
      {limit.firstMonth && spendLimit != null && (limit.trustCeilingMicros ?? limit.ceilingMicros) != null && (
        <p className="mt-4 text-sm text-muted">
          In the first month, work waits at whichever comes first: {wholeDollars(spendLimit)} charged this month (your spend limit), or{" "}
          {wholeDollars(limit.trustCeilingMicros ?? limit.ceilingMicros ?? 0)} not yet paid for (the first month's limit). The card is charged as usage nears
          it, which makes room again.
        </p>
      )}
      {limit.message && <p className="mt-4 text-sm">{limit.message}</p>}

      <div className="mt-5 rounded-lg border border-line bg-bg/40 p-4 text-sm">
        <p>
          {range.selfServeMicros == null ? (
            "No ceiling: set any limit."
          ) : (
            <>
              You can set up to <span className="font-medium tabular-nums">{wholeDollars(range.selfServeMicros)}</span> yourself: the highest limit this
              workspace has had{(limit.prepaidMicros ?? 0) > 0 ? ", plus what is prepaid" : ""}.
            </>
          )}
        </p>
        <p className="mt-1 text-muted">
          {range.raiseOnceMicros != null ? (
            <>
              Once, you can raise it yourself to <span className="tabular-nums text-fg">{wholeDollars(range.raiseOnceMicros)}</span>. Past that, prepay or use
              Raise my limit.
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
            <SubmitButton variant="outline" match={{ intent: "spend-limit" }} pending="Saving…">
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

export function RaiseCard({ requests, owner, error }: { requests: LimitRequest[] | Failed; owner: boolean; error?: string }) {
  const about =
    "Ask for a higher limit than you can set yourself. A person at g1t reads it and answers within one business day, in the app and by email. Nothing about price is negotiated.";
  // Without the requests there is no telling whether one is open: no form,
  // so a second one is never sent while the first waits.
  if (isFailed(requests)) {
    return (
      <Card id="raise" title="Raise my limit" about={about}>
        <div className="mt-3">
          <Unavailable what={requests.what} compact />
        </div>
      </Card>
    );
  }
  const mine = requests.filter((request) => request.kind === "limit");
  const waiting = mine.some((request) => request.status === "open");
  return (
    <Card id="raise" title="Raise my limit" about={about}>
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
              placeholder="A launch next week: builds and previews across three repositories."
              className={`${CONTROL} w-full`}
            />
          </label>
          <SubmitButton variant="outline" match={{ intent: "request", kind: "limit" }} pending="Sending…">
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
          <span className="text-xl font-semibold tabular-nums">{money(credits.leftMicros)}</span>
        </p>
      }
    >
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {[...open, ...past].map((grant) => (
          <li key={grant.id} className={`px-3.5 py-2.5 text-sm ${grant.state === "open" ? "" : "text-muted"}`}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`tabular-nums ${grant.state === "open" ? "font-medium" : ""}`}>{creditLine(grant)}</span>
              <Badge size="md" className="py-px">
                {CREDIT_KIND[grant.kind]}
              </Badge>
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

export function PrepayCard({ prepaidMicros, owner, live, error }: { prepaidMicros: number; owner: boolean; live: boolean; error?: string }) {
  return (
    <Card
      id="prepay"
      icon={<Landmark size={16} />}
      title="Prepay"
      about="Pay for usage in advance. It raises what you can use before work stops by the same amount, at once, and usage draws it down."
      aside={
        <p className="shrink-0 sm:text-right">
          <span className="block text-xs text-muted">Prepaid balance</span>
          <span className="text-xl font-semibold tabular-nums">{money(prepaidMicros)}</span>
        </p>
      }
    >
      {owner ? (
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="prepay" />
          <div className="flex flex-wrap items-center gap-2">
            {PREPAY.presets.map((amount) => (
              <SubmitButton key={amount} variant="outline" name="amount" value={amount} match={{ intent: "prepay" }} pending="Opening Stripe…">
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
            No fee on top, by card or bank transfer. Tax is added where it applies, from your billing address; what you prepay is credited in full.
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

// --- Overage -----------------------------------------------------------------------

export function OverageCard({ requests, owner, error }: { requests: LimitRequest[] | Failed; owner: boolean; error?: string }) {
  const title = "Spent more than you meant to? Tell us.";
  const about =
    "A loop that ran all night, a workflow on every push: say what happened. g1t can credit usage you did not mean, once in 12 months; larger credits, or a second one within 12 months, are reviewed by a person.";
  // As on Raise my limit: no form while an open request may be unseen.
  if (isFailed(requests)) {
    return (
      <Card id="overage" title={title} about={about}>
        <div className="mt-3">
          <Unavailable what={requests.what} compact />
        </div>
      </Card>
    );
  }
  const mine = requests.filter((request) => request.kind === "overage");
  const waiting = mine.some((request) => request.status === "open");
  return (
    <Card id="overage" title={title} about={about}>
      {owner && !waiting && (
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="kind" value="overage" />
          <textarea
            name="reason"
            rows={2}
            maxLength={2000}
            aria-label="What happened"
            placeholder="A workflow kept retrying a failing check on Tuesday night."
            className={`${CONTROL} w-full`}
          />
          <SubmitButton variant="outline" match={{ intent: "request", kind: "overage" }} pending="Sending…">
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
