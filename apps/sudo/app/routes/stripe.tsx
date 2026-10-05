import { Webhook } from "lucide-react";
import { Link } from "react-router";

import type { StripeStatus } from "@g1t/contracts";

import type { Route } from "./+types/stripe";
import { Badge, Button, EmptyState, Notice, Section, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { admin } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Stripe · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  return { status: await admin.stripe() };
}

type ActionData = { review: true } | { status: StripeStatus; registered: true };

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  if (text(form, "intent") !== "webhook") return { review: true } satisfies ActionData;
  if (text(form, "confirm") !== "yes") return { review: true } satisfies ActionData;
  return { status: await admin.stripe(true, staff.email), registered: true } satisfies ActionData;
}

const MODE: Record<string, { label: string; tone: "warn" | "mint" | "danger" }> = {
  test: { label: "Test mode", tone: "warn" },
  live: { label: "Live", tone: "mint" },
  off: { label: "Off", tone: "danger" },
};

export default function Stripe({ loaderData, actionData }: Route.ComponentProps) {
  const result = actionData as ActionData | undefined;
  const status = result && "status" in result ? result.status : loaderData.status;
  const reviewing = result != null && "review" in result;
  const registered = result != null && "registered" in result;
  const mode = MODE[status.mode] ?? { label: status.mode, tone: "warn" as const };
  const { webhook } = status;
  const verb = webhook ? "Replace" : "Register";

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stripe</h1>
          <p className="mt-1 text-sm text-muted">How billing talks to Stripe: its keys' mode, the webhook Stripe calls, and what it sent lately.</p>
        </div>
        <Badge tone={mode.tone}>{mode.label}</Badge>
      </div>

      <div className="mt-6 space-y-3">
        {status.error && <Notice tone="error">{status.error}</Notice>}
        {registered && !status.error && <Notice tone="ok">Webhook registered. Stripe sends its events to it from now on.</Notice>}
        {status.mode === "off" && <Notice tone="warn">Billing has no Stripe key, so nothing reaches Stripe and no webhook can be registered.</Notice>}
        {reviewing && (
          <section id="review" className={`scroll-mt-20 rounded-lg border p-4 sm:p-5 ${webhook ? "border-warn/40 bg-warn/5" : "border-merged/40 bg-merged/5"}`}>
            <h2 className="font-semibold tracking-tight">{verb} the {mode.label.toLowerCase()} webhook?</h2>
            <p className="mt-2 text-sm text-muted">
              Billing {webhook ? "deletes the endpoint it made before, then asks" : "asks"} Stripe for a new webhook endpoint, and keeps
              its signing secret itself; nobody sees it.
            </p>
            <form method="post" action="/stripe#top" className="mt-4 flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="webhook" />
              <input type="hidden" name="confirm" value="yes" />
              <Button type="submit" variant={webhook ? "danger" : "lavender"}>
                {verb} webhook
              </Button>
              <Link to="/stripe" className="px-2 text-sm text-muted hover:text-fg">
                Cancel
              </Link>
            </form>
          </section>
        )}
      </div>

      <Section
        title="Webhook"
        description="Replacing it makes a new signing secret, kept only in billing. Do it once per mode, and again after switching to live keys."
        className="mt-6"
        actions={
          status.mode !== "off" && !reviewing ? (
            <form method="post" action="/stripe#review">
              <input type="hidden" name="intent" value="webhook" />
              <Button type="submit" variant="quiet">
                <Webhook size={14} />
                {verb} webhook
              </Button>
            </form>
          ) : null
        }
      >
        {webhook ? (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="text-muted">URL</dt>
            <dd className="font-mono text-xs break-all">{webhook.url}</dd>
            <dt className="text-muted">Endpoint id</dt>
            <dd className="font-mono text-xs break-all text-fg-soft">{webhook.endpointId}</dd>
            <dt className="text-muted">Events</dt>
            <dd className="flex flex-wrap gap-1.5">
              {webhook.events.map((event) => (
                <span key={event} className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-xs">
                  {event}
                </span>
              ))}
            </dd>
            <dt className="text-muted">Registered</dt>
            <dd className="text-fg-soft">
              <When at={webhook.createdAt} time /> by <span className="font-mono">{webhook.createdBy}</span>
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted">Not registered. Until it is, billing does not hear about payments, disputes or invoices from Stripe.</p>
        )}
      </Section>

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
