/**
 * A workspace's complimentary enrollment: the monthly usage allowance (at
 * ordinary prices), the recurring monthly fee apart from it, this month's
 * standing, the Stripe subscription that stands for it, and its terms over
 * time. Staff enroll each workspace by hand; nothing enrolls one on its own.
 */
import type { ComplimentaryStanding } from "@g1t/contracts";

import { Badge, Button, Field, Input, Notice, Section, Textarea, When } from "~/components/ui";
import { dollarsField, usd } from "~/lib/money";
import type { SectionError } from "~/lib/review";

const STATUS: Record<ComplimentaryStanding["status"], { label: string; tone: "mint" | "warn" | "plain" }> = {
  active: { label: "Active", tone: "mint" },
  pending: { label: "Waiting for Stripe", tone: "warn" },
  ended: { label: "Ended", tone: "plain" },
};

function allowanceText(micros: number, unlimited?: boolean) {
  return unlimited ? "Unlimited" : `${usd(micros, { cents: true })} a month`;
}

function feeText(cents?: number) {
  return cents ? `${usd(cents * 10_000, { cents: true })} a month` : "Waived";
}

export function ComplimentarySection({
  workspace,
  standing,
  unavailable,
  pathname,
  error,
}: {
  workspace: string;
  standing: ComplimentaryStanding | null;
  unavailable: string | null;
  pathname: string;
  error: SectionError;
}) {
  const values = error?.values;
  const open = standing && standing.status !== "ended" ? standing : null;
  const month = open?.month ?? null;
  return (
    <Section
      id="complimentary"
      title="Complimentary"
      description="The plan's features, a monthly usage allowance at ordinary prices, and a monthly fee of its own. Past the allowance new work that costs money stops; nothing is ever charged for it. No rollover."
    >
      {unavailable && <Notice tone="error">Billing could not say: {unavailable}</Notice>}
      {open ? (
        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATUS[open.status].tone}>{STATUS[open.status].label}</Badge>
            <span className="text-fg-soft">{allowanceText(open.allowanceMicros, open.unlimited)} allowance</span>
            <span className="text-faint">·</span>
            <span className="text-fg-soft">Fee {feeText(open.feeCents)}</span>
            <span className="text-faint">·</span>
            <span className="text-fg-soft">{open.chargePastAllowance ? "Past it: their card is charged" : "Past it: work stops"}</span>
          </div>
          {month && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-line bg-bg px-3.5 py-2.5 text-sm sm:grid-cols-3">
              <Stat label="Used this month" value={usd(month.usedMicros, { cents: true })} />
              <Stat label="Metered, not billed yet" value={usd(month.pendingMicros ?? 0, { cents: true })} />
              <Stat label="Held by running work" value={usd(month.heldMicros ?? 0, { cents: true })} />
              <Stat label="Remaining" value={month.unlimited ? "Unlimited" : usd(month.remainingMicros, { cents: true })} />
              <Stat label="Covered past it by g1t" value={usd(month.overrunMicros ?? 0, { cents: true })} />
              <Stat label="Resets" value={<When at={month.resetsAt} />} />
            </dl>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            <Stat label="Money received, ever" value={usd(open.moneyReceivedMicros ?? 0, { cents: true })} />
            <Stat label="Promotional credit, ever" value={usd(open.promotionalCreditMicros ?? 0, { cents: true })} />
            <Stat label="Gifted usage, ever" value={usd(open.giftedMicros ?? 0, { cents: true })} />
          </dl>
          <p className="text-xs text-muted">
            Stripe {open.live ? "live" : "test"}: {open.customerId ?? "no customer yet"}, {open.subscriptionId ?? "no subscription yet"}
            {open.stripeStatus ? ` (${open.stripeStatus})` : ""}. Grant {open.grantId}.
          </p>
          {open.pendingOp && (
            <Notice tone="info">
              Still owed at Stripe: {open.pendingOp}. Tried again every fifteen minutes{open.lastError ? `; last error: ${open.lastError}` : "."}
            </Notice>
          )}
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted">
          {standing?.status === "ended"
            ? `Not enrolled. The last enrollment ended ${standing.endedReason === "converted" ? "when the owner started the plan" : "by staff"}.`
            : "Not enrolled: the workspace is on its own plan."}
        </p>
      )}

      <form method="post" action={`${pathname}#complimentary`} className="space-y-4">
        <input type="hidden" name="intent" value="complimentary" />
        {error && <Notice tone="error">{error.error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly allowance $" hint="Usage at ordinary prices, each calendar month (UTC). Changing it keeps what this month used.">
            <Input
              name="allowance"
              inputMode="decimal"
              placeholder="100.00"
              defaultValue={values?.allowance ?? (open ? dollarsField(open.allowanceMicros) : "100.00")}
            />
          </Field>
          <Field label="Monthly fee $" hint="Recurring, invoiced by Stripe, apart from the allowance. Blank or 0: waived.">
            <Input
              name="fee"
              inputMode="decimal"
              placeholder="Waived"
              defaultValue={values?.fee ?? (open?.feeCents ? dollarsField(open.feeCents * 10_000) : "")}
            />
          </Field>
        </div>
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 text-xs text-faint">Past the allowance</legend>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="past" value="stop" defaultChecked={values ? values.past !== "charge" : !open?.chargePastAllowance} className="mt-0.5" />
            <span>
              <span className="block font-medium">New paid work stops</span>
              <span className="block text-xs text-muted">Nothing is ever charged. For partners g1t carries entirely.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="past"
              value="charge"
              defaultChecked={values ? values.past === "charge" : Boolean(open?.chargePastAllowance)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Their card is charged</span>
              <span className="block text-xs text-muted">
                g1t covers the allowance; past it, usage is charged to the workspace's own card at the usual prices, up to its spend limit. For employees and
                friends. Without a card, work stops until they add one.
              </span>
            </span>
          </label>
        </fieldset>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" name="unlimited" defaultChecked={values ? values.unlimited === "on" : Boolean(open?.unlimited)} className="mt-0.5" />
          <span>
            <span className="block font-medium">Unlimited allowance</span>
            <span className="block text-xs text-muted">For g1t's own workspaces. Infrastructure limits still apply.</span>
          </span>
        </label>
        <Field label="Note" hint="Required. Why, for whoever looks next.">
          <Textarea
            name="note"
            rows={2}
            required
            maxLength={500}
            defaultValue={values?.note ?? ""}
            placeholder="e.g. Design partner, $500 a month through Q1"
          />
        </Field>
        <Field label={`Type ${workspace} to confirm`}>
          <Input name="confirmation" autoComplete="off" defaultValue="" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">{open ? "Change terms" : "Enroll"}</Button>
        </div>
      </form>

      {open && (
        <form method="post" action={`${pathname}#complimentary`} className="mt-6 space-y-3 border-t border-line pt-4">
          <input type="hidden" name="intent" value="end-complimentary" />
          <p className="text-sm text-muted">
            Ending it puts the workspace on Free now and cancels its Stripe subscription. Usage the allowance paid for stays paid for.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Note">
              <Input name="note" required maxLength={500} placeholder="Why" />
            </Field>
            <Field label={`Type ${workspace} to end`}>
              <Input name="confirmation" autoComplete="off" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="danger">
              End enrollment
            </Button>
          </div>
        </form>
      )}

      {standing?.periods && standing.periods.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="text-xs text-faint">Terms over time</p>
          <ul className="mt-2 space-y-1 text-xs">
            {standing.periods.map((period) => (
              <li key={period.id} className="flex flex-wrap gap-x-2 text-fg-soft">
                <When at={period.startsAt} />
                <span>→</span>
                {period.endsAt ? <When at={period.endsAt} /> : <span>now</span>}
                <span>
                  {allowanceText(period.allowanceMicros, period.unlimited)}, fee {feeText(period.feeCents)},{" "}
                  {period.chargePastAllowance ? "then their card" : "then stops"}
                </span>
                <span className="text-muted">
                  {period.createdBy}: {period.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="tabular-nums text-fg-soft">{value}</dd>
    </div>
  );
}
