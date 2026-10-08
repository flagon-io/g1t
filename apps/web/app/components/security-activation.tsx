/**
 * The Security and quality activation on the Billing page: what it turns
 * on, its price (the price book's, through billing), and starting or
 * ending it. Owners only; comped and enterprise workspaces have it
 * included.
 */
import { CreditCard, ShieldCheck } from "lucide-react";
import { Form } from "react-router";

import type { FeatureState } from "@g1t/contracts";

import { SubmitButton } from "./ui";

export function SecurityActivationCard({
  state,
  owner,
  enabled,
  error,
}: {
  state: FeatureState | null;
  owner: boolean;
  enabled: boolean;
  error?: string;
}) {
  if (!state) return null;
  const { plan, subscription, included } = state;
  const status = subscription?.status;
  const on = state.on;
  const label = included ? "Included" : status === "canceling" ? "Ends at the period's end" : status === "past_due" ? "Payment due" : on ? "On" : "Off";
  return (
    <section id="security" className="mb-6 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <ShieldCheck size={16} className="text-accent" />
            {plan.title}
            <span className={`rounded-full px-2 py-0.5 text-xs ${on ? "bg-accent/15 text-accent" : "border border-line text-muted"}`}>{label}</span>
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            The security suite's paid features for the workspace's private repositories. Public repositories have them free, and
            secret scanning, push protection, vulnerability alerts and security updates stay free everywhere.
          </p>
        </div>
        <p className="shrink-0 sm:text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">${(plan.monthlyCents / 100).toFixed(plan.monthlyCents % 100 ? 2 : 0)}</span>
          <span className="text-sm text-muted"> / month</span>
          <span className="block text-xs text-faint">per workspace, never per seat</span>
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
      {included ? (
        <p className="mt-4 text-sm text-muted">Included for this workspace at no charge.</p>
      ) : !enabled ? (
        <p className="mt-4 text-sm text-muted">Payments are not set up on this g1t, so it is on for every workspace.</p>
      ) : !owner ? (
        <p className="mt-4 text-sm text-muted">An owner turns it on or off.</p>
      ) : (
        <Form method="post" className="mt-5 flex flex-wrap items-center gap-3">
          <input type="hidden" name="feature" value="security" />
          {!on ? (
            <SubmitButton variant="accent" name="intent" value="subscribe" pending="Opening Stripe…">
              <CreditCard size={14} />
              Turn on Security and quality
            </SubmitButton>
          ) : status === "canceling" ? (
            <SubmitButton variant="accent" name="intent" value="resume" pending="Saving…">
              Keep it on
            </SubmitButton>
          ) : (
            <SubmitButton variant="quiet" name="intent" value="cancel" pending="Saving…">
              Turn off at the period's end
            </SubmitButton>
          )}
        </Form>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
