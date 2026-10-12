// The forms of the milestones pages: create, edit, close or reopen, delete.
// Each needs the Triage role, which work checks again.

import type { MilestoneResult } from "../components/milestones";
import { refusal } from "./access.server";
import { work } from "./services.server";
import { assertSameOrigin, requireUser } from "./session.server";

type Context = Parameters<typeof refusal>[0];
type RepoParams = Parameters<typeof refusal>[1];

export async function milestoneAction(request: Request, params: RepoParams, context: Context): Promise<MilestoneResult> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const number = Number(form.get("number")) || undefined;
  const refused = await refusal(context, params, "manage_labels");
  if (refused) return { intent, number, error: refused };
  const path = { namespace: params.owner ?? "", name: params.repo ?? "" };
  const text = (key: string) => (form.has(key) ? String(form.get(key) ?? "") : undefined);
  if (intent === "delete") {
    const deleted = await work.deleteMilestone(user, path, number ?? 0);
    return deleted.ok ? { intent, number } : { intent, number, error: deleted.error.message };
  }
  const state = form.get("state");
  const saved = await work.saveMilestone(user, path, {
    number: intent === "create" ? undefined : number,
    title: text("title"),
    description: text("description"),
    dueOn: text("dueOn"),
    state: state === "open" || state === "closed" ? state : undefined,
  });
  return saved.ok ? { intent, number: saved.value.number } : { intent, number, error: saved.error.message };
}
