import { ArrowUpRight, CreditCard, FileText } from "lucide-react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import { MICROS_PER_DOLLAR, type WorkspaceInvoice } from "@g1t/contracts";

import type { Route } from "./+types/billing";
import {
  Alerts,
  CapsCard,
  OverageCard,
  PlanCard,
  PrepayCard,
  RaiseCard,
  type SectionError,
  SpendLimitCard,
  SpikeBanner,
  TrialCard,
} from "../../components/billing";
import { StatementView } from "../../components/statement";
import { Button } from "../../components/ui";
import {
  cardCheckResult,
  dollars,
  parseCaps,
  parseLimitRequest,
  parsePrepay,
  parseSpendLimit,
  planStatus,
  wholeDollars,
} from "../../lib/billing";
import { page } from "../../lib/meta";
import { billing, deployments } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

/** The trial and pools as published, when the price book cannot be read. */
const DEFAULT_TRIAL_MICROS = 5_000_000;

/** What a change says once it is done (`?done=`). */
const DONE: Record<string, string> = {
  subscribed: "The g1t plan is on.",
  prepaid: "Payment received. Your prepaid balance and what you can use went up by as much.",
  limit: "Spend limit saved.",
  caps: "Caps saved. They apply to runs that start from now on.",
  requested: "Sent. g1t answers within one business day, here and by email.",
  told: "Thanks. g1t looks at it and answers within one business day, here and by email.",
  keep: "Compute is running again for 24 hours, unless spending doubles again first.",
  stop: "New compute stays paused until an owner chooses Keep going.",
  canceled: "The plan ends at the end of the period. Nothing more is charged for it.",
  resumed: "The plan continues.",
};

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Billing · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Members only; to anyone else the page does not exist.
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const here = `/${slug}/-/billing`;

  // Back from Stripe: record what happened, then drop the ids from the address.
  const cardCheck = url.searchParams.get("card_check");
  if (cardCheck) {
    const checked = await billing.confirmCardCheck(slug, viewer, cardCheck);
    throw redirect(checked.ok ? `${here}?checked=1#trial` : `${here}?problem=${encodeURIComponent(checked.error.message)}#trial`);
  }
  const session = url.searchParams.get("session");
  if (session) {
    if (url.searchParams.get("plan")) {
      const started = await billing.confirmSubscription(slug, viewer, session);
      throw redirect(started.ok ? `${here}?done=subscribed` : `${here}?problem=${encodeURIComponent(started.error.message)}`);
    }
    const paid = await billing.confirm(slug, viewer, session);
    throw redirect(paid.ok ? `${here}?done=prepaid#prepay` : `${here}?problem=${encodeURIComponent(paid.error.message)}#prepay`);
  }
  // A plan started on the card already checked comes straight back.
  if (url.searchParams.get("plan") === "started") throw redirect(`${here}?done=subscribed`);

  const group: "day" | "project" = url.searchParams.get("group") === "project" ? "project" : "day";
  const [account, statement, features, deployUsage, limit, invoices, entitlements, requests, book] = await Promise.all([
    billing.account(slug, viewer),
    billing.statement(slug, viewer, url.searchParams.get("month"), group),
    billing.features(slug, viewer),
    deployments.usage(slug, viewer).catch(() => null),
    billing.limit(slug, viewer).catch(() => null),
    billing.invoices(slug, viewer).catch(() => null),
    billing.entitlements(slug).catch(() => null),
    billing.limitRequests(slug, viewer).catch(() => null),
    billing.prices().catch(() => null),
  ]);
  const featureStates = unwrap(features);
  const trialMicros = book?.free?.trialWorkspaceMicros ?? DEFAULT_TRIAL_MICROS;
  const done = url.searchParams.get("done");
  return {
    slug,
    role,
    account: unwrap(account),
    statement: unwrap(statement),
    group,
    plan: featureStates.find((state) => state.plan.feature === "plan") ?? null,
    deployUsage: deployUsage?.ok ? deployUsage.value : null,
    limit: limit?.ok ? limit.value : null,
    invoices: invoices?.ok ? invoices.value : [],
    entitlements,
    requests: requests?.ok ? requests.value : [],
    trialMicros,
    notice:
      url.searchParams.has("checked") && entitlements
        ? cardCheckResult(entitlements, trialMicros)
        : done && DONE[done]
          ? DONE[done]
          : null,
    problem: url.searchParams.get("problem"),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const slug = params.owner.toLowerCase();
  // Spelled out: a form post arrives at a data address, not the page's.
  const here = `${new URL(request.url).origin}/${slug}/-/billing`;
  const intent = String(form.get("intent") ?? "");
  const fail = (section: string, error: string) => data<SectionError>({ section, error }, { status: 422 });
  const done = (key: string, anchor = "") => redirect(`/${slug}/-/billing?done=${key}${anchor}`);

  switch (intent) {
    case "portal": {
      // Card, invoices and billing details live on Stripe's own page.
      const started = await billing.billingPortal(user, slug, here);
      if (!started.ok) return fail("plan", started.error.message);
      throw redirect(started.value.url);
    }
    case "subscribe": {
      const started = await billing.subscribe(user, slug, "plan", `${here}?plan=plan`);
      if (!started.ok) return fail("plan", started.error.message);
      throw redirect(started.value.url);
    }
    case "cancel":
    case "resume": {
      const changed = await billing.cancelSubscription(user, slug, "plan", intent === "resume");
      if (!changed.ok) return fail("plan", changed.error.message);
      throw done(intent === "resume" ? "resumed" : "canceled");
    }
    case "card-check": {
      const started = await billing.cardCheck(user, slug, here);
      if (!started.ok) return fail("trial", started.error.message);
      throw redirect(started.value.url);
    }
    case "spend-limit": {
      const parsed = parseSpendLimit({ mode: form.get("mode"), limit: form.get("limit") });
      if (!parsed.ok) return fail("limit", parsed.error);
      let micros = parsed.value.micros;
      if (parsed.value.raiseOnce && micros == null) {
        // The one-time raise with no amount: as high as it goes.
        const limit = await billing.limit(slug, user);
        micros = limit.ok ? (limit.value.raiseOnceMicros ?? null) : null;
        if (micros == null) return fail("limit", "The one-time raise is not available. Prepay, or use Raise my limit.");
      }
      const set = await billing.setSpendLimit(user, slug, micros, parsed.value.useFull, parsed.value.raiseOnce);
      if (!set.ok) return fail("limit", set.error.message);
      throw done("limit", "#limit");
    }
    case "request": {
      const parsed = parseLimitRequest({
        kind: form.get("kind"),
        amount: form.get("amount"),
        reason: form.get("reason"),
        expected: form.get("expected"),
      });
      const section = String(form.get("kind")) === "overage" ? "overage" : "raise";
      if (!parsed.ok) return fail(section, parsed.error);
      const sent = await billing.requestLimit(user, slug, parsed.value);
      if (!sent.ok) return fail(section, sent.error.message);
      throw done(section === "overage" ? "told" : "requested", `#${section}`);
    }
    case "caps": {
      const parsed = parseCaps({ run: form.get("run"), issue: form.get("issue") });
      if (!parsed.ok) return fail("caps", parsed.error);
      const set = await billing.setCaps(user, slug, parsed.value);
      if (!set.ok) return fail("caps", set.error.message);
      throw done("caps", "#caps");
    }
    case "spike": {
      const keep = String(form.get("decision")) === "keep";
      const answered = await billing.confirmSpike(user, slug, keep);
      if (!answered.ok) return fail("spike", answered.error.message);
      throw done(keep ? "keep" : "stop");
    }
    case "prepay": {
      const parsed = parsePrepay({ amount: form.get("amount"), custom: form.get("custom"), method: form.get("method") });
      if (!parsed.ok) return fail("prepay", parsed.error);
      const started = await billing.checkout(user, slug, parsed.value.amountCents, here, parsed.value.method);
      if (!started.ok) return fail("prepay", started.error.message);
      throw redirect(started.value.url);
    }
    default:
      return fail("plan", "Unknown action.");
  }
}

export default function WorkspaceBilling({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, account, statement, group, plan, deployUsage, limit, invoices, entitlements, requests, trialMicros, notice, problem } =
    loaderData;
  const { status } = account;
  const owner = role === "owner";
  const busy = useNavigation().state === "submitting";
  const error = actionData as SectionError;
  const err = (section: string) => (error && error.section === section ? error.error : undefined);
  const standing = planStatus(plan, entitlements);
  const paying = standing.kind === "paid" || standing.kind === "canceling" || standing.kind === "past_due";
  const free = standing.kind === "free" || standing.kind === "trial";
  const prepaid = limit?.prepaidMicros ?? entitlements?.prepaidMicros ?? 0;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        {status.free && (
          <div className="mb-6 rounded-xl border border-accent/30 bg-accent/5 p-5">
            <h2 className="font-medium">Free while g1t is being built out</h2>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">
              Runs are recorded with what they cost, so Usage shows what you use, but nothing is charged for now. We will say so well
              before anything is.
            </p>
          </div>
        )}
        {notice && <p className="mb-6 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">{notice}</p>}
        {problem && <p className="mb-6 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-sm">{problem}</p>}

        {entitlements && <SpikeBanner slug={slug} entitlements={entitlements} owner={owner} />}
        {err("spike") && <p className="mb-6 text-sm text-danger">{err("spike")}</p>}
        <Alerts alerts={entitlements?.alerts ?? []} />

        <PlanCard
          state={plan}
          status={standing}
          entitlements={entitlements}
          owner={owner}
          enabled={status.enabled}
          live={status.live}
          busy={busy}
          deployUsage={deployUsage}
          error={err("plan")}
        />

        {free && status.enabled && (
          <TrialCard entitlements={entitlements} trialMicros={trialMicros} owner={owner} enabled={status.enabled} busy={busy} error={err("trial")} />
        )}

        {paying && limit && limit.trust !== "internal" && (
          <>
            <SpendLimitCard limit={limit} owner={owner} busy={busy} error={err("limit")} />
            <RaiseCard requests={requests} owner={owner} busy={busy} error={err("raise")} />
            <PrepayCard prepaidMicros={prepaid} owner={owner} live={status.live} busy={busy} error={err("prepay")} />
          </>
        )}

        {entitlements && (paying || standing.kind === "trial" || standing.kind === "comped" || standing.kind === "enterprise") && (
          <CapsCard entitlements={entitlements} owner={owner} busy={busy} error={err("caps")} />
        )}

        {paying && <OverageCard requests={requests} owner={owner} busy={busy} error={err("overage")} />}

        {status.enabled && (
          <section className="mb-10 rounded-xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-medium">Card and invoices</h2>
                {account.card ? (
                  <p className="mt-1 text-sm">
                    <span className="capitalize">{account.card.brand}</span> ending <span className="font-mono">{account.card.last4}</span>
                    <span className="text-muted"> · expires {String(account.card.expMonth).padStart(2, "0")}/{account.card.expYear}</span>
                  </p>
                ) : (
                  <p className="mt-1 max-w-xl text-sm text-muted">No card yet. The plan, the trial and prepaying each ask for one on Stripe.</p>
                )}
                <p className="mt-2 max-w-xl text-xs text-faint">
                  Cards, invoices, receipts and the billing email, address and tax ID are on Stripe's billing page. g1t never sees card
                  numbers.
                </p>
              </div>
              {owner && (
                <Form method="post">
                  <Button variant="quiet" type="submit" name="intent" value="portal" disabled={busy}>
                    <CreditCard size={14} />
                    Open Stripe billing
                  </Button>
                </Form>
              )}
            </div>
            {!status.live && (
              <p className="mt-3 text-xs text-faint">Test mode: use card 4242 4242 4242 4242, any future date and code.</p>
            )}
          </section>
        )}

        {invoices.length > 0 && <InvoiceList invoices={invoices} />}

        <StatementView slug={slug} statement={statement} group={group} />
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">How it is charged</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>
              The plan is {wholeDollars((plan?.plan.monthlyCents ?? 2000) * 10_000)} a month for the workspace. Usage is charged at what it
              costs g1t plus {account.marginPercent}%, from the first second, after what is included.
            </li>
            <li>What paid first is on each statement line: the plan's included usage, the trial, the open-source pool, or g1t.</li>
            <li>
              With your own model provider, connected under{" "}
              <Link to={`/${slug}/-/integrations`} className="text-fg hover:underline">
                Integrations
              </Link>
              , the provider bills you for the model, and a run here is charged only its sandbox time.
            </li>
            <li>
              Each month closes with an itemised invoice. No card is charged less than{" "}
              {dollars(entitlements?.minChargeMicros ?? 5 * MICROS_PER_DOLLAR, 0)}; less carries over.
            </li>
            <li>Alerts at 50, 75, 90 and 100% of the included usage and your limits, here and by email.</li>
            <li>No seats: add as many people and agents as you like.</li>
          </ul>
          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <Link to={`/${slug}/-/usage`} className="flex items-center gap-2 text-muted hover:text-fg">
              <FileText size={14} /> Usage, run by run
            </Link>
            <Link to="/pricing" className="flex items-center gap-2 text-muted hover:text-fg">
              <CreditCard size={14} /> Pricing and today's prices
            </Link>
            <a href="https://docs.g1t.sh/guides/usage-and-billing/" className="flex items-center gap-2 text-muted hover:text-fg">
              <ArrowUpRight size={14} /> How usage and billing work
            </a>
          </div>
        </section>
      </aside>
    </div>
  );
}

/** The workspace's invoices from g1t, each kept on Stripe with its PDF. */
function InvoiceList({ invoices }: { invoices: WorkspaceInvoice[] }) {
  return (
    <section className="mb-10">
      <h2 className="font-medium">Invoices</h2>
      <p className="mt-1 text-sm text-muted">
        One when each month closes, and one each time g1t charges the card near your limit. Receipts and PDFs are also on Stripe's
        billing page.
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
