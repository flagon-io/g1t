/**
 * Costs & margin's chart: a day per slot, what customers were charged
 * (lavender) beside what it cost on Cloudflare (gray, red on a day that
 * lost money). Drawn on the server as SVG like sudo's other charts: no
 * script, no inline style, a <title> per day for hover, and a table.
 */
import { axisDollars, barPath, niceCeiling, ticks } from "~/lib/chart";
import { type DayFigures, marginPercent, percentLabel } from "~/lib/costs";
import { usd } from "~/lib/money";

const CHARGED = "var(--g1t-accent)";
const COST = "#7a7a84";
const LOSS = "var(--g1t-danger)";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-05` → `Oct 5`. */
export function dayLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7);
  return `${month} ${Number(day.slice(8, 10))}`;
}

function Legend({ revenueLabel }: { revenueLabel: string }) {
  const swatch = (fill: string) => (
    <svg width="10" height="10" aria-hidden="true">
      <rect width="10" height="10" rx="2" fill={fill} />
    </svg>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        {swatch(CHARGED)}
        {revenueLabel}
      </span>
      <span className="inline-flex items-center gap-1.5">
        {swatch(COST)}
        Cloudflare cost
      </span>
      <span className="inline-flex items-center gap-1.5">
        {swatch(LOSS)}
        Cost on a day under the floor
      </span>
    </div>
  );
}

function DaysSvg({ days, width, height, floor, label }: { days: DayFigures[]; width: number; height: number; floor: number; label: string }) {
  const left = width < 400 ? 40 : 52;
  const plot = { x: left, y: 10, width: Math.max(1, width - left - 8), height: Math.max(1, height - 10 - 26) };
  const top = niceCeiling(Math.max(0, ...days.flatMap((d) => [d.revenueMicros, d.costMicros])));
  const baseline = plot.y + plot.height;
  const scale = (value: number) => {
    const clamped = Math.max(0, value);
    const h = (clamped / top) * plot.height;
    return clamped > 0 ? Math.max(1.5, h) : 0;
  };
  const slot = days.length > 0 ? plot.width / days.length : plot.width;
  const gap = slot > 8 ? 1 : 0;
  const bar = Math.max(1, Math.min(14, slot * 0.38));
  // About six labels across, whatever the range.
  const every = Math.max(1, Math.ceil(days.length / (width < 400 ? 4 : 8)));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img" aria-label={label}>
      {ticks(top, 4).map((value) => {
        const y = baseline - (value / top) * plot.height;
        return (
          <g key={value}>
            <line x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke="var(--g1t-line)" strokeWidth="1" strokeDasharray={value === 0 ? undefined : "2 4"} />
            <text x={plot.x - 8} y={y + 3.5} textAnchor="end" fontSize="11" className="fill-faint tabular">
              {axisDollars(value)}
            </text>
          </g>
        );
      })}
      {days.map((d, index) => {
        const x = plot.x + index * slot;
        const center = x + slot / 2;
        const revenue = scale(d.revenueMicros);
        const cost = scale(d.costMicros);
        const margin = marginPercent(d.revenueMicros, d.costMicros);
        const losing = d.costMicros > 0 && (margin == null || margin < floor);
        const last = index === days.length - 1;
        return (
          <g key={d.day}>
            <title>{`${dayLabel(d.day)}: charged ${usd(d.revenueMicros)}, Cloudflare cost ${usd(d.costMicros)}, margin ${percentLabel(margin)}`}</title>
            <rect x={x} y={plot.y} width={slot} height={plot.height} fill="transparent" className="hover:fill-raised/40" />
            <path d={barPath({ x: center - gap / 2 - bar, y: baseline - revenue, width: bar, height: revenue }, 2)} fill={CHARGED} />
            <path d={barPath({ x: center + gap / 2, y: baseline - cost, width: bar, height: cost }, 2)} fill={losing ? LOSS : COST} />
            {(index % every === 0 || last) && (
              <text x={center} y={baseline + 17} textAnchor="middle" fontSize="11" className={last ? "fill-fg-soft" : "fill-faint"}>
                {dayLabel(d.day)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Charged against Cloudflare's cost, a day at a time, drawn for a phone and for wider screens. */
export function DaysChart({ days, floor, revenueLabel, label }: { days: DayFigures[]; floor: number; revenueLabel: string; label: string }) {
  if (days.length === 0) return <p className="text-sm text-muted">No days to show yet.</p>;
  return (
    <div>
      <Legend revenueLabel={revenueLabel} />
      <div className="mt-3 sm:hidden">
        <DaysSvg days={days} width={340} height={200} floor={floor} label={label} />
      </div>
      <div className="mt-3 hidden sm:block">
        <DaysSvg days={days} width={1080} height={240} floor={floor} label={label} />
      </div>
      <details className="group mt-2">
        <summary className="cursor-pointer list-none text-xs text-faint select-none hover:text-muted [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show as a table</span>
          <span className="hidden group-open:inline">Hide the table</span>
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-1.5 pr-3 font-medium">Day</th>
                <th className="py-1.5 pr-3 text-right font-medium">{revenueLabel}</th>
                <th className="py-1.5 pr-3 text-right font-medium">Cloudflare cost</th>
                <th className="py-1.5 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => {
                const margin = marginPercent(d.revenueMicros, d.costMicros);
                return (
                  <tr key={d.day} className="tabular border-b border-line last:border-0">
                    <td className="py-1.5 pr-3 text-fg-soft">{dayLabel(d.day)}</td>
                    <td className="py-1.5 pr-3 text-right">{usd(d.revenueMicros)}</td>
                    <td className="py-1.5 pr-3 text-right text-muted">{usd(d.costMicros)}</td>
                    <td className={`py-1.5 text-right ${margin != null && margin < floor ? "text-danger" : "text-fg-soft"}`}>{percentLabel(margin)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
