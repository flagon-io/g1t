import { CreditCard } from "lucide-react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import { MICROS_PER_DOLLAR } from "@g1t/contracts";

import type { Route } from "./+types/billing";
import { Button, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { billing } from "../../lib/services.server";
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
    await billing.confirm(slug, viewer, session);
    throw redirect(`/${slug}/-/billing?added=1`);
  }
  const [account, ledger] = await Promise.all([
    billing.account(slug, viewer),
    billing.ledger(slug, viewer),
  ]);
  return {
    slug,
    role,
    account: unwrap(account),
    ledger: unwrap(ledger),
    added: url.searchParams.has("added"),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
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
  const { slug, role, account, ledger, added } = loaderData;
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
        <h2 className="font-medium">Agent credit</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          g1t agents that work on this workspace's repositories are paid for from
          its credit: what the model cost, plus {account.marginPercent}%. Checks run
          free. With no credit, agents do not start.
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
          {status.free ? (
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
              <p className="text-sm text-muted">Add credit by card:</p>
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
              <div className="mt-2">
                <ErrorText>{actionData?.error}</ErrorText>
              </div>
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
              {dollars(account.orchestrationFeeMicros)}.
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
