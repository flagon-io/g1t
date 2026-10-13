import type { GuardrailSettings, RunKind } from "@g1t/contracts";
import { microsOf, money } from "./money.ts";

/** A number from a field; empty means inherit. Not a number is kept, to be refused. */
function amount(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** The kinds of run that still use a sandbox: checks, the merge queue and merge checks. */
export const SANDBOX_RUN_KINDS = ["checks", "queue", "mergecheck"] as const satisfies readonly RunKind[];

/**
 * What one level's form says, as the settings that level keeps: a time cap
 * for each kind of run it sets, the rest inherited.
 */
export function settingsFromForm(form: FormData, catalog: { kinds: readonly RunKind[] }): GuardrailSettings {
  const minutes: Record<string, number> = {};
  for (const kind of catalog.kinds) {
    const cap = amount(form.get(`minutes:${kind}`));
    if (cap != null) minutes[kind] = Number.isNaN(cap) ? 0 : Math.trunc(cap);
  }
  return { minutes };
}

/** A cost in dollars, or "no cap". */
export function formatCap(usd: number | null | undefined): string {
  return usd == null ? "no cap" : money(microsOf(usd));
}

/** How full a cap is, from 0 to 1, or null with no cap. */
export function capShare(used: number | null | undefined, cap: number | null | undefined): number | null {
  if (cap == null || cap <= 0 || used == null) return null;
  return Math.min(1, Math.max(0, used / cap));
}
