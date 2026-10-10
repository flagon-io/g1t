/**
 * The one way money is written on g1t: a sum in millionths of a dollar
 * (micros, as every service counts it) as `$1,234.56`. Every page, the
 * top bar's pill, Spend, Home, Usage, the statement and the price book
 * read the same arithmetic, so the same sum reads the same everywhere.
 *
 * - Rounding is on whole micros, half up at the last place shown; never on
 *   a floating-point `toFixed`, which rounds `.5` either way.
 * - Negatives lead with a minus sign (U+2212); thousands are separated.
 * - By default, to the cent, and a fraction of a cent reads `<$0.01`
 *   rather than `$0.00` or `$0.004`: a total is a total. Exactly nothing
 *   is `$0.00`.
 * - `precise` shows up to four places (`$0.0063`), trailing zeros trimmed
 *   down to two, for where the fraction of a cent is the point: a
 *   statement's lines, a receipt, the price book, per-token rates.
 * - `compact` is an axis label: `$0`, `$0.50`, `$2`, `$1.2K`.
 *
 * Pure, so it is tested on its own; it imports nothing.
 */

/** Millionths of a dollar in one dollar, as `@g1t/contracts` `MICROS_PER_DOLLAR`; here so this file imports nothing. */
export const MICROS_PER_DOLLAR = 1_000_000;

export type MoneyOptions = {
  /** Up to four places, trailing zeros trimmed to two: `$0.0063`, `$0.25`. */
  precise?: boolean;
  /** An axis label: whole dollars without places, thousands as `$1.2K`. */
  compact?: boolean;
};

const MINUS = "−";

/** `micros` as whole micros, rounded half up at `unit` (10_000 for a cent, 100 for a hundredth of one), as a count of units. Non-negative input. */
function unitsOf(micros: number, unit: number): number {
  return Math.floor((micros + unit / 2) / unit);
}

/** Thousands separated: `1234567` as `1,234,567`. */
function grouped(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `units` of `scale` places as `whole.fraction`, the fraction trimmed down to `min` places. */
function withPlaces(units: number, places: number, min: number): string {
  const per = 10 ** places;
  const whole = Math.floor(units / per);
  let fraction = String(units % per).padStart(places, "0");
  while (fraction.length > min && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction ? `${grouped(whole)}.${fraction}` : grouped(whole);
}

/** Dollars, to the cent. See the file's notes for `precise` and `compact`. */
export function money(micros: number, options: MoneyOptions = {}): string {
  const sign = micros < 0 ? MINUS : "";
  // Whole micros only: a float that reached here is rounded before anything else.
  const abs = Math.round(Math.abs(micros));
  if (abs === 0) return options.compact ? "$0" : "$0.00";
  if (options.compact) {
    if (abs >= 1_000_000 * MICROS_PER_DOLLAR) return `${sign}$${withPlaces(unitsOf(abs, 100_000 * MICROS_PER_DOLLAR), 1, 0)}M`;
    if (abs >= 1_000 * MICROS_PER_DOLLAR) return `${sign}$${withPlaces(unitsOf(abs, 100 * MICROS_PER_DOLLAR), 1, 0)}K`;
    if (abs % MICROS_PER_DOLLAR === 0) return `${sign}$${grouped(abs / MICROS_PER_DOLLAR)}`;
    return `${sign}$${withPlaces(unitsOf(abs, 100), 4, 2)}`;
  }
  if (options.precise) {
    const units = unitsOf(abs, 100);
    return units === 0 ? `<${sign}$0.0001` : `${sign}$${withPlaces(units, 4, 2)}`;
  }
  if (abs < 10_000) return `<${sign}$0.01`;
  return `${sign}$${withPlaces(unitsOf(abs, 10_000), 2, 2)}`;
}

/** Whole dollars when they are whole, else to the cent: `$1,000`, `$0.10`. The price book's and the prepay presets' style. */
export function wholeDollars(micros: number): string {
  const abs = Math.round(Math.abs(micros));
  if (abs % MICROS_PER_DOLLAR !== 0) return money(micros);
  return `${micros < 0 ? MINUS : ""}$${grouped(abs / MICROS_PER_DOLLAR)}`;
}

/**
 * Dollars for a form field, with no sign or symbol, to the cent: `12.50`;
 * with `whole`, `20` for a whole sum. Rounded the same way as `money`.
 */
export function plainDollars(micros: number, options: { whole?: boolean } = {}): string {
  const abs = Math.round(Math.abs(micros));
  const cents = unitsOf(abs, 10_000);
  const text = options.whole && cents % 100 === 0 ? String(cents / 100) : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  return micros < 0 ? `-${text}` : text;
}

/** A sum in dollars (a float from a service that counts in dollars) as whole micros. */
export function microsOf(dollars: number): number {
  return Math.round(dollars * MICROS_PER_DOLLAR);
}
