import type { GuardrailSettings, RunKind } from "@g1t/contracts";

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
