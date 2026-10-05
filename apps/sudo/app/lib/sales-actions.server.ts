/**
 * Changes to a workspace's sales record: its stage, owner and next step,
 * and notes. Not money, so no confirmation step; still POSTs from sudo's
 * own pages only (the worker checks), each recorded with who made it.
 */
import { data, redirect } from "react-router";

import { fields, parseSales, parseSalesNote, text } from "./forms";
import type { ActionData } from "./review";
import { admin } from "./services.server";
import type { Staff } from "./staff";

export const SALES_INTENTS = new Set(["sales", "note"]);

function failed(section: string, error: string, values?: Record<string, string>) {
  return data<ActionData>({ error, section, values }, { status: 422 });
}

/** Unexpected trouble from billing, as a message for the form. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Billing did not answer.";
}

export async function salesAction(form: FormData, staff: Staff, workspace: string, path: string) {
  const intent = text(form, "intent");
  const back = (done: string, anchor: string) => redirect(`${path}?done=${done}#${anchor}`);

  if (intent === "sales") {
    const values = fields(form, "stage", "owner", "nextStep", "nextAt");
    const parsed = parseSales(form);
    if (!parsed.ok) return failed("sales", parsed.error, values);
    try {
      const result = await admin.setSales(workspace, parsed.value, staff.email);
      if (!result.ok) return failed("sales", result.error.message, values);
    } catch (error) {
      return failed("sales", reason(error), values);
    }
    return back("sales", "sales");
  }

  if (intent === "note") {
    const values = fields(form, "text");
    const note = parseSalesNote(values.text);
    if (!note.ok) return failed("note", note.error, values);
    try {
      const result = await admin.addNote(workspace, note.value, staff.email);
      if (!result.ok) return failed("note", result.error.message, values);
    } catch (error) {
      return failed("note", reason(error), values);
    }
    return back("note", "notes");
  }

  return failed("top", "Unknown action.");
}
