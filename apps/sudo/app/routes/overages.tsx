import { AlertTriangle, Gift } from "lucide-react";
import { Link, data, redirect, useLocation } from "react-router";

import type { Overage } from "@g1t/contracts";

import type { Route } from "./+types/overages";
import { Hidden } from "~/components/billing";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Stat, Textarea, When } from "~/components/ui";
import { fields, parseGoodwill } from "~/lib/forms";
import { dollarsField, parseDollars, usd } from "~/lib/money";
import { FORGIVE_COST_MICROS, goodwillChoices, goodwillLine, goodwillWarning, spikeLabel } from "~/lib/pricing";
import { DONE, doneKey } from "~/lib/review";
import { admin, priceBook } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Overages · sudo" }, { name: "robots", content: "noindex, nofollow" }];

async function capMicros(): Promise<number> {
  const book = await settle(priceBook());
  return (book.ok && book.value.free?.overageForgiveCostMicros) || FORGIVE_COST_MICROS;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const [queue, cap] = await Promise.all([settle(admin.overages()), capMicros()]);
  const done = doneKey(request.url);
  return {
    queue: queue.ok ? queue.value : [],
    error: queue.ok ? null : queue.error,
    cap,
    done: done ? DONE[done] : null,
  };
}

type Review = {
  workspace: string;
  amount: string;
  day: string;
  reason: string;
  absorbedMicros: number;
  overCap: boolean;
  needsReason: boolean;
  amountMicros: number;
};

type ActionResult = { error: string; workspace: string; values: Record<string, string> } | { review: Review };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const values = fields(form, "workspace", "amount", "reason", "day");
  const fail = (error: string) => data<ActionResult>({ error, workspace: values.workspace, values }, { status: 422 });
  const [queue, cap] = await Promise.all([admin.overages(), capMicros()]);
  // What is credited comes from billing's queue, not the form.
  const overage = queue.find((row) => row.workspace === values.workspace);
  if (!overage) return fail("That workspace is no longer in the Overages queue. Give credit from its page instead.");
  const parsed = parseGoodwill(form, (amount) => goodwillWarning(amount, overage.goodwill, overage.lastGoodwillAt, cap).needsReason);
  // The amount as typed, even when the form is not complete yet: it decides whether the red review shows.
  const typed = values.amount ? parseDollars(values.amount) : null;
  const warning = goodwillWarning(typed, overage.goodwill, overage.lastGoodwillAt, cap);
  // Past the cap, staff see what g1t absorbs in red, with the reason, before it goes.
  if (warning.overCap && form.get("confirm") !== "yes") {
    return {
      review: {
        workspace: overage.workspace,
        amount: values.amount ?? "",
        day: values.day ?? "",
        reason: values.reason ?? "",
        ...warning,
        amountMicros: typed ?? overage.goodwill.creditMicros,
      },
    } satisfies ActionResult;
  }
  if (!parsed.ok) return fail(parsed.error);
  const result = await admin.goodwill(overage.workspace, parsed.value.amountMicros, parsed.value.reason, staff.email, parsed.value.day);
  if (!result.ok) return fail(result.error.message);
  throw redirect("/overages?done=goodwill");
}

export default function Overages({ loaderData, actionData }: Route.ComponentProps) {
  const { queue, error, cap, done } = loaderData;
  const result = actionData as ActionResult | undefined;
  const review = result && "review" in result ? result.review : null;
  const totals = queue.reduce(
    (sum, row) => ({
      overage: sum.overage + row.goodwill.overageMicros,
      margin: sum.margin + row.goodwill.marginMicros,
      absorbed: sum.absorbed + (row.goodwillAvailable ? row.goodwill.absorbedMicros : 0),
    }),
    { overage: 0, margin: 0, absorbed: 0 },
  );
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Overages"
        description={
          <>
            Workspaces whose month went well past their usual (twice it, and $10 over), hit a spend spike, or asked for help. A goodwill credit
            always returns g1t's margin on the overage and absorbs at most {usd(cap)} of real cost in one click, once per workspace in 12 months.
          </>
        }
      />
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Billing did not answer for overages: {error}</Notice>}
      </div>
      {queue.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="In the queue" value={String(queue.length)} hint={`${queue.filter((row) => row.request).length} asked for help`} />
          <Stat label="Over their usual" value={usd(totals.overage)} hint="This month, above each typical month" />
          <Stat label="g1t's margin in it" value={usd(totals.margin)} hint="Returned by any goodwill credit" />
          <Stat label="Real cost, if all forgiven" value={usd(totals.absorbed)} hint="One-click credits still available" tone={totals.absorbed > 0 ? "warn" : undefined} />
        </div>
      )}
      {review && <ReviewPanel review={review} cap={cap} />}
      <div className="mt-6 space-y-4">
        {queue.length === 0 && !error ? (
          <EmptyState title="No overages this month">Workspaces show up here when a month runs well past their usual, or a spike pauses them.</EmptyState>
        ) : (
          queue.map((row) => (
            <OverageCard
              key={row.workspace}
              row={row}
              cap={cap}
              error={result && "error" in result && result.workspace === row.workspace ? result : null}
            />
          ))
        )}
      </div>
    </main>
  );
}

/** Past the cap: what g1t absorbs in red, and the reason, before it is given. */
function ReviewPanel({ review, cap }: { review: Review; cap: number }) {
  const { pathname } = useLocation();
  return (
    <section id="review" className="mt-6 scroll-mt-20 rounded-lg border border-danger/50 bg-danger/8 p-4 sm:p-5">
      <h2 className="flex items-center gap-2 font-semibold tracking-tight text-danger">
        <AlertTriangle size={16} />
        g1t absorbs {usd(review.absorbedMicros)} of real cost
      </h2>
      <p className="mt-2 text-sm text-fg-soft">
        A {usd(review.amountMicros)} credit to <span className="font-mono">{review.workspace}</span> is past the {usd(cap)} a goodwill credit
        absorbs in one click. That is money g1t already paid Cloudflare and model providers. Say why, for whoever looks next; it goes in the
        audit log with your email.
      </p>
      <form method="post" action={`${pathname}#review`} className="mt-4 space-y-3">
        <Hidden values={{ workspace: review.workspace, amount: review.amount, day: review.day, confirm: "yes" }} />
        <Field label="Reason" hint="Required: a sentence at least.">
          <Textarea name="reason" rows={2} required minLength={10} maxLength={500} defaultValue={review.reason} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="danger">
            Give {usd(review.amountMicros)} anyway
          </Button>
          <Link to="/overages" className="px-2 text-sm text-muted hover:text-fg">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}

function OverageCard({ row, cap, error }: { row: Overage; cap: number; error: { error: string; values: Record<string, string> } | null }) {
  const { pathname } = useLocation();
  const { goodwill } = row;
  const spike = row.spike ? spikeLabel(row.spike.status) : null;
  const choices = goodwillChoices(goodwill).map((choice) => ({
    ...choice,
    ...goodwillWarning(choice.micros, goodwill, row.lastGoodwillAt, cap),
    amount: choice.micros ?? goodwill.creditMicros,
  }));
  return (
    <section id={row.workspace} className="scroll-mt-20 rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Link to={`/workspaces/${encodeURIComponent(row.workspace)}#billing`} className="font-mono font-medium text-fg hover:underline">
              {row.workspace}
            </Link>
            <Badge>{row.plan}</Badge>
            {spike && <Badge tone={spike.tone === "plain" ? "plain" : spike.tone}>{spike.label}</Badge>}
            {row.request && <Badge tone="warn">Asked for help</Badge>}
            {!row.goodwillAvailable && <Badge tone="danger">Goodwill given{" "}<When at={row.lastGoodwillAt} /></Badge>}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            Typical month {usd(row.typicalMonthMicros)} · this month {usd(row.thisMonthMicros)} · cost to g1t {usd(row.costMicros)}
          </p>
        </div>
      </header>
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          {row.request && (
            <blockquote className="border-l-2 border-warn/50 pl-3 text-sm break-words whitespace-pre-line text-fg-soft">
              “{row.request.reason}” <span className="text-xs text-faint">— {row.request.createdBy}</span>
            </blockquote>
          )}
          <div>
            <p className="text-xs font-medium text-muted">The goodwill math</p>
            <dl className="mt-2 space-y-1 text-sm">
              <Line label="Over the typical month" value={usd(goodwill.overageMicros)} />
              <Line label="g1t's margin on it, always returned" value={usd(goodwill.marginMicros)} tone="mint" />
              <Line label="What it cost g1t" value={usd(goodwill.costMicros)} />
              <Line label={`Real cost absorbed in one click (at most ${usd(cap)})`} value={usd(goodwill.absorbedMicros)} tone="warn" />
              <Line label="One-click credit" value={usd(goodwill.creditMicros)} strong />
            </dl>
          </div>
          {row.topEntries.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted">What caused it</p>
              <ul className="mt-2 divide-y divide-line rounded-md border border-line text-xs">
                {row.topEntries.slice(0, 5).map((entry) => (
                  <li key={entry.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block break-words text-fg-soft">{entry.description}</span>
                      <span className="font-mono text-faint">
                        {[entry.repo && (entry.number != null ? `${entry.repo}#${entry.number}` : entry.repo), entry.task, entry.model].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="tabular shrink-0">{usd(-entry.amountMicros)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <ul className="space-y-2">
            {choices.map((choice) => (
              <li
                key={choice.label}
                className={`rounded-md border px-3 py-2 text-sm ${choice.overCap ? "border-danger/50 bg-danger/8" : "border-line bg-bg"}`}
              >
                <p className="flex justify-between gap-3">
                  <span className="font-medium">{choice.label}</span>
                  <span className="tabular">{usd(choice.amount)}</span>
                </p>
                <p className={`mt-0.5 text-xs ${choice.overCap ? "text-danger" : "text-muted"}`}>
                  Returns {usd(Math.min(choice.amount, goodwill.marginMicros))} of margin; g1t absorbs {usd(choice.absorbedMicros)} of real cost
                  {choice.overCap ? `, past the ${usd(cap)} cap` : ""}.{choice.needsReason ? " Needs a reason." : ""}
                </p>
              </li>
            ))}
          </ul>
          <form method="post" action={`${pathname}#${row.workspace}`} className="space-y-3">
            <input type="hidden" name="workspace" value={row.workspace} />
            {error && <Notice tone="error">{error.error}</Notice>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount $" hint="Blank: the one-click credit.">
                <Input name="amount" inputMode="decimal" placeholder={dollarsField(goodwill.creditMicros)} defaultValue={error?.values.amount ?? ""} />
              </Field>
              <Field label="Day of the usage" hint="Blank: the spike's day, or today.">
                <Input type="date" name="day" defaultValue={error?.values.day ?? row.spike?.detectedAt.slice(0, 10) ?? ""} />
              </Field>
            </div>
            <Field label="Reason" hint={row.goodwillAvailable ? "Needed past the one-click credit." : "Needed: a credit was given in the last 12 months."}>
              <Textarea name="reason" rows={2} maxLength={500} defaultValue={error?.values.reason ?? ""} placeholder="e.g. A review loop ran overnight on a misconfigured workflow." />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-faint">On their statement as “{goodwillLine("YYYY-MM-DD")}”.</p>
              <Button type="submit" variant="lavender">
                <Gift size={14} />
                Give goodwill credit
              </Button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

function Line({ label, value, tone, strong = false }: { label: string; value: string; tone?: "mint" | "warn"; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-line pt-1 font-medium" : ""}`}>
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular ${tone === "mint" ? "text-success" : tone === "warn" ? "text-warn" : "text-fg"}`}>{value}</dd>
    </div>
  );
}
