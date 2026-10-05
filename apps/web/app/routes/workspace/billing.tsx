import { ArrowUpRight, CreditCard, FileText, Receipt, Rocket, Users } from "lucide-react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import {
  DEPLOYMENTS_ALLOWANCE,
  MICROS_PER_DOLLAR,
  type DeployUsage,
  type Entitlements,
  type Feature,
  type FeatureState,
  type Limit,
  type WorkspaceInvoice,
} from "@g1t/contracts";

import type { Route } from "./+types/billing";
import { page } from "../../lib/meta";
import { StatementView } from "../../components/statement";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Button, ErrorText } from "../../components/ui";
import { billing, deployments } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";

/** What can be added in one payment, in dollars. */
const AMOUNTS = [10, 25, 50, 100];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Billing · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Members only; to anyone else the page does not exist.
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();

  // Back from the payment page: credit it, then drop the id from the address.
  const url = new URL(request.url);
  const session = url.searchParams.get("session");
  if (session) {
    // The same page returns from both a credit payment and a plan.
    if (url.searchParams.get("plan")) {
      await billing.confirmSubscription(slug, viewer, session);
      throw redirect(`/${slug}/-/billing?subscribed=1`);
    }
    await billing.confirm(slug, viewer, session);
    throw redirect(`/${slug}/-/billing?added=1`);
  }
  const group: "day" | "project" = url.searchParams.get("group") === "project" ? "project" : "day";
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [account, statement, features, deployUsage, limit, invoices, thisMonth, allTime, entitlements] = await Promise.all([
    billing.account(slug, viewer),
    billing.statement(slug, viewer, url.searchParams.get("month"), group),
    billing.features(slug, viewer),
    deployments.usage(slug, viewer),
    billing.limit(slug, viewer),
    billing.invoices(slug, viewer).catch(() => null),
    billing.usage(slug, viewer, monthStart).catch(() => null),
    billing.usage(slug, viewer, "1970-01-01T00:00:00.000Z").catch(() => null),
    billing.entitlements(slug).catch(() => null),
  ]);
  return {
    slug,
    role,
    account: unwrap(account),
    statement: unwrap(statement),
    group,
    features: unwrap(features),
    deployUsage: deployUsage.ok ? deployUsage.value : null,
    limit: limit.ok ? limit.value : null,
    invoices: invoices?.ok ? invoices.value : [],
    spent: {
      month: thisMonth?.ok ? thisMonth.value.spentMicros : null,
      total: allTime?.ok ? allTime.value.spentMicros : null,
      added: allTime?.ok ? allTime.value.addedMicros : null,
    },
    entitlements,
    added: url.searchParams.has("added"),
    subscribed: url.searchParams.has("subscribed"),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const page = `${new URL(request.url).origin}/${params.owner.toLowerCase()}/-/billing`;
  const intent = form.get("intent");
  if (intent === "portal") {
    // Card, invoices and billing details live on Stripe's own page.
    const started = await billing.billingPortal(user, params.owner, page);
    if (!started.ok) return { error: started.error.message };
    throw redirect(started.value.url);
  }
  if (intent === "spend-limit") {
    // automatic, fixed (with an amount), or none.
    const mode = String(form.get("mode") ?? "automatic");
    const amount = Number(form.get("limit"));
    if (mode === "fixed" && !(Number.isFinite(amount) && amount >= 1)) {
      return { error: "A spend limit is a dollar amount, $1 or more." };
    }
    const set = await billing.setSpendLimit(
      user,
      params.owner,
      mode === "fixed" ? Math.round(amount * MICROS_PER_DOLLAR) : null,
      mode === "none",
    );
    return set.ok ? null : { error: set.error.message };
  }
  if (intent === "subscribe" || intent === "cancel" || intent === "resume") {
    const feature = String(form.get("feature")) as Feature;
    if (intent !== "subscribe") {
      const changed = await billing.cancelSubscription(user, params.owner, feature, intent === "resume");
      return changed.ok ? null : { error: changed.error.message };
    }
    const started = await billing.subscribe(user, params.owner, feature, `${page}?plan=${feature}`);
    if (!started.ok) return { error: started.error.message };
    throw redirect(started.value.url);
  }
  const dollars = Math.trunc(Number(form.get("amount")));
  const started = await billing.checkout(
    user,
    params.owner,
    Number.isFinite(dollars) ? dollars * 100 : 0,
    // Spelled out: a form post arrives at a data address, not the page's.
    `${new URL(request.url).origin}/${params.owner.toLowerCase()}/-/billing`,
  );
  if (!started.ok) return { error: started.error.message };
  throw redirect(started.value.url);
}

/** Millionths of a dollar as dollars, to the cent or finer. */
function dollars(micros: number, digits = 2): string {
  const sign = micros < 0 ? "−" : "";
  return `${sign}$${(Math.abs(micros) / MICROS_PER_DOLLAR).toFixed(digits)}`;
}

export default function WorkspaceBilling({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, account, statement, group, spent, features, deployUsage, limit, invoices, entitlements, added, subscribed } =
    loaderData;
  const { status } = account;
  const paying = useNavigation().state === "submitting";
  const empty = account.balanceMicros <= 0;
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        {status.free && (
          <div className="mb-8 rounded-xl border border-accent/30 bg-accent/5 p-5">
            <h2 className="font-medium">Free while g1t is being built out</h2>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">
              While we build g1t out, using it costs nothing: agents, reviews, checks and workflows. Bring your own
              model provider under Integrations and its usage is billed by that provider, not by g1t. Runs are still
              recorded with what they cost, so Usage shows what you are using. This is for now, not forever: pricing
              will come later, and we will say so well before anything is charged.
            </p>
          </div>
        )}
        {account.status.enabled && (
          <section className="mb-8 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/30">
              <Receipt size={18} />
            </span>
            <div className="min-w-0 grow">
              <h2 className="font-medium">Billing on Stripe</h2>
              <p className="mt-0.5 text-sm text-muted">
                {account.card
                  ? `${account.card.brand[0].toUpperCase()}${account.card.brand.slice(1)} ending ${account.card.last4}. `
                  : "No card yet. "}
                Your card, invoices and receipts, and the billing email, address and tax ID.
              </p>
            </div>
            {role === "owner" ? (
              <Form method="post">
                <Button variant="accent" type="submit" name="intent" value="portal" disabled={paying}>
                  Open Stripe billing
                  <ArrowUpRight size={14} />
                </Button>
              </Form>
            ) : (
              <p className="text-xs text-faint">An owner manages billing.</p>
            )}
          </section>
        )}

        {limit && account.status.enabled && (
          <LimitCard limit={limit} owner={role === "owner"} busy={paying} error={actionData?.error} />
        )}

        {account.status.enabled && (
          <section className="mb-10 rounded-xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">Card and invoices</h2>
                {account.card ? (
                  <p className="mt-1 text-sm">
                    <span className="capitalize">{account.card.brand}</span> ending{" "}
                    <span className="font-mono">{account.card.last4}</span>
                    <span className="text-muted">
                      {" "}
                      · expires {String(account.card.expMonth).padStart(2, "0")}/{account.card.expYear}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 max-w-xl text-sm text-muted">
                    No card yet. With one on file, g1t charges it as the workspace nears its usage limit and when each
                    month closes, so work never stops for a payment. Saving it charges nothing.
                  </p>
                )}
                <p className="mt-2 max-w-xl text-xs text-faint">
                  Cards, invoices, receipts and the billing email and address are managed on Stripe's billing page. g1t
                  never sees card numbers.
                </p>
              </div>
              {role === "owner" && (
                <Form method="post">
                  <Button variant={account.card ? "quiet" : "accent"} type="submit" name="intent" value="portal" disabled={paying}>
                    <CreditCard size={14} />
                    {account.card ? "Manage billing on Stripe" : "Add a card on Stripe"}
                  </Button>
                </Form>
              )}
            </div>
            {account.card && (
              <p className="mt-3 text-xs text-faint">
                Charged near the usage limit, for what the workspace owes, and when each month closes. A declined card
                stops work until it is paid.
              </p>
            )}
            {!account.status.live && (
              <p className="mt-3 text-xs text-faint">
                Test mode: use card 4242 4242 4242 4242, any future date and code. Test cards are never charged
                automatically.
              </p>
            )}
          </section>
        )}

        {invoices.length > 0 && <InvoiceList invoices={invoices} />}

        <h2 className="font-medium">Plans</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Plans are turned on per workspace, at one flat price a month for everyone in it: never per person. They are
          charged including while the rest of g1t is free.
        </p>
        {subscribed && <p className="mt-3 text-sm text-accent">Payment received. The plan is on.</p>}
        <div className="mt-5 space-y-4">
          {features.map((state) => (
            <PlanCard
              key={state.plan.feature}
              state={state}
              owner={role === "owner"}
              enabled={account.status.enabled}
              live={account.status.live}
              busy={paying}
              usage={state.plan.feature === "deployments" ? deployUsage : null}
              entitlements={entitlements}
            />
          ))}
        </div>
        <div className="mt-2">
          <ErrorText>{actionData?.error}</ErrorText>
        </div>

        <h2 className="mt-12 font-medium">Agent credit</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          g1t agents that work on this workspace's repositories are paid for from
          its account: what the model cost, plus {account.marginPercent}%. Every sandbox, for agents, checks, the merge
          queue and workflows, is metered by the second, from the first. Credit added here pays usage in
          advance; the usage limit above decides whether work starts.
        </p>

        <div
          className={`mt-5 rounded-xl border p-5 ${
            empty && status.enabled ? "border-warn/40 bg-warn/5" : "border-line bg-surface"
          }`}
        >
          <dl className="flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <dt className="text-xs text-muted">Balance</dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
                {dollars(account.balanceMicros)}
              </dd>
            </div>
            {spent.month !== null && (
              <div>
                <dt className="text-xs text-muted">Spent this month</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums">{dollars(spent.month)}</dd>
              </div>
            )}
            {spent.total !== null && (
              <div>
                <dt className="text-xs text-muted">Spent in total</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums">{dollars(spent.total)}</dd>
              </div>
            )}
            {spent.added !== null && spent.added !== 0 && (
              <div>
                <dt className="text-xs text-muted">Paid and credited in total</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums text-muted">{dollars(spent.added)}</dd>
              </div>
            )}
          </dl>
          {added && (
            <p className="mt-2 text-sm text-accent">Payment received. Credit added.</p>
          )}
          {status.free && !features.some((state) => state.on && state.subscription) ? (
            <p className="mt-3 text-sm text-muted">
              Nothing to add for now: runs are free while g1t is being built out. Credit already here stays for when
              pricing starts.
            </p>
          ) : !status.enabled ? (
            <p className="mt-3 text-sm text-muted">
              Payments are not set up on this g1t yet, so nothing is charged and
              agents are limited to selected accounts.
            </p>
          ) : role === "owner" ? (
            <Form method="post" className="mt-4">
              <p className="text-sm text-muted">
                {status.free
                  ? "Agents are free for now; credit pays for plan usage past its allowance. Add credit by card:"
                  : "Add credit by card:"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {AMOUNTS.map((amount) => (
                  <Button
                    key={amount}
                    variant={amount === 25 ? "accent" : "quiet"}
                    type="submit"
                    name="amount"
                    value={amount}
                    disabled={paying}
                  >
                    <CreditCard size={14} />${amount}
                  </Button>
                ))}
              </div>
              {!status.live && (
                <p className="mt-3 text-xs text-faint">
                  Payments are in test mode. No real card is charged; use Stripe's
                  test card 4242 4242 4242 4242 with any future date and any code.
                </p>
              )}
            </Form>
          ) : (
            <p className="mt-3 text-sm text-muted">An owner can add credit.</p>
          )}
        </div>

        <StatementView slug={slug} statement={statement} group={group} />
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">How it is charged</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>
              Usage is charged after it runs, to the workspace that owns the repository: models, sandbox time, builds
              and apps at what they cost g1t plus {account.marginPercent}%, which pays for running and building g1t.
              Nothing is bundled in.
            </li>
            <li>
              Each month closes with an itemised invoice, charged to the card on file. Near your limit, g1t sends one
              sooner, so work keeps going.
            </li>
            <li>
              With your own model provider, connected under{" "}
              <Link to={`/${slug}/-/integrations`} className="text-fg hover:underline">
                Integrations
              </Link>
              , the provider bills you for the model, and a run here is charged only its sandbox time.
            </li>
            <li>
              Work on public repositories is paid for by g1t's open-source pool first, up to a monthly cap per
              repository; the statement says so on each line it paid.
            </li>
            <li>
              No card is charged less than {dollars(entitlements?.minChargeMicros ?? 5 * MICROS_PER_DOLLAR, 0)}: smaller
              amounts carry over to the next invoice.
            </li>
            <li>No seats: add as many people and agents as you like.</li>
          </ul>
          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <Link to={`/${slug}/-/usage`} className="flex items-center gap-2 text-muted hover:text-fg">
              <FileText size={14} /> Usage, run by run
            </Link>
            <a href="https://g1t.sh/pricing" className="flex items-center gap-2 text-muted hover:text-fg">
              <CreditCard size={14} /> Today's prices
            </a>
            <a
              href="https://docs.g1t.sh/guides/usage-and-billing/"
              className="flex items-center gap-2 text-muted hover:text-fg"
            >
              <ArrowUpRight size={14} /> How usage and billing work
            </a>
          </div>
        </section>
      </aside>
    </div>
  );
}

/** A paid feature: what it costs and includes, and its plan. */
function PlanCard({
  state,
  owner,
  enabled,
  live,
  busy,
  usage,
  entitlements,
}: {
  state: FeatureState;
  owner: boolean;
  enabled: boolean;
  live: boolean;
  busy: boolean;
  usage: DeployUsage | null;
  entitlements: Entitlements | null;
}) {
  const { plan, subscription } = state;
  const ending = subscription?.status === "canceling";
  const owed = subscription?.status === "past_due";
  const team = plan.feature === "team";
  const Icon = team ? Users : Rocket;
  return (
    <section
      className={`rounded-xl border p-5 ${
        (state.on && subscription) || state.included
          ? "border-accent/40 bg-accent/5"
          : owed
            ? "border-warn/40 bg-warn/5"
            : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 font-medium">
            <Icon size={15} className="text-accent" />
            {plan.title}
            {state.included && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">Included, no charge</span>
            )}
            {state.on && subscription && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                {ending ? "Ends " : "On"}
                {subscription.periodEnd && (
                  <>
                    {ending ? "" : " · renews "}
                    {new Date(subscription.periodEnd).toLocaleDateString()}
                  </>
                )}
              </span>
            )}
            {owed && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">Payment failed</span>}
          </h3>
          <p className="mt-1 text-sm text-muted">
            {team
              ? "For a workspace that works here every day: a monthly usage credit, more private storage and a longer audit log, at one price for everyone in it."
              : "Every pull request gets a live preview on g1t.page, and the default branch goes to production on merge."}
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            ${(plan.monthlyCents / 100).toFixed(0)}
          </span>
          <span className="text-sm text-muted"> / month</span>
          {team && <span className="block text-xs text-faint">per workspace</span>}
        </p>
      </div>
      <ul className="mt-4 grid gap-1.5 text-sm text-muted sm:grid-cols-2">
        {plan.includes.map((line) => (
          <li key={line} className="flex gap-2">
            <span className="text-accent">✓</span>
            {line}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-faint">{plan.overage}</p>
      {state.on && usage && <DeployMeter usage={usage} entitlements={entitlements} />}
      {team && state.on && entitlements?.team && <TeamMeter entitlements={entitlements} />}
      {state.included ? (
        <p className="mt-4 text-sm text-muted">
          {plan.title} is on for this workspace at no charge, under terms g1t set with it.
        </p>
      ) : !enabled ? (
        <p className="mt-4 text-sm text-muted">Payments are not set up on this g1t, so {plan.title} is already on.</p>
      ) : !owner ? (
        !state.on && <p className="mt-4 text-sm text-muted">An owner can turn it on.</p>
      ) : (
        <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="feature" value={plan.feature} />
          {!state.on || !subscription ? (
            <Button variant="accent" type="submit" name="intent" value="subscribe" disabled={busy}>
              <CreditCard size={14} />
              Turn on {plan.title}
            </Button>
          ) : ending ? (
            <Button variant="quiet" type="submit" name="intent" value="resume" disabled={busy}>
              Keep {plan.title}
            </Button>
          ) : (
            <Button variant="quiet" type="submit" name="intent" value="cancel" disabled={busy}>
              Turn off at the end of the period
            </Button>
          )}
          {!live && !state.on && (
            <span className="text-xs text-faint">Test mode: card 4242 4242 4242 4242, any future date and code.</span>
          )}
        </Form>
      )}
    </section>
  );
}

/** This month's Team credit: what of it the month's usage has drawn. */
function TeamMeter({ entitlements }: { entitlements: Entitlements }) {
  const used = entitlements.teamCreditUsedMicros;
  const of = entitlements.teamCreditMicros;
  return (
    <div className="mt-4 rounded-lg border border-line bg-bg/40 p-4">
      <div className="flex justify-between gap-4 text-sm">
        <span className="text-muted">Credit used this month</span>
        <span className="tabular-nums">
          {dollars(used)} <span className="text-faint">of {dollars(of)}</span>
        </span>
      </div>
      <Meter used={used} of={of} state={used >= of ? "warning" : "ok"} />
      <p className="mt-3 text-xs text-faint">
        Usage draws on the credit first, at cost plus 20%; past it, usage is charged as usual. It starts again on the
        1st, and what is unused does not carry over.
      </p>
    </div>
  );
}

/** This month's use of the Deployments plan against what it includes. */
function DeployMeter({ usage, entitlements }: { usage: DeployUsage; entitlements: Entitlements | null }) {
  const a = DEPLOYMENTS_ALLOWANCE;
  const buildMinutes = (entitlements?.buildSecondsIncluded ?? a.buildSeconds) / 60;
  const rows: [string, number, number, (n: number) => string][] = [
    ["Apps up at once (most this month)", usage.peakApps, a.apps, (n) => String(n)],
    ["Build minutes", Math.ceil(usage.buildSeconds / 60), buildMinutes, (n) => n.toLocaleString("en-US")],
    ["Requests", usage.requests, a.requests, (n) => n.toLocaleString("en-US")],
    ["CPU milliseconds", usage.cpuMs, a.cpuMs, (n) => n.toLocaleString("en-US")],
  ];
  return (
    <div className="mt-4 rounded-lg border border-line bg-bg/40 p-4">
      <p className="text-xs font-medium text-muted">This month ({usage.month})</p>
      <ul className="mt-2 space-y-2.5">
        {rows.map(([label, used, included, show]) => (
          <li key={label} className="text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted">{label}</span>
              <span className={`tabular-nums ${used > included ? "text-warn" : ""}`}>
                {show(used)} <span className="text-faint">of {show(included)}</span>
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
              <div
                className={`h-full rounded-full ${used > included ? "bg-warn" : "bg-accent"}`}
                style={{ width: `${Math.min(100, (used / included) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-faint">
        Builds past the included minutes are charged by the second; this month's builds cost g1t{" "}
        {dollars(usage.buildMicros, 4)} in all.
        {usage.countedAt ? " Requests and CPU time are counted every few minutes." : " Requests are counted once apps get visits."}
      </p>
    </div>
  );
}

const TRUST: Record<Limit["trust"], { label: string; detail: string }> = {
  new: { label: "New", detail: "No payment to g1t yet." },
  paid: { label: "Paid", detail: "Grows with every payment." },
  established: { label: "Established", detail: "Follows your monthly spend." },
  reviewed: { label: "Reviewed", detail: "Set by g1t for this workspace." },
  internal: { label: "Comped", detail: "g1t covers this workspace's usage: nothing is charged, and there is no limit." },
};

/** One meter: how much of a limit is used. */
function Meter({ used, of, state }: { used: number; of: number | null; state: "ok" | "warning" | "stopped" }) {
  const share = of ? Math.min(1, used / Math.max(of, 1)) : 0;
  const bar = state === "stopped" ? "bg-danger" : state === "warning" ? "bg-warn" : "bg-accent";
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
      <div className={`h-full ${bar}`} style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
    </div>
  );
}

function meterState(used: number, of: number | null): "ok" | "warning" | "stopped" {
  if (of == null) return "ok";
  if (used >= of) return "stopped";
  return used * 5 >= of * 4 ? "warning" : "ok";
}

/**
 * The workspace's two limits, side by side: the owners' monthly spend
 * limit, which protects them from a surprise; and what g1t lets go unpaid,
 * which grows with what they pay and is charged to the card as it nears.
 */
function LimitCard({ limit, owner, busy, error }: { limit: Limit; owner: boolean; busy: boolean; error?: string }) {
  const tone =
    limit.state === "stopped" ? "border-danger/40 bg-danger/5" : limit.state === "warning" ? "border-warn/40 bg-warn/5" : "border-line bg-surface";
  const trust = TRUST[limit.trust];
  const spent = limit.spentMicros ?? 0;
  const spendLimit = limit.spendLimitMicros;
  const available = limit.availableMicros ?? limit.ceilingMicros;
  const mode = limit.defaultSpendLimit ? "automatic" : spendLimit == null ? "none" : "fixed";
  if (limit.trust === "internal") {
    return (
      <section className="mb-10 rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">Limits</h2>
          <span className="rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent">Comped</span>
        </div>
        <p className="mt-1 text-sm text-muted">{trust.detail}</p>
      </section>
    );
  }
  return (
    <section className={`mb-10 rounded-xl border p-5 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Limits</h2>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{trust.label}</span>
      </div>
      {limit.account.startsWith("ent_") && (
        <p className="mt-1 text-sm text-muted">
          Paid for by the <span className="font-medium text-fg">{limit.accountName}</span> enterprise: these figures are
          for all of its workspaces together.
        </p>
      )}

      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted">Spent this month</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
            {dollars(spent)}
            <span className="text-base font-normal text-muted">
              {spendLimit == null ? " · no spend limit" : ` of ${dollars(spendLimit)}`}
            </span>
          </p>
          {spendLimit != null && <Meter used={spent} of={spendLimit} state={meterState(spent, spendLimit)} />}
          <p className="mt-2 text-xs text-faint">
            {mode === "automatic"
              ? "Your spend limit is automatic: $200, or twice last month's spend, so it keeps up as you grow."
              : mode === "fixed"
                ? "A spend limit you set. At it, work stops until the month turns."
                : "No spend limit: work never stops for spend, only for what g1t lets go unpaid."}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Not yet paid</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
            {dollars(limit.exposureMicros)}
            <span className="text-base font-normal text-muted">
              {available == null ? "" : ` of ${dollars(available)} available`}
            </span>
          </p>
          {available != null && (
            <Meter used={limit.exposureMicros} of={available} state={meterState(limit.exposureMicros, available)} />
          )}
          <p className="mt-2 text-xs text-faint">
            With a card on file, g1t charges it as this nears what is available, so work keeps going.
            {limit.growth ? ` ${limit.growth}` : ""}
          </p>
        </div>
      </div>

      {limit.message && <p className="mt-4 text-sm">{limit.message}</p>}

      {owner && (
        <Form method="post" className="mt-5 border-t border-line pt-4">
          <fieldset>
            <legend className="text-xs text-muted">Your monthly spend limit</legend>
            <RadioGroup name="mode" defaultValue={mode} className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="automatic" />
                Automatic
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="fixed" />
                Fixed at
                <span className="flex items-center rounded-md border border-line bg-bg px-2 focus-within:border-accent">
                  <span className="text-muted">$</span>
                  <input
                    name="limit"
                    type="number"
                    min={1}
                    step={1}
                    defaultValue={mode === "fixed" && spendLimit != null ? spendLimit / MICROS_PER_DOLLAR : ""}
                    placeholder="500"
                    className="w-24 bg-transparent px-1 py-1 tabular-nums outline-none"
                  />
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="none" />
                None
              </label>
              <Button variant="quiet" type="submit" name="intent" value="spend-limit" disabled={busy}>
                Save
              </Button>
            </RadioGroup>
          </fieldset>
          <ErrorText>{error}</ErrorText>
          <p className="mt-3 text-xs text-faint">
            Need more than {available != null ? dollars(available) : "this"} available?{" "}
            <a href="mailto:billing@g1t.sh" className="text-fg hover:underline">
              Contact us
            </a>{" "}
            and we will set terms that fit.
          </p>
        </Form>
      )}
    </section>
  );
}

/** The workspace's invoices from g1t, each kept on Stripe with its PDF. */
function InvoiceList({ invoices }: { invoices: WorkspaceInvoice[] }) {
  return (
    <section className="mb-10">
      <h2 className="font-medium">Invoices</h2>
      <p className="mt-1 text-sm text-muted">
        One when each month closes, and one each time g1t charges the card near your limit. Receipts and PDFs are also
        on Stripe's billing page.
      </p>
      <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {invoices.map((invoice) => (
          <li key={invoice.invoiceId} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">
                {invoice.reason === "month" ? `Usage for ${invoice.period}` : `Charged near the limit, ${invoice.period}`}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  invoice.status === "paid" ? "border-accent/40 text-accent" : "border-danger/40 text-danger"
                }`}
              >
                {invoice.status === "paid" ? "Paid" : invoice.status === "failed" ? "Payment failed" : invoice.status}
              </span>
              <span className="ml-auto font-mono tabular-nums">{dollars(invoice.amountMicros)}</span>
              {invoice.hostedUrl && (
                <a href={invoice.hostedUrl} className="text-xs text-muted hover:text-fg">
                  View
                </a>
              )}
              {invoice.pdfUrl && (
                <a href={invoice.pdfUrl} className="text-xs text-muted hover:text-fg">
                  PDF
                </a>
              )}
            </div>
            <ul className="mt-1.5 space-y-0.5 text-xs text-faint">
              {invoice.lines.map((line) => (
                <li key={line.description} className="flex justify-between gap-4">
                  <span>{line.description}</span>
                  <span className="font-mono tabular-nums">{dollars(line.amountMicros)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
