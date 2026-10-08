import { ArrowRight, ChevronDown, CreditCard } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { ButtonLink } from "./ui";
import { type UsageGlance, dollars, share, usageTask } from "../lib/billing";

/** Line items shown before Show more. */
const FIRST_LINES = 3;

/** What the card says the workspace is on, beside its spend. */
const STANDING: Record<UsageGlance["kind"], string> = {
  beta: "Free for now",
  comped: "100% discount",
  plan: "g1t plan",
  trial: "Trial",
  forge: "Free",
};

/**
 * A thin meter of `used` against `of`. The trial warns near its end; the
 * plan's included usage running out is ordinary, as on-demand takes over.
 */
function Bar({ used, of, warns }: { used: number; of: number; warns: boolean }) {
  const part = share(used, of);
  const tone = !warns ? "bg-accent" : part >= 1 ? "bg-danger" : part >= 0.75 ? "bg-warn" : "bg-accent";
  return (
    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-line" role="presentation">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(part * 100, part > 0 ? 2 : 0)}%` }} />
    </span>
  );
}

/**
 * The workspace's month on its overview: what it has spent, what pays
 * first and how much of it is left, what was charged past that, and what
 * it went on, with the way to Billing.
 */
export function UsageCard({ slug, glance, owner }: { slug: string; glance: UsageGlance; owner: boolean }) {
  const [all, setAll] = useState(false);
  const lines = all ? glance.lines : glance.lines.slice(0, FIRST_LINES);
  const more = glance.lines.length - FIRST_LINES;
  return (
    <section aria-labelledby="usage-card" className="rounded-xl border border-line bg-surface">
      <div className="p-5 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="usage-card" className="font-medium">
            <Link to={`/${slug}/-/usage`} className="hover:underline">
              Usage
            </Link>
          </h2>
          <span className="text-xs text-faint">This month</span>
        </div>
        <p className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{dollars(glance.spentMicros)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              glance.kind === "forge" ? "border border-line text-muted" : "bg-accent/15 text-accent"
            }`}
          >
            {STANDING[glance.kind]}
          </span>
        </p>
        <p className="mt-1 text-xs text-faint">
          {glance.kind === "beta"
            ? "At cost. Nothing is charged while g1t is being built out."
            : glance.kind === "comped"
              ? "At price, with a 100% discount: nothing is charged to this workspace."
              : glance.kind === "forge"
                ? "The forge is free. Agents, workflows and deployments need the plan or the trial."
                : "Charged so far, from the 1st."}
        </p>

        {glance.credit && (
          <div className="mt-4 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted">{glance.credit.label}</span>
              <span className="tabular-nums">
                {dollars(glance.credit.usedMicros)}
                <span className="text-faint"> / {dollars(glance.credit.ofMicros)}</span>
              </span>
            </div>
            <Bar used={glance.credit.usedMicros} of={glance.credit.ofMicros} warns={glance.kind === "trial"} />
          </div>
        )}
        {glance.onDemand && (
          <div className="mt-3 flex justify-between gap-3 text-sm">
            <span className="text-muted">On-demand charges</span>
            <span className="tabular-nums">
              {dollars(glance.onDemand.micros)}
              {glance.onDemand.limitMicros != null && (
                <span className="text-faint"> / {dollars(glance.onDemand.limitMicros, 0)}</span>
              )}
            </span>
          </div>
        )}
      </div>

      {glance.lines.length > 0 && (
        <div className="border-t border-line px-5 py-3">
          <ul className="space-y-2 text-sm">
            {lines.map((line) => (
              <li key={line.key} className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-sm" style={{ background: usageTask(line.key).color }} />
                <span className="min-w-0 grow truncate text-muted">{line.label}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums">{dollars(line.micros)}</span>
              </li>
            ))}
          </ul>
          {more > 0 && (
            <button
              type="button"
              onClick={() => setAll((open) => !open)}
              aria-expanded={all}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
            >
              <ChevronDown size={13} className={`transition-transform ${all ? "rotate-180" : ""}`} />
              {all ? "Show less" : `Show ${more} more`}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
        <Link to={`/${slug}/-/usage`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          Usage, run by run <ArrowRight size={12} />
        </Link>
        {glance.kind === "forge" || glance.kind === "trial" ? (
          owner ? (
            <ButtonLink to={`/${slug}/-/billing#plan`} variant="accent">
              Start the plan
            </ButtonLink>
          ) : (
            <ButtonLink to={`/${slug}/-/billing`} variant="quiet">
              <CreditCard size={14} />
              Billing
            </ButtonLink>
          )
        ) : (
          <ButtonLink to={`/${slug}/-/billing`} variant="quiet">
            <CreditCard size={14} />
            Billing
          </ButtonLink>
        )}
      </div>
    </section>
  );
}
