import type { GuardrailSettings, RunKind } from "@g1t/contracts";

/** What a level's form field means: inherit, or a choice of its own. */
export type Tri = "inherit" | "on" | "off";

export function tri(value: boolean | null | undefined): Tri {
  return value == null ? "inherit" : value ? "on" : "off";
}

/** Lines of a textarea, trimmed, without blanks or repeats. */
export function lines(value: FormDataEntryValue | null): string[] {
  const seen = new Set<string>();
  for (const line of String(value ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** A number from a field; empty means inherit. Not a number is kept, to be refused. */
function amount(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** What one level's form says, as the settings that level keeps. */
export function settingsFromForm(
  form: FormData,
  catalog: { registries: string[]; rules: string[]; kinds: readonly RunKind[] },
): GuardrailSettings {
  const choice = (name: string): boolean | null => {
    const value = form.get(name);
    return value === "on" ? true : value === "off" ? false : null;
  };
  const rules: Record<string, boolean> = {};
  for (const id of catalog.rules) {
    const on = choice(`rule:${id}`);
    if (on != null) rules[id] = on;
  }
  const minutes: Record<string, number> = {};
  for (const kind of catalog.kinds) {
    const cap = amount(form.get(`minutes:${kind}`));
    if (cap != null) minutes[kind] = Number.isNaN(cap) ? 0 : Math.trunc(cap);
  }
  const budget = amount(form.get("budgetUsd"));
  return {
    restrictNetwork: choice("restrictNetwork"),
    registries:
      form.get("registries") === "custom"
        ? catalog.registries.filter((id) => form.get(`registry:${id}`) === "on")
        : null,
    domains: lines(form.get("domains")),
    rules,
    deny: lines(form.get("deny")),
    // Not a number is sent as one the service refuses, with why.
    budgetUsd: budget == null ? null : Number.isNaN(budget) ? -1 : budget,
    minutes,
  };
}

/** A cost in dollars, or "no cap". */
export function formatCap(usd: number | null | undefined): string {
  return usd == null ? "no cap" : `$${usd.toFixed(2)}`;
}

/** How full a cap is, from 0 to 1, or null with no cap. */
export function capShare(used: number | null | undefined, cap: number | null | undefined): number | null {
  if (cap == null || cap <= 0 || used == null) return null;
  return Math.min(1, Math.max(0, used / cap));
}
