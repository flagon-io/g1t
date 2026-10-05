import { CreditCard, Rocket } from "lucide-react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import {
  DEPLOYMENTS_ALLOWANCE,
  MICROS_PER_DOLLAR,
  type DeployUsage,
  type Feature,
  type FeatureState,
  type Limit,
} from "@g1t/contracts";

import type { Route } from "./+types/billing";
import { Button, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
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

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Billing · ${params.owner} · g1t` }];
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
  const [account, ledger, features, deployUsage, limit] = await Promise.all([
    billing.account(slug, viewer),
    billing.ledger(slug, viewer),
    billing.features(slug, viewer),
    deployments.usage(slug, viewer),
    billing.limit(slug, viewer),
  ]);
  return {
    slug,
    role,
    account: unwrap(account),
    ledger: unwrap(ledger),
    features: unwrap(features),
    deployUsage: deployUsage.ok ? deployUsage.value : null,
    limit: limit.ok ? limit.value : null,
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
  if (intent === "spend-limit" || intent === "no-spend-limit") {
    const amount = Number(form.get("limit"));
    if (intent === "spend-limit" && !(Number.isFinite(amount) && amount >= 0)) {
      return { error: "A spend limit is a dollar amount." };
    }
    const set = await billing.setSpendLimit(
      user,
      params.owner,
      intent === "spend-limit" ? Math.round(amount * MICROS_PER_DOLLAR) : null,
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
  const { slug, role, account, ledger, features, deployUsage, limit, added, subscribed } = loaderData;
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
        {limit && account.status.enabled && (
          <LimitCard limit={limit} owner={role === "owner"} busy={paying} error={actionData?.error} />
        )}

        <h2 className="font-medium">Plans</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Paid features are turned on per workspace with a monthly plan. They are never free, including while the rest of
          g1t is.
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
          queue and workflows, is metered by the second past 500 free minutes a month. Credit added here pays usage in
          advance; the usage limit above decides whether work starts.
        </p>

        <div
          className={`mt-5 rounded-xl border p-5 ${
            empty && status.enabled ? "border-warn/40 bg-warn/5" : "border-line bg-surface"
          }`}
        >
          <p className="text-xs text-muted">Balance</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
            {dollars(account.balanceMicros)}
          </p>
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

        <h3 className="mt-10 text-sm font-medium text-muted">Statement</h3>
        <div className="mt-3">
          {ledger.length === 0 ? (
            <EmptyState title="Nothing yet">
              Each agent run and each payment appears here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {ledger.map((entry) => (
                <li key={entry.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                  <div className="min-w-0 grow">
                    {entry.repo && entry.number ? (
                      <Link
                        to={`/${entry.repo}/pull/${entry.number}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {entry.description}
                      </Link>
                    ) : (
                      <p className="truncate font-medium">{entry.description}</p>
                    )}
                    <p className="mt-0.5 text-xs text-faint">
                      <TimeAgo at={entry.createdAt} />
                      {entry.model && ` · ${entry.model}`}
                      {entry.createdBy && ` · ${entry.createdBy}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm tabular-nums ${
                      entry.amountMicros > 0 ? "text-accent" : "text-muted"
                    }`}
                  >
                    {entry.amountMicros > 0 && "+"}
                    {dollars(entry.amountMicros, entry.kind === "usage" ? 4 : 2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">How it is charged</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>
              Each run is charged when it finishes, to the workspace that owns the
              repository, whoever assigned the issue.
            </li>
            <li>
              A change, a review, a revision and a catch-up are each a run. The
              statement links each to its pull request.
            </li>
            <li>
              Every pull request's session ends with what that run cost before
              the margin.
            </li>
            <li>
              With your own model provider, connected under{" "}
              <Link to={`/${slug}/-/integrations`} className="text-fg hover:underline">
                Integrations
              </Link>
              , the provider bills you for the model and each run here is a flat{" "}
              {dollars(account.orchestrationFeeMicros)}
              {status.free && " once pricing starts; nothing while g1t is being built out"}.
            </li>
            <li>
              Only members of <span className="font-mono text-fg">{slug}</span> can
              put agents to work on its repositories.
            </li>
          </ul>
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
}: {
  state: FeatureState;
  owner: boolean;
  enabled: boolean;
  live: boolean;
  busy: boolean;
  usage: DeployUsage | null;
}) {
  const { plan, subscription } = state;
  const ending = subscription?.status === "canceling";
  const owed = subscription?.status === "past_due";
  return (
    <section
      className={`rounded-xl border p-5 ${
        state.on && subscription
          ? "border-accent/40 bg-accent/5"
          : owed
            ? "border-warn/40 bg-warn/5"
            : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 font-medium">
            <Rocket size={15} className="text-accent" />
            {plan.title}
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
            Every pull request gets a live preview on g1t.page, and the default branch goes to production on merge.
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            ${(plan.monthlyCents / 100).toFixed(0)}
          </span>
          <span className="text-sm text-muted"> / month</span>
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
      {state.on && usage && <DeployMeter usage={usage} />}
      {!enabled ? (
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

/** This month's use of the Deployments plan against what it includes. */
function DeployMeter({ usage }: { usage: DeployUsage }) {
  const a = DEPLOYMENTS_ALLOWANCE;
  const rows: [string, number, number, (n: number) => string][] = [
    ["Apps up at once (most this month)", usage.peakApps, a.apps, (n) => String(n)],
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
        Builds: {Math.ceil(usage.buildSeconds / 60)} min, {dollars(usage.buildMicros, 4)} at cost.
        {usage.countedAt ? " Requests and CPU time are counted every few minutes." : " Requests are counted once apps get visits."}
      </p>
    </div>
  );
}

const TRUST: Record<Limit["trust"], { label: string; detail: string }> = {
  new: {
    label: "New",
    detail: "No payment to g1t yet, so the limit is small: the free allowances and a little more. It grows once the workspace pays.",
  },
  paid: { label: "Paid", detail: "Twice what the workspace has paid g1t, from $25 up to $1,000." },
  reviewed: { label: "Reviewed", detail: "Set by g1t for this workspace." },
  internal: { label: "Comped", detail: "g1t covers this workspace's usage: nothing is charged, and there is no limit." },
};

/**
 * How far this month's unpaid usage has gone, and where work stops: g1t's
 * ceiling for the workspace, or the owners' own spend limit if lower.
 */
function LimitCard({ limit, owner, busy, error }: { limit: Limit; owner: boolean; busy: boolean; error?: string }) {
  const ceiling = limit.ceilingMicros;
  const share = ceiling ? Math.min(1, limit.exposureMicros / Math.max(ceiling, 1)) : 0;
  const tone =
    limit.state === "stopped" ? "border-danger/40 bg-danger/5" : limit.state === "warning" ? "border-warn/40 bg-warn/5" : "border-line bg-surface";
  const bar = limit.state === "stopped" ? "bg-danger" : limit.state === "warning" ? "bg-warn" : "bg-accent";
  const trust = TRUST[limit.trust];
  return (
    <section className={`mb-10 rounded-xl border p-5 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Usage limit</h2>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{trust.label}</span>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        What this month's usage cost g1t, or is charged, whichever is more, less what was paid this month. With a card on
        file, g1t charges it as the workspace nears the limit, so its work does not stop. Without one, at the limit new
        sandboxes and builds stop and apps pause until it pays or the month turns. Work already running finishes.
      </p>
      <p className="mt-4 text-2xl font-semibold tabular-nums tracking-tight">
        {dollars(limit.exposureMicros)}
        <span className="text-base font-normal text-muted"> {ceiling == null ? "· no limit" : `of ${dollars(ceiling)}`}</span>
      </p>
      {ceiling != null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
          <div className={`h-full ${bar}`} style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
        </div>
      )}
      {limit.account.startsWith("ent_") && (
        <p className="mt-3 text-sm text-muted">
          Paid for by the <span className="font-medium text-fg">{limit.accountName}</span> enterprise: these figures are
          for all of its workspaces together.
        </p>
      )}
      {limit.message && <p className="mt-3 text-sm">{limit.message}</p>}
      <p className="mt-3 text-xs text-faint">
        {trust.detail}
        {limit.trustCeilingMicros != null && limit.spendLimitMicros != null && ` g1t's limit is ${dollars(limit.trustCeilingMicros)}.`}
      </p>
      {owner && limit.trust !== "internal" && (
        <Form method="post" className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-muted">Your own monthly spend limit</span>
            <span className="mt-1 flex items-center rounded-md border border-line bg-bg px-2 focus-within:border-accent">
              <span className="text-muted">$</span>
              <input
                name="limit"
                type="number"
                min={0}
                step={1}
                defaultValue={limit.spendLimitMicros != null ? limit.spendLimitMicros / MICROS_PER_DOLLAR : ""}
                placeholder="None"
                className="w-24 bg-transparent px-1 py-1.5 tabular-nums outline-none"
              />
            </span>
          </label>
          <Button variant="quiet" type="submit" name="intent" value="spend-limit" disabled={busy}>
            Set
          </Button>
          {limit.spendLimitMicros != null && (
            <Button variant="quiet" type="submit" name="intent" value="no-spend-limit" disabled={busy}>
              Remove
            </Button>
          )}
          <ErrorText>{error}</ErrorText>
        </Form>
      )}
    </section>
  );
}
