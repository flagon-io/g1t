import { ArrowUpRight, CreditCard, FileText } from "lucide-react";
import { Suspense } from "react";
import { Await, Link, data, redirect } from "react-router";

import { MICROS_PER_DOLLAR, type WorkspaceInvoice } from "@g1t/contracts";

import type { Route } from "./+types/billing";
import {
  Alerts,
  CapsCard,
  CreditsCard,
  OverageCard,
  PrepayCard,
  RaiseCard,
  type SectionError,
  SpendLimitCard,
  SpikeBanner,
  TrialCard,
} from "../../components/billing";
import {
  AddOns,
  AiCreditCard,
  BudgetAlerts,
  InvoiceDetailsCard,
  InvoicesCard,
  PaymentMethodCard,
  PlanSummary,
  StripeSkeleton,
} from "../../components/billing-settings";
import { StatementView } from "../../components/statement";
import {
  cardCheckResult,
  dollars,
  parseAiPurchase,
  parseAiReload,
  parseBudgetAlerts,
  parseCaps,
  parseInvoiceDetails,
  parseLimitRequest,
  parsePrepay,
  parseSpendLimit,
  planStatus,
  wholeDollars,
} from "../../lib/billing";
import { isStaff } from "../../lib/usage";
import { page } from "../../lib/meta";
import { billing } from "../../lib/services.server";
import { assertSameOrigin, getViewer, managesBilling, requireUser, roleIn, unwrap } from "../../lib/session.server";

/** The trial and pools as published, when the price book cannot be read. */
const DEFAULT_TRIAL_MICROS = 5_000_000;

/** What a change says once it is done (`?done=`). */
const DONE: Record<string, string> = {
  subscribed: "The g1t plan is on, with $5 of AI credit to start.",
  prepaid: "Payment received. Your prepaid balance and what you can use went up by as much.",
  ai_credit: "AI credit bought. It is ready for Agent and AI Gateway usage.",
  ai_reload: "Auto-reload saved.",
  budget: "Budget alerts saved.",
  details: "Invoice details saved on Stripe.",
  limit: "Spend limit saved.",
  caps: "Caps saved. They apply to runs that start from now on.",
  requested: "Sent. g1t answers within one business day, here and by email.",
  told: "Thanks. g1t looks at it and answers within one business day, here and by email.",
  keep: "Compute is running again for 24 hours, unless spending doubles again first.",
  stop: "New compute stays paused until an owner chooses Keep going.",
  canceled: "The plan ends at the end of the period. Nothing more is charged for it.",
  resumed: "The plan continues.",
  security_on: "Security and quality is on for every private repository in the workspace.",
  security_canceled: "Security and quality ends at the end of the period. Nothing more is charged for it.",
  security_resumed: "Security and quality continues.",
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
  const aiCredit = url.searchParams.get("ai_credit");
  if (aiCredit) {
    const bought = await billing.confirmAiCredit(slug, viewer, aiCredit);
    throw redirect(bought.ok ? `${here}?done=ai_credit#ai-credit` : `${here}?problem=${encodeURIComponent(bought.error.message)}#ai-credit`);
  }
  const session = url.searchParams.get("session");
  if (session) {
    if (url.searchParams.get("plan")) {
      const started = await billing.confirmSubscription(slug, viewer, session);
      const doneKey = url.searchParams.get("plan") === "security" ? "security_on" : "subscribed";
      throw redirect(started.ok ? `${here}?done=${doneKey}` : `${here}?problem=${encodeURIComponent(started.error.message)}`);
    }
    const paid = await billing.confirm(slug, viewer, session);
    throw redirect(paid.ok ? `${here}?done=prepaid#prepay` : `${here}?problem=${encodeURIComponent(paid.error.message)}#prepay`);
  }
  // A plan started on the card already saved comes straight back.
  const plans = url.searchParams.getAll("plan");
  if (plans.includes("started")) throw redirect(`${here}?done=${plans.includes("security") ? "security_on" : "subscribed"}`);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const group: "day" | "project" = url.searchParams.get("group") === "project" ? "project" : "day";
  // Stripe's own (payment method, invoice details, invoices) is streamed:
  // the page does not wait on Stripe, and its sections hold their place.
  const details = billing
    .billingDetails(slug, viewer)
    .then((result) => (result.ok ? result.value : null))
    .catch(() => null);
  const [account, statement, features, limit, invoices, entitlements, requests, book, credits, ai, report] = await Promise.all([
    billing.account(slug, viewer),
    billing.statement(slug, viewer, url.searchParams.get("month"), group),
    billing.features(slug, viewer),
    billing.limit(slug, viewer).catch(() => null),
    billing.invoices(slug, viewer).catch(() => null),
    billing.entitlements(slug).catch(() => null),
    billing.limitRequests(slug, viewer).catch(() => null),
    billing.prices().catch(() => null),
    billing.credits(slug, viewer).catch(() => null),
    billing.aiCredit(slug, viewer).catch(() => null),
    billing.usageReport(slug, viewer, { from: monthStart, until: today }).catch(() => null),
  ]);
  const featureStates = unwrap(features);
  const trialMicros = book?.free?.trialWorkspaceMicros ?? DEFAULT_TRIAL_MICROS;
  const done = url.searchParams.get("done");
  // Credit from g1t for everything; AI credit has its own card.
  const general = credits?.ok ? credits.value.grants.filter((grant) => grant.scope !== "models") : [];
  return {
    slug,
    role,
    // Billing managers manage billing as owners do.
    managesBilling: managesBilling(viewer, params.owner),
    staff: isStaff(viewer),
    account: unwrap(account),
    statement: unwrap(statement),
    group,
    plan: featureStates.find((state) => state.plan.feature === "plan") ?? null,
    securityPlan: featureStates.find((state) => state.plan.feature === "security") ?? null,
    limit: limit?.ok ? limit.value : null,
    invoices: invoices?.ok ? invoices.value : [],
    entitlements,
    requests: requests?.ok ? requests.value : [],
    credits: general.length > 0 && credits?.ok ? { ...credits.value, grants: general } : null,
    ai: ai?.ok ? ai.value : null,
    report: report?.ok ? report.value : null,
    details,
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
      // Cards, payment methods and receipts live on Stripe's own page.
      const started = await billing.billingPortal(user, slug, here);
      if (!started.ok) return fail("payment", started.error.message);
      throw redirect(started.value.url);
    }
    case "subscribe": {
      // The plan. Security and quality comes with it: billing refuses it on its own.
      const feature = form.get("feature") === "security" ? "security" : "plan";
      const started = await billing.subscribe(user, slug, feature, `${here}?plan=${feature}`);
      if (!started.ok) return fail(feature, started.error.message);
      throw redirect(started.value.url);
    }
    case "cancel":
    case "resume": {
      const feature = form.get("feature") === "security" ? "security" : "plan";
      const changed = await billing.cancelSubscription(user, slug, feature, intent === "resume");
      if (!changed.ok) return fail(feature, changed.error.message);
      const prefix = feature === "security" ? "security_" : "";
      throw done(`${prefix}${intent === "resume" ? "resumed" : "canceled"}`);
    }
    case "card-check": {
      const started = await billing.cardCheck(user, slug, here);
      if (!started.ok) return fail("trial", started.error.message);
      throw redirect(started.value.url);
    }
    case "buy-ai-credit": {
      const parsed = parseAiPurchase({ amount: form.get("amount"), custom: form.get("custom") });
      if (!parsed.ok) return fail("ai", parsed.error);
      const started = await billing.buyAiCredit(user, slug, parsed.value.amountCents, here);
      if (!started.ok) return fail("ai", started.error.message);
      throw redirect(started.value.url);
    }
    case "ai-reload": {
      const parsed = parseAiReload({ enabled: form.get("enabled"), threshold: form.get("threshold"), target: form.get("target"), monthly: form.get("monthly") });
      if (!parsed.ok) return fail("ai", parsed.error);
      const set = await billing.setAiReload(user, slug, parsed.value);
      if (!set.ok) return fail("ai", set.error.message);
      throw done("ai_reload", "#ai-credit");
    }
    case "budget": {
      const parsed = parseBudgetAlerts({ alerts: form.getAll("alert"), pause: form.get("pause"), webhook: form.get("webhook") });
      if (!parsed.ok) return fail("budget", parsed.error);
      const set = await billing.setBudget(user, slug, { amountMicros: null, keepLimit: true, ...parsed.value });
      if (!set.ok) return fail("budget", set.error.message);
      throw done("budget", "#budget");
    }
    case "details": {
      const parsed = parseInvoiceDetails(form);
      if (!parsed.ok) return fail("details", parsed.error);
      const saved = await billing.setBillingDetails(user, slug, parsed.value);
      if (!saved.ok) return fail("details", saved.error.message);
      throw done("details", "#details");
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
  const { slug, role, staff, account, statement, group, plan, securityPlan, limit, invoices, entitlements, requests, credits, ai, report, details, trialMicros, notice, problem } =
    loaderData;
  const { status } = account;
  const owner = role === "owner" || loaderData.managesBilling;
  const error = actionData as SectionError;
  const err = (section: string) => (error && error.section === section ? error.error : undefined);
  const standing = planStatus(plan, entitlements);
  const paying = standing.kind === "paid" || standing.kind === "canceling" || standing.kind === "past_due";
  const free = standing.kind === "free" || standing.kind === "trial";
  const prepaid = limit?.prepaidMicros ?? entitlements?.prepaidMicros ?? 0;
  // The spend limit and its budget are the owners' to set only where
  // billing lets them: on the plan, never a free workspace's ceiling.
  const selfServe = !!limit && (limit.trust === "paid" || limit.trust === "established");
  const summary = (loaded: Awaited<typeof details>) => (
    <PlanSummary slug={slug} state={plan} status={standing} details={loaded} report={report} owner={owner} enabled={status.enabled} staff={staff} error={err("plan")} />
  );

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

        <Suspense fallback={null}>
          <Await resolve={details}>
            {(loaded) =>
              loaded?.taxAddressNeededAt ? (
                <div role="alert" className="mb-6 rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm">
                  <p className="font-medium">Add a billing address</p>
                  <p className="mt-1 text-muted">
                    Stripe needs it to work out tax, so g1t did not charge the card. Nothing is lost: the charge goes through once the
                    address is saved.{" "}
                    {owner ? (
                      <a href="#details" className="text-fg underline underline-offset-2">
                        Add it under Invoice details
                      </a>
                    ) : (
                      "An owner adds it under Invoice details."
                    )}
                  </p>
                </div>
              ) : null
            }
          </Await>
        </Suspense>
        {entitlements && <SpikeBanner slug={slug} entitlements={entitlements} owner={owner} />}
        {err("spike") && <p className="mb-6 text-sm text-danger">{err("spike")}</p>}
        <Alerts alerts={entitlements?.alerts ?? []} />

        <Suspense fallback={summary(null)}>
          <Await resolve={details}>{(loaded) => summary(loaded)}</Await>
        </Suspense>

        {ai && status.enabled && <AiCreditCard credit={ai} owner={owner} enabled={status.enabled} staff={staff} error={err("ai")} />}

        {free && status.enabled && (
          <TrialCard entitlements={entitlements} trialMicros={trialMicros} owner={owner} enabled={status.enabled} error={err("trial")} />
        )}

        {paying && limit && selfServe && (
          <>
            <SpendLimitCard limit={limit} owner={owner} error={err("limit")} />
            <BudgetAlerts limit={limit} owner={owner} error={err("budget")} />
            <RaiseCard requests={requests} owner={owner} error={err("raise")} />
            <PrepayCard prepaidMicros={prepaid} owner={owner} live={status.live || !staff} cardFee={ai?.cardFee ?? null} error={err("prepay")} />
          </>
        )}

        {credits && <CreditsCard credits={credits} />}

        {entitlements && (paying || standing.kind === "trial" || standing.kind === "comped" || standing.kind === "enterprise") && (
          <CapsCard entitlements={entitlements} owner={owner} error={err("caps")} />
        )}

        {paying && <OverageCard requests={requests} owner={owner} error={err("overage")} />}

        <AddOns plan={plan} security={securityPlan} owner={owner} enabled={status.enabled} error={err("security")} />

        {status.enabled && (
          <Suspense fallback={<StripeSkeleton />}>
            <Await resolve={details}>
              {(loaded) => (
                <>
                  <PaymentMethodCard details={loaded} owner={owner} enabled={status.enabled} staff={staff} error={err("payment")} />
                  <InvoiceDetailsCard details={loaded} owner={owner} enabled={status.enabled} error={err("details")} />
                  <InvoicesCard details={loaded} />
                </>
              )}
            </Await>
          </Suspense>
        )}

        {invoices.length > 0 && <InvoiceList invoices={invoices} />}

        <StatementView slug={slug} statement={statement} group={group} />
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">How it is charged</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>
              The plan is {wholeDollars((plan?.plan.monthlyCents ?? 2000) * 10_000)} a month for the workspace, with $10 of usage
              included. Usage is charged at what it costs g1t plus {account.marginPercent}%, from the first second, after what is
              included.
            </li>
            <li>
              Agent runs: the model at the provider's price{ai && ai.modelMarkupPercent ? ` plus ${ai.modelMarkupPercent}%` : ", with no markup"}, plus
              g1t's agent rate per million tokens{ai && ai.agentRateMicros > 0 ? ` (${dollars(ai.agentRateMicros)})` : ""}. AI Gateway: the
              provider's price, free of markup while in beta.
            </li>
            <li>AI usage draws on prepaid AI credit first; at $0, new runs on g1t's models wait for more credit or auto-reload.</li>
            <li>Credit from g1t comes off what you owe, the soonest-expiring first.</li>
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
            <li>
              Prices exclude tax. Stripe adds tax where it applies, worked out from the billing address under Invoice details, and it
              is its own line on every receipt and invoice.
            </li>
            <li>
              Card payments carry Stripe's card processing fee as their own line, shown before you pay. Bank transfers and invoiced
              billing have none.
            </li>
            <li>No seats: add as many people and agents as you like, once the workspace is on the plan.</li>
          </ul>
          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <Link to={`/${slug}/-/usage`} className="flex items-center gap-2 text-muted hover:text-fg">
              <FileText size={14} /> Usage, by product and project
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

/** The workspace's month-end invoices from g1t, each kept on Stripe with its PDF. */
function InvoiceList({ invoices }: { invoices: WorkspaceInvoice[] }) {
  return (
    <section className="mb-10">
      <h2 className="font-medium">Usage invoices</h2>
      <p className="mt-1 text-sm text-muted">
        One when each month closes, and one each time g1t charges the card near your limit. Amounts are for usage; the card fee
        and tax are their own lines.
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
                  invoice.status === "paid" ? "border-success/40 text-success" : "border-danger/40 text-danger"
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
              {(invoice.feeMicros ?? 0) > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Card processing fee</span>
                  <span className="font-mono tabular-nums">{dollars(invoice.feeMicros ?? 0)}</span>
                </li>
              )}
              {(invoice.taxMicros ?? 0) > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Tax</span>
                  <span className="font-mono tabular-nums">{dollars(invoice.taxMicros ?? 0)}</span>
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
