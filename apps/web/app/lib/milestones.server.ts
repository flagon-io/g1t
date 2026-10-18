// The forms of the workspace's milestones pages, under Work: create, edit,
// close or reopen, delete. Each needs the Write role in the workspace,
// which work checks again.

import { needs } from "@g1t/contracts";

import type { MilestoneResult } from "../components/milestones";
import { work } from "./services.server";
import { assertSameOrigin, requireUser } from "./session.server";
import { canItem } from "./work-access";

type Context = Parameters<typeof requireUser>[0];

export async function milestoneAction(request: Request, params: { owner?: string }, context: Context): Promise<MilestoneResult> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const number = Number(form.get("number")) || undefined;
  const workspace = (params.owner ?? "").toLowerCase();
  if (!canItem(user, workspace, null, "manage_labels")) return { intent, number, error: needs("manage_labels") };
  const text = (key: string) => (form.has(key) ? String(form.get(key) ?? "") : undefined);
  if (intent === "delete") {
    const deleted = await work.deleteMilestone(user, workspace, number ?? 0);
    return deleted.ok ? { intent, number } : { intent, number, error: deleted.error.message };
  }
  const state = form.get("state");
  const saved = await work.saveMilestone(user, workspace, {
    number: intent === "create" ? undefined : number,
    title: text("title"),
    description: text("description"),
    dueOn: text("dueOn"),
    state: state === "open" || state === "closed" ? state : undefined,
  });
  return saved.ok ? { intent, number: saved.value.number } : { intent, number, error: saved.error.message };
}
