/**
 * The arithmetic behind sudo's charts, kept apart from the SVG so it can
 * be tested under Node. Money is in micros throughout.
 */
import type { MonthFigures } from "@g1t/contracts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-10` → `Oct`; anything else as it came. */
export function monthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const index = match ? Number(match[2]) - 1 : -1;
  return MONTHS[index] ?? month;
}

/** `2026-10` → `October 2026`. */
export function monthLong(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const index = match ? Number(match[2]) - 1 : -1;
  return match && MONTHS_LONG[index] ? `${MONTHS_LONG[index]} ${match[1]}` : month;
}

/**
 * The top of an axis for values up to `max`: the next 1, 2, 2.5 or 5
 * times a power of ten, so its ticks are round numbers. A dollar when
 * there is nothing to show, so an empty chart still has an axis.
 */
export function niceCeiling(max: number, floor = 1_000_000): number {
  const value = Math.max(max, floor);
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

/** Evenly spaced ticks from zero to `top`, inclusive. */
export function ticks(top: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, index) => (top / count) * index);
}

/** A margin and its share of what was charged; no share when nothing was. */
export function marginOf(chargedMicros: number, costMicros: number): { micros: number; percent: number | null } {
  const micros = chargedMicros - costMicros;
  return { micros, percent: chargedMicros > 0 ? Math.round((micros / chargedMicros) * 100) : null };
}

/** The change from one figure to the next, as a whole percent; none from zero. */
export function change(before: number, after: number): number | null {
  if (before <= 0) return null;
  return Math.round(((after - before) / before) * 100);
}

export type Rect = { x: number; y: number; width: number; height: number };

export type MonthBars = {
  month: string;
  label: string;
  /** Where the month's slot is, for its label and hover target. */
  slot: Rect;
  charged: Rect;
  cost: Rect;
  figures: MonthFigures;
};

export type BarChart = {
  width: number;
  height: number;
  /** The plot area, inside the axis labels. */
  plot: Rect;
  top: number;
  /** Each tick's value and its y. */
  ticks: { value: number; y: number }[];
  bars: MonthBars[];
};

/**
 * Two bars a month, charged beside cost, scaled to one axis from zero.
 * Bars keep a 2px gap between them and a minimum visible height when
 * their value is above zero, so a small month still shows.
 */
export function monthBars(
  months: MonthFigures[],
  { width = 600, height = 220, left = 52, right = 8, top: padTop = 10, bottom = 26, count = 4 } = {},
): BarChart {
  const plot = { x: left, y: padTop, width: Math.max(1, width - left - right), height: Math.max(1, height - padTop - bottom) };
  const top = niceCeiling(Math.max(0, ...months.flatMap((month) => [month.chargedMicros, month.costMicros])));
  const baseline = plot.y + plot.height;
  const scale = (value: number) => {
    const clamped = Math.max(0, value);
    const h = (clamped / top) * plot.height;
    return clamped > 0 ? Math.max(1.5, h) : 0;
  };
  const slotWidth = months.length > 0 ? plot.width / months.length : plot.width;
  const gap = 2;
  const barWidth = Math.max(2, Math.min(28, slotWidth * 0.3));
  const bars = months.map((figures, index) => {
    const slotX = plot.x + index * slotWidth;
    const center = slotX + slotWidth / 2;
    const chargedHeight = scale(figures.chargedMicros);
    const costHeight = scale(figures.costMicros);
    return {
      month: figures.month,
      label: monthShort(figures.month),
      slot: { x: slotX, y: plot.y, width: slotWidth, height: plot.height },
      charged: { x: center - gap / 2 - barWidth, y: baseline - chargedHeight, width: barWidth, height: chargedHeight },
      cost: { x: center + gap / 2, y: baseline - costHeight, width: barWidth, height: costHeight },
      figures,
    };
  });
  return {
    width,
    height,
    plot,
    top,
    ticks: ticks(top, count).map((value) => ({ value, y: baseline - (value / top) * plot.height })),
    bars,
  };
}

/**
 * A bar's outline with its top corners rounded and its foot square on
 * the baseline. Nothing for an empty bar.
 */
export function barPath({ x, y, width, height }: Rect, radius = 4): string {
  if (height <= 0 || width <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  const bottom = y + height;
  const round = (value: number) => Math.round(value * 100) / 100;
  return [
    `M${round(x)} ${round(bottom)}`,
    `V${round(y + r)}`,
    `Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)}`,
    `H${round(x + width - r)}`,
    `Q${round(x + width)} ${round(y)} ${round(x + width)} ${round(y + r)}`,
    `V${round(bottom)}`,
    "Z",
  ].join(" ");
}

/** An axis label: `$0`, `$250`, `$1.5k`, `$20k`, `$1.2M`. */
export function axisDollars(micros: number): string {
  const dollars = micros / 1_000_000;
  const trim = (value: number) => String(Number(value.toFixed(1)));
  if (dollars >= 1_000_000) return `$${trim(dollars / 1_000_000)}M`;
  if (dollars >= 1_000) return `$${trim(dollars / 1_000)}k`;
  if (dollars >= 1 || dollars === 0) return `$${trim(dollars)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Each value's share of the largest, from 0 to 1, for a row of bars. */
export function shares(values: number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((value) => (max > 0 ? Math.max(0, value) / max : 0));
}
