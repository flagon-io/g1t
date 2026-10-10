import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/policies";
import { TrustPage } from "../components/trust-page";
import { CONTACT, POLICIES, POLICIES_UPDATED, POLICY_HISTORY, longDate } from "../lib/legal";
import { page } from "../lib/meta";
import { Card } from "../components/ui/card";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Policies · g1t",
    description:
      "g1t's Terms of Service, Privacy Policy, Acceptable Use Policy, refunds and subprocessors, in plain language, with every change listed.",
  });
}

export default function Policies() {
  return (
    <TrustPage
      eyebrow="Policies"
      title="The rules we both play by"
      lede={
        <p>
          What you agree to when you use g1t, and what we promise in return, written to be read. Last
          updated {longDate(POLICIES_UPDATED)}.
        </p>
      }
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {POLICIES.map((policy) => (
          <li key={policy.slug}>
            <Link
              to={`/policies/${policy.slug}`}
              className="group flex h-full flex-col rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-raised"
            >
              <span className="flex items-center justify-between gap-3 font-medium">
                {policy.title}
                <ArrowRight size={15} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
              </span>
              <span className="mt-1.5 text-sm text-muted">{policy.summary}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            to="/security"
            className="group flex h-full flex-col rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <span className="flex items-center justify-between gap-3 font-medium">
              Security and disclosure
              <ArrowRight size={15} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
            </span>
            <span className="mt-1.5 text-sm text-muted">How g1t protects code and accounts, and how to report a vulnerability.</span>
          </Link>
        </li>
      </ul>

      <section className="mt-14 max-w-3xl">
        <h2 className="text-xl font-semibold tracking-tight">Changes</h2>
        <p className="mt-2 text-sm text-muted">
          We'll tell you before material changes take effect: by email to account holders and here, at least 30 days
          ahead, unless the law or a security problem needs a change sooner. Every change is listed below.
        </p>
        <Card asChild tone="plain" divided className="mt-5">
          <ol>
            {POLICY_HISTORY.map((entry) => (
              <li key={entry.date + entry.change} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:gap-6">
                <time dateTime={entry.date} className="shrink-0 font-mono text-xs leading-6 text-faint sm:w-28">
                  {entry.date}
                </time>
                <span className="text-fg/90">{entry.change}</span>
              </li>
            ))}
          </ol>
        </Card>
        <p className="mt-6 text-sm text-muted">
          Questions about a policy: <a className="text-accent hover:underline" href={`mailto:${CONTACT.legal}`}>{CONTACT.legal}</a>.
          About your information: <a className="text-accent hover:underline" href={`mailto:${CONTACT.privacy}`}>{CONTACT.privacy}</a>.
        </p>
      </section>
    </TrustPage>
  );
}
