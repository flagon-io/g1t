import { data } from "react-router";

import type { Result, User } from "@g1t/contracts";

import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";
import type { ActionResult } from "./dialogs";

/** What an Agents action knows first: who is asking, in which workspace, whether they own it, and the form. */
export async function agentsAction(
  request: Request,
  context: Parameters<typeof requireUser>[0],
  owner: string,
): Promise<{ viewer: User; slug: string; isOwner: boolean; form: FormData }> {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  return { viewer, slug, isOwner: role === "owner", form: await request.formData() };
}

/** An agents-service call as an action's answer: worked, or why not. */
export async function answer<T>(intent: string, call: Promise<Result<T>>): Promise<ActionResult> {
  const result = await call.catch(() => null);
  if (!result) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!result.ok) return { ok: false, intent, error: result.error.message };
  return { ok: true, intent };
}

/** A loader's agents-service read: its value, or null when it failed (the page says so). */
export async function readOrNull<T>(call: Promise<Result<T>>): Promise<T | null> {
  const result = await call.catch(() => null);
  return result?.ok ? result.value : null;
}
