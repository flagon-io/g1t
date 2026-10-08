/**
 * An account's terms as sudo names them: a discount from 0 to 100%, and a
 * 100% discount is what used to be "comped" (billing reads a leftover
 * `comped` row as 100%). No Workers or React imports, so it can be tested
 * under Node.
 */
import type { Terms } from "@g1t/contracts";

/** The discount presets on the terms form, in percent. */
export const DISCOUNT_PRESETS = [0, 25, 50, 100] as const;

/** The discount in percent, 0 to 100. */
export function percentOff(terms: Pick<Terms, "kind" | "discountPercent">): number {
  if (terms.kind === "comped") return 100;
  if (terms.kind === "custom") return Math.min(100, Math.max(0, terms.discountPercent));
  return 0;
}

/** A 100% discount: nothing charged, usage shown at its price; g1t's own spend on it held to a monthly budget. */
export function fullDiscount(terms: Pick<Terms, "kind" | "discountPercent">): boolean {
  return percentOff(terms) >= 100;
}

/** `100% discount`, `30% off`, `Custom limit` or `Standard`. */
export function termsLabel(terms: Pick<Terms, "kind" | "discountPercent">): string {
  const percent = percentOff(terms);
  if (percent >= 100) return "100% discount";
  if (percent > 0) return `${percent}% off`;
  return terms.kind === "standard" ? "Standard" : "Custom limit";
}
