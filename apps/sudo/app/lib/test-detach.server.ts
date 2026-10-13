/**
 * The staff actions that move workspaces off Stripe's test mode before the
 * live key: one workspace from its page, every workspace from the Stripe
 * page. Each is previewed first (a dry run) and then confirmed by typing;
 * billing refuses both on a live key, and checks the confirmation again.
 */
import type { TestStripeDetach } from "@g1t/contracts";
import { data, redirect } from "react-router";

import { text } from "./forms";
import { admin } from "./services.server";
import { settle } from "./settle";
import type { Staff } from "./staff";
import { CONFIRM_ALL, DEFAULT_EXCLUDED, parseExclude } from "./test-detach";

/** What the workspace page's action returns for a detach. */
export type WorkspaceDetachData = { testDetach: TestStripeDetach; workspace: string };

/** What the Stripe page's action returns for a detach of every workspace. */
export type EveryDetachData = { everyDetach?: TestStripeDetach; everyDetachError?: string; exclude: string };

export const WORKSPACE_DETACH_INTENT = "test-detach";
export const EVERY_DETACH_INTENTS = new Set(["test-detach-preview", "test-detach-all"]);

async function detach(args: Parameters<typeof admin.detachTestStripe>[0]): Promise<{ ok: true; value: TestStripeDetach } | { ok: false; error: string }> {
  const result = await settle(admin.detachTestStripe(args));
  if (!result.ok) return { ok: false, error: `Billing did not answer: ${result.error}` };
  if (!result.value.ok) return { ok: false, error: result.value.error.message };
  return { ok: true, value: result.value.value };
}

/** One workspace: a preview, then, confirmed with its slug, the detach. */
export async function workspaceDetachAction(form: FormData, staff: Staff, slug: string, path: string) {
  const confirmed = text(form, "confirm") === "yes";
  const values = { confirmation: "", cancelAtStripe: text(form, "cancelAtStripe") };
  const failed = (error: string) => data({ error, section: "test-detach", values }, { status: 422 });
  if (!confirmed) {
    const preview = await detach({ workspace: slug, dryRun: true, by: staff.email });
    if (!preview.ok) return failed(preview.error);
    return { testDetach: preview.value, workspace: slug } satisfies WorkspaceDetachData;
  }
  const confirmation = text(form, "confirmation").trim();
  if (confirmation !== slug) return failed(`Type the workspace's slug, ${slug}, exactly, to detach it.`);
  const done = await detach({
    workspace: slug,
    dryRun: false,
    confirm: confirmation,
    cancelAtStripe: values.cancelAtStripe === "on",
    by: staff.email,
  });
  if (!done.ok) return failed(done.error);
  return redirect(`${path}?done=${done.value.workspaces.length > 0 ? "test-detach" : "test-detach-none"}#top`);
}

/** Every workspace: a preview with the exclusions, then, with "detach" typed, the detach. */
export async function everyDetachAction(form: FormData, staff: Staff) {
  const intent = text(form, "intent");
  const exclude = text(form, "exclude");
  const slugs = parseExclude(exclude);
  if (intent === "test-detach-preview") {
    const preview = await detach({ exclude: slugs, dryRun: true, by: staff.email });
    if (!preview.ok) return { everyDetachError: preview.error, exclude } satisfies EveryDetachData;
    return { everyDetach: preview.value, exclude } satisfies EveryDetachData;
  }
  const confirmation = text(form, "confirmation").trim();
  if (confirmation !== CONFIRM_ALL) {
    // Show the preview again beside the error, so nothing has to be redone.
    const preview = await detach({ exclude: slugs, dryRun: true, by: staff.email });
    const error = `Type ${CONFIRM_ALL} to detach every workspace listed.`;
    return { everyDetach: preview.ok ? preview.value : undefined, everyDetachError: error, exclude } satisfies EveryDetachData;
  }
  const done = await detach({
    exclude: slugs,
    dryRun: false,
    confirm: confirmation,
    cancelAtStripe: text(form, "cancelAtStripe") === "on",
    by: staff.email,
  });
  if (!done.ok) return { everyDetachError: done.error, exclude } satisfies EveryDetachData;
  return { everyDetach: done.value, exclude } satisfies EveryDetachData;
}

export const DEFAULT_EXCLUDE_FIELD = DEFAULT_EXCLUDED.join(", ");
