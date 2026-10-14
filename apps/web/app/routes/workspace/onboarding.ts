/**
 * Getting started, for the owner signed in: what the dialog reads when it
 * is opened from a page that did not load it (Settings, the AI page), and
 * where it saves what the person chose. `intent` dismiss (closing it or
 * finishing it: it no longer opens by itself), skip or unskip (with
 * `step`). Identity keeps it (`set_onboarding`); whether a step is done is
 * never saved, only read (lib/onboarding.server.ts). Adding a provider and
 * choosing Ask's model post to the AI page's own action instead.
 */
import { data } from "react-router";

import { ONBOARDING_STEPS, type OnboardingStep } from "@g1t/contracts";

import type { Route } from "./+types/onboarding";
import { guideIsFor, loadOnboarding, saveOnboarding, skipStep } from "../../lib/onboarding.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const view = await loadOnboarding(getViewer(context), params.owner.toLowerCase());
  if (!view) throw data(null, { status: 404 });
  return { onboarding: view };
}

function isStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!guideIsFor(user, slug)) return data({ error: "Getting started is for the workspace's owners." }, { status: 403 });
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "dismiss") return saveOnboarding(user, slug, { dismissed: true });
  if (intent === "skip" || intent === "unskip") {
    const step = form.get("step");
    if (!isStep(step)) return data({ error: "That isn't a step of Getting started." }, { status: 400 });
    return skipStep(user, slug, step, intent === "skip");
  }
  return data({ error: "Nothing to do." }, { status: 400 });
}
