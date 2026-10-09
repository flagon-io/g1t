/**
 * Costs & margin and Bill & pricing: one report from billing, read by both
 * pages, and the changes staff make on either.
 */
import { data, redirect } from "react-router";

import { parseCostSettings, parseMapping, parsePauseLevel, parseRange } from "./costs";
import { admin } from "./services.server";
import { settle } from "./settle";
import { requireStaff } from "./staff";

export const DONE: Record<string, string> = {
  run: "Ran the analysis: read Cloudflare's bill, reconciled the last 31 days and checked the alerts. The figures below are fresh.",
  approved: "Approved. A fall applies now; a rise after the notice period, and owners on the plan are emailed.",
  rejected: "Rejected, with the note kept for whoever measures it next.",
  settings: "Guardrails saved. They apply from the next run.",
  mapping: "Mapping saved. It applies from the next run; read the bill now to see it.",
  removed: "Mapping removed.",
  lifted: "Breaker lifted for the rest of today (UTC). Hosted-model runs start again; it is recorded in the audit log.",
  paused: "Paused across g1t. Every service sees it within 30 seconds; it is recorded in the audit log.",
  resumed: "Resumed across g1t. Every service sees it within 30 seconds; it is recorded in the audit log.",
};

export type CostsActionResult = { error: string; section: string; values?: Record<string, string> };

export async function costsLoader(request: Request, context: unknown) {
  requireStaff(context as Parameters<typeof requireStaff>[0]);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("days"));
  const [report, guard] = await Promise.all([settle(admin.costs(range)), settle(admin.platformGuard())]);
  const done = url.searchParams.get("done");
  return {
    range,
    bucket: url.searchParams.get("product"),
    report: report.ok ? report.value : null,
    error: report.ok ? null : report.error,
    // The platform pause and usage watch (billing's platform.rs).
    guard: guard.ok ? guard.value : null,
    guardError: guard.ok ? null : guard.error,
    done: done ? (DONE[done] ?? null) : null,
  };
}

export async function costsAction(request: Request, context: unknown) {
  const staff = requireStaff(context as Parameters<typeof requireStaff>[0]);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (section: string, error: string) =>
    data<CostsActionResult>({ error, section, values: Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])) }, { status: 422 });
  const back = (done: string, hash = "") => {
    const url = new URL(request.url);
    url.searchParams.set("done", done);
    return redirect(`${url.pathname}${url.search}${hash}`);
  };
  if (intent === "run") {
    const run = await settle(admin.runCosts(staff.email));
    if (!run.ok) return fail("run", `Billing did not answer: ${run.error}`);
    if (!run.value.ok) return fail("run", run.value.error.message);
    if (run.value.value.problems.length > 0) return fail("run", run.value.value.problems.join(" "));
    throw back("run");
  }
  if (intent === "lift") {
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    if (note.length < 5) return fail("lift", "Say why it is lifted, for whoever looks next.");
    const result = await settle(admin.liftBreaker(note, staff.email));
    if (!result.ok) return fail("lift", `Billing did not answer: ${result.error}`);
    if (!result.value.ok) return fail("lift", result.value.error.message);
    throw back("lifted", "#spend");
  }
  if (intent === "pause" || intent === "resume") {
    const level = parsePauseLevel(form.get("level"));
    if (!level) return fail("platform", "Pick compute, schedules, indexing or renders.");
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    if (note.length < 5) return fail(`pause-${level}`, "Say why, for whoever looks next.");
    const result = await settle(admin.setPause(level, intent === "pause", note, staff.email));
    if (!result.ok) return fail(`pause-${level}`, `Billing did not answer: ${result.error}`);
    if (!result.value.ok) return fail(`pause-${level}`, result.value.error.message);
    throw back(intent === "pause" ? "paused" : "resumed", "#platform");
  }
  if (intent === "decide") {
    const id = String(form.get("id") ?? "");
    const decision = form.get("decision") === "approve" ? "approve" : "reject";
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    if (decision === "reject" && note.length < 5) return fail(`proposal-${id}`, "Say why it is rejected, for whoever measures it next.");
    const result = await admin.decideProposal(id, decision, note, staff.email);
    if (!result.ok) return fail(`proposal-${id}`, result.error.message);
    throw back(decision === "approve" ? "approved" : "rejected", "#proposals");
  }
  if (intent === "settings") {
    const parsed = parseCostSettings(form);
    if (!parsed.ok) return fail("settings", parsed.error);
    const result = await admin.setCostSettings(parsed.value, staff.email);
    if (!result.ok) return fail("settings", result.error.message);
    throw back("settings", "#guardrails");
  }
  if (intent === "mapping") {
    const parsed = parseMapping(form);
    if (!parsed.ok) return fail("mapping", parsed.error);
    const result = await admin.setCostMapping(parsed.value, staff.email);
    if (!result.ok) return fail("mapping", result.error.message);
    throw back(parsed.value.remove ? "removed" : "mapping", "#mappings");
  }
  return fail("run", "Unknown change.");
}
