import { env } from "cloudflare:workers";
import { Sparkles } from "lucide-react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Plan } from "@g1t/contracts";

import type { Route } from "./+types/plans";
import { refusal, requireRepo } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { page } from "../../lib/meta";
import { Button, ComputeNote, EmptyState, ErrorText, Textarea, TimeAgo } from "../../components/ui";
import { computeNoteFor } from "../../lib/compute.server";
import { work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Plan · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Anyone who can read the repository: a public one's to anyone, a private one's to people with a role.
  const { access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const [plans, computeNote] = await Promise.all([
    work.listPlans(path, viewer),
    // Planning is an agent run: said before it is refused for the plan.
    computeNoteFor(params.owner, "agent"),
  ]);
  return { plans: unwrap(plans), computeNote, can: access.can };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  // Planning is an agent run: Write and up.
  const refused = await refusal(context, params, "run");
  if (refused) return { error: refused };
  const started = await env.RUNNER.plan(user, path, String(form.get("brief") ?? ""));
  if (!started.ok) return { error: started.error.message };
  throw redirect(`/${params.owner}/${params.repo}/plans/${started.value.planId}`);
}

const STATUS: Record<Plan["status"], string> = {
  planning: "Being written",
  ready: "Ready to read",
  failed: "Could not be written",
  applied: "Applied",
};

export default function Plans({ loaderData, actionData, params }: Route.ComponentProps) {
  const { plans } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const starting = useNavigation().state === "submitting";
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">Plan work</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Say what you want to be true when the work is done. An agent reads this
          repository and proposes the issues that would get there, with what each
          must pass and which have to land before which. You read it, change what
          you like, and put g1t agents on it with one click.
        </p>
        <Form method="post" className="mt-5 space-y-3">
          <Textarea
            name="brief"
            rows={7}
            required
            placeholder={
              "The outcome, in your own words. For example:\n\nThe greeter should support a --lang flag for Spanish and French, a --shout flag that upper-cases the greeting, and a --version flag. Each should be documented in the README and covered by tests."
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="accent" type="submit" disabled={starting || !loaderData.can.run} title={whyNot(loaderData.can, "run")}>
              <Sparkles size={15} />
              {starting ? "Starting the planner…" : "Plan it"}
            </Button>
            <span className="text-xs text-muted">
              Nothing is opened until you have read the plan.
            </span>
          </div>
          {actionData?.error ? <ErrorText>{actionData.error}</ErrorText> : <ComputeNote note={loaderData.computeNote} />}
        </Form>

        <h3 className="mt-10 text-sm font-medium text-muted">Plans</h3>
        <div className="mt-3">
          {plans.length === 0 ? (
            <EmptyState title="No plans yet" />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {plans.map((plan) => (
                <li key={plan.id}>
                  <Link
                    to={`${base}/plans/${plan.id}`}
                    className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface"
                  >
                    <span className="min-w-0 grow">
                      <span className="block truncate font-medium">{plan.brief}</span>
                      <span className="mt-0.5 block text-xs text-faint">
                        {plan.author.username} · <TimeAgo at={plan.createdAt} />
                        {plan.issues.length > 0 &&
                          ` · ${plan.issues.length} ${plan.issues.length === 1 ? "issue" : "issues"}`}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-xs ${
                        plan.status === "failed"
                          ? "text-danger"
                          : plan.status === "ready"
                            ? "text-accent"
                            : "text-muted"
                      }`}
                    >
                      {STATUS[plan.status]}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">What a plan gives you</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>Issues small enough to be merged one at a time, written so that an agent needs nothing else.</li>
            <li>Acceptance checks on each, taken from how this repository is tested.</li>
            <li>The files each will touch, and a dependency wherever two would collide.</li>
            <li>
              Independent issues are worked on at the same time. One that depends on
              another starts when that has merged, from its result.
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
