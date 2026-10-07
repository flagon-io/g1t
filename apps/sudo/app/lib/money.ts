/** Money is held in micros: millionths of a dollar. */
export const MICROS_PER_DOLLAR = 1_000_000;

const WHOLE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SMALL = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/**
 * Dollars, to the cent; amounts under a dollar keep up to four places, so
 * a run that cost a fraction of a cent does not read as nothing. With
 * `cents`, always to the cent: for statements, where figures sit in columns.
 */
export function usd(micros: number | null | undefined, { signed = false, cents = false }: { signed?: boolean; cents?: boolean } = {}): string {
  if (micros == null) return "—";
  const dollars = micros / MICROS_PER_DOLLAR;
  const text = (Math.abs(dollars) < 1 && !cents ? SMALL : WHOLE).format(Math.abs(dollars));
  if (dollars < 0) return `−${text}`;
  return signed && dollars > 0 ? `+${text}` : text;
}

/**
 * Micros from a dollar amount as typed: `25`, `25.5`, `$1,250.00`. Null
 * unless it is a non-negative amount to the cent, under ten million.
 */
export function parseDollars(input: string): number | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return Number(match[1]) * MICROS_PER_DOLLAR + cents * 10_000;
}

/** A micros amount as dollars for a form field: `1250.5` → `"1250.50"`. */
export function dollarsField(micros: number | null | undefined): string {
  return micros == null ? "" : (micros / MICROS_PER_DOLLAR).toFixed(2);
}
