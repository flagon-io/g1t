/**
 * Bringing a fork's branch up to date with its parent's, from the fork bar
 * on its Code page (components/fork-bar.tsx). Write access on the fork.
 */
import { data } from "react-router";

import type { SyncedFork } from "@g1t/contracts";

import type { Route } from "./+types/sync-fork";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export type SyncOutcome = { error: string | null; synced: SyncedFork | null };

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const branch = String(form.get("branch") ?? "").trim() || undefined;
  try {
    const synced = await repos.syncFork(user, { namespace: params.owner, name: params.repo }, branch);
    if (!synced.ok) {
      const status = synced.error.code === "not_found" ? 404 : synced.error.code === "forbidden" ? 403 : 409;
      return data<SyncOutcome>({ error: synced.error.message, synced: null }, { status });
    }
    return { error: null, synced: synced.value } satisfies SyncOutcome;
  } catch {
    return data<SyncOutcome>({ error: "That did not go through. Try again in a moment.", synced: null }, { status: 503 });
  }
}
