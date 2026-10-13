import { Webhook } from "lucide-react";
import type { ReactNode } from "react";

import type { StripeStatus } from "@g1t/contracts";

import type { Route } from "./+types/stripe";
import { EveryWorkspaceDetachSection } from "~/components/test-detach";
import { Badge, Button, EmptyState, Notice, Section, When } from "~/components/ui";
import { admin } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";
import { EVERY_DETACH_INTENTS, type EveryDetachData, everyDetachAction } from "~/lib/test-detach.server";
import { text } from "~/lib/forms";

export const meta: Route.MetaFunction = () => [{ title: "Stripe · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  return { status: await admin.stripe() };
}

type ActionData = { status: StripeStatus; fixed: true };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  // Detaching workspaces from test mode has its own forms (test-detach.tsx).
  const form = await request.formData();
  if (EVERY_DETACH_INTENTS.has(text(form, "intent"))) return everyDetachAction(form, staff);
  return { status: await admin.stripe(true, staff.email), fixed: true } satisfies ActionData;
}

const MODE: Record<string, { label: string; tone: "warn" | "mint" | "danger" }> = {
  test: { label: "Test mode", tone: "warn" },
  live: { label: "Live", tone: "mint" },
  off: { label: "Off", tone: "danger" },
};

const WEBHOOK_URL = "https://api.g1t.sh/stripe/webhook";

export default function Stripe({ loaderData, actionData }: Route.ComponentProps) {
  const detach = actionData && "exclude" in actionData ? (actionData as EveryDetachData) : null;
  const result = actionData && "fixed" in actionData ? (actionData as ActionData) : undefined;
  const status = result?.status ?? loaderData.status;
  const fixed = result != null;
  const mode = MODE[status.mode] ?? { label: status.mode, tone: "warn" as const };
  const { webhook } = status;
  const needsFix = webhook != null && (webhook.status !== "enabled" || status.missingEvents.length > 0);
  const ready = status.mode !== "off" && status.secretSet && webhook != null && !needsFix;

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stripe</h1>
          <p className="mt-1 text-sm text-muted">How billing hears from Stripe: the destination in Stripe, its signing secret here, and what it sent lately.</p>
        </div>
        <Badge tone={mode.tone}>{mode.label}</Badge>
      </div>

      <div className="mt-6 space-y-3">
        {status.error && <Notice tone="error">{status.error}</Notice>}
        {fixed && !status.error && <Notice tone="ok">Destination checked: enabled, and sending every event billing handles.</Notice>}
        {status.mode === "off" && <Notice tone="warn">Billing has no Stripe key (STRIPE_SECRET_KEY), so nothing reaches Stripe.</Notice>}
        {ready && <Notice tone="ok">Ready: Stripe sends to billing, and billing can check what it sends.</Notice>}
      </div>

      <GoLiveChecklist status={status} />

      <Section
        title="Webhook"
        description="Made in Stripe's dashboard; its signing secret is the billing Worker's secret STRIPE_WEBHOOK_SECRET. Billing keeps the destination's events and enables it again if Stripe turns it off; it never changes the secret."
        className="mt-6"
        actions={
          needsFix ? (
            <form method="post" action="/stripe#top">
              <Button type="submit" variant="lavender">
                <Webhook size={14} />
                Fix destination
              </Button>
            </form>
          ) : null
        }
      >
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted">Signing secret</dt>
          <dd>
            {status.secretSet ? (
              <Badge tone="mint">Set</Badge>
            ) : (
              <span className="text-fg-soft">
                <Badge tone="danger">Not set</Badge> Every event is refused until it is. In Stripe: the destination, Signing secret, Reveal; then, in{" "}
                <span className="font-mono text-xs">services/billing</span>,{" "}
                <span className="font-mono text-xs">npx wrangler secret put STRIPE_WEBHOOK_SECRET</span>.
              </span>
            )}
          </dd>
          <dt className="text-muted">Destination</dt>
          <dd className="min-w-0">
            {webhook ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs break-all">{webhook.url}</span>
                <Badge tone={webhook.status === "enabled" ? "mint" : "danger"}>{webhook.status}</Badge>
                <span className="font-mono text-xs text-faint">{webhook.endpointId}</span>
              </span>
            ) : status.mode === "off" ? (
              <span className="text-muted">Not checked without a key.</span>
            ) : (
              <span className="text-fg-soft">
                None in {mode.label.toLowerCase()}. In Stripe: Developers, Webhooks, Add destination, endpoint URL{" "}
                <span className="font-mono text-xs">{WEBHOOK_URL}</span>, any events (billing adds what it needs here). Then set its secret.
              </span>
            )}
          </dd>
          {webhook && (
            <>
              <dt className="text-muted">Made</dt>
              <dd className="text-fg-soft">
                <When at={webhook.createdAt} time />
              </dd>
              <dt className="text-muted">Events</dt>
              <dd className="flex flex-wrap gap-1.5">
                {webhook.events.map((event) => (
                  <span key={event} className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-xs">
                    {event}
                  </span>
                ))}
                {status.missingEvents.map((event) => (
                  <span key={event} className="rounded border border-danger/40 bg-danger/5 px-1.5 py-0.5 font-mono text-xs text-danger" title="Billing handles this; the destination does not send it">
                    {event} missing
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </Section>

      <EveryWorkspaceDetachSection
        live={status.mode === "live"}
        result={detach?.everyDetach ?? null}
        error={detach?.everyDetachError ?? null}
        exclude={detach?.exclude ?? null}
      />

      <Section title="Recent events" description="What Stripe sent, newest first, and what billing did with it." className="mt-6">
        {status.recentEvents.length === 0 ? (
          <EmptyState title="No events yet" />
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
            <table className="w-full min-w-xl text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:pl-5">When</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium sm:pr-5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {status.recentEvents.map((event) => (
                  <tr key={event.id} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pl-5">
                      <When at={event.receivedAt} time />
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="font-mono text-xs">{event.kind}</p>
                      <p className="font-mono text-xs text-faint">{event.id}</p>
                    </td>
                    <td className="px-4 py-2.5 wrap-break-word text-fg-soft sm:pr-5">{event.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  );
}

// --- Go-live checklist ----------------------------------------------------------------
//
// Read-only. Stripe Tax and the Customer Portal come from billing's Stripe
// status: `tax` is Stripe's GET /v1/tax/settings (`active`, or `pending`
// with `missingFields`), `portal` the configuration billing makes
// (metadata g1t=billing). Either is null when it could not be read; the
// row then says what to check in Stripe's dashboard.

function CheckRow({ label, ok, children }: { label: string; ok: boolean | null; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-fg-soft">
        <Badge tone={ok == null ? "warn" : ok ? "mint" : "danger"}>{ok == null ? "Check in Stripe" : ok ? "Ready" : "Not ready"}</Badge>
        <span>{children}</span>
      </dd>
    </>
  );
}

function GoLiveChecklist({ status }: { status: StripeStatus }) {
  const webhookOk = status.webhook != null && status.webhook.status === "enabled" && status.missingEvents.length === 0;
  const tax = status.tax;
  const portal = status.portal;
  return (
    <Section
      title="Go-live checklist"
      description="What has to be true before live payments: a live key, the webhook, Stripe Tax and the Customer Portal. Read-only."
      className="mt-6"
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <CheckRow label="Live key" ok={status.mode === "live"}>
          {status.mode === "live" ? "Billing uses a live key." : `Billing's key is in ${status.mode === "off" ? "no" : status.mode} mode.`}
        </CheckRow>
        <CheckRow label="Webhook" ok={status.secretSet && webhookOk}>
          {status.secretSet && webhookOk ? "Enabled, signed, and sending every event billing handles." : "See Webhook below."}
        </CheckRow>
        <CheckRow label="Stripe Tax" ok={status.mode === "off" || tax == null ? null : tax.status === "active"}>
          {tax == null
            ? "Not read. In Stripe: Tax, Settings: status Active, with the head office address and registrations."
            : tax.status === "active"
              ? "Active."
              : `${tax.status}${tax.missingFields.length ? `: missing ${tax.missingFields.join(", ")}` : ""}.`}
        </CheckRow>
        <CheckRow label="Customer Portal" ok={status.mode === "off" || portal === undefined ? null : portal != null && portal.active}>
          {portal === undefined
            ? "Not read. In Stripe: Settings, Billing, Customer portal: the configuration with metadata g1t=billing, active."
            : portal
              ? `${portal.configurationId}: ${portal.active ? "active" : "inactive; billing turns it back on the next time someone opens Manage billing"}.`
              : "No configuration yet: billing makes one the first time someone opens Manage billing."}
        </CheckRow>
      </dl>
    </Section>
  );
}
