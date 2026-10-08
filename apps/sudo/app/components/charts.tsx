/**
 * Charts drawn as SVG on the server. No script and no inline style: every
 * size is an SVG attribute and every colour a class or a token. Hovering a
 * month shows its figures (an SVG <title>), and each chart has a table.
 */
import type { MonthFigures } from "@g1t/contracts";

import { axisDollars, barPath, marginOf, monthBars, monthLong, shares } from "~/lib/chart";
import { usd } from "~/lib/money";

/** The two series: what was charged (lavender) beside what it cost g1t (gray). */
const CHARGED = "var(--g1t-accent)";
const COST = "#7a7a84";

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden="true">
          <rect width="10" height="10" rx="2" fill={CHARGED} />
        </svg>
        Charged
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden="true">
          <rect width="10" height="10" rx="2" fill={COST} />
        </svg>
        Cost to g1t
      </span>
    </div>
  );
}

function BarsSvg({ months, width, height, label }: { months: MonthFigures[]; width: number; height: number; label: string }) {
  const chart = monthBars(months, { width, height, left: width < 400 ? 40 : 52 });
  const { plot } = chart;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img" aria-label={label}>
      {chart.ticks.map((tick) => (
        <g key={tick.value}>
          <line
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={tick.y}
            y2={tick.y}
            stroke="var(--g1t-line)"
            strokeWidth="1"
            strokeDasharray={tick.value === 0 ? undefined : "2 4"}
          />
          <text x={plot.x - 8} y={tick.y + 3.5} textAnchor="end" fontSize="11" className="fill-faint tabular">
            {axisDollars(tick.value)}
          </text>
        </g>
      ))}
      {chart.bars.map((bar, index) => {
        const margin = marginOf(bar.figures.chargedMicros, bar.figures.costMicros);
        const last = index === chart.bars.length - 1;
        return (
          <g key={bar.month}>
            <title>
              {`${monthLong(bar.month)}: charged ${usd(bar.figures.chargedMicros)}, cost ${usd(bar.figures.costMicros)}, margin ${usd(margin.micros)}${margin.percent != null ? ` (${margin.percent}%)` : ""}`}
            </title>
            {/* The whole column answers to hover, not just the bars. */}
            <rect x={bar.slot.x} y={bar.slot.y} width={bar.slot.width} height={bar.slot.height} fill="transparent" className="hover:fill-raised/40" />
            <path d={barPath(bar.charged)} fill={CHARGED} />
            <path d={barPath(bar.cost)} fill={COST} />
            <text
              x={bar.slot.x + bar.slot.width / 2}
              y={plot.y + plot.height + 17}
              textAnchor="middle"
              fontSize="11"
              className={last ? "fill-fg-soft" : "fill-faint"}
            >
              {bar.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Six months of charged against cost, as grouped bars. Drawn twice, for a
 * phone and for wider screens, as type in an SVG scales with it.
 */
export function MonthsChart({
  months,
  label = "Charged and cost to g1t, by month",
  wide = false,
}: {
  months: MonthFigures[];
  label?: string;
  /** Spans the page: drawn wider and shorter, so its type stays small. */
  wide?: boolean;
}) {
  if (months.length === 0) return <p className="text-sm text-muted">No months to show yet.</p>;
  return (
    <div>
      <Legend />
      <div className="mt-3 sm:hidden">
        <BarsSvg months={months} width={340} height={190} label={label} />
      </div>
      <div className="mt-3 hidden sm:block">
        <BarsSvg months={months} width={wide ? 1080 : 640} height={wide ? 230 : 220} label={label} />
      </div>
      <details className="group mt-2">
        <summary className="cursor-pointer list-none text-xs text-faint select-none hover:text-muted [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show as a table</span>
          <span className="hidden group-open:inline">Hide the table</span>
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-1.5 pr-3 font-medium">Month</th>
                <th className="py-1.5 pr-3 text-right font-medium">Charged</th>
                <th className="py-1.5 pr-3 text-right font-medium">Plans</th>
                <th className="py-1.5 pr-3 text-right font-medium">Cost</th>
                <th className="py-1.5 pr-3 text-right font-medium">Given</th>
                <th className="py-1.5 pr-3 text-right font-medium">Net</th>
                <th className="py-1.5 text-right font-medium">Paid</th>
              </tr>
            </thead>
            <tbody>
              {months.map((month) => {
                const margin = marginOf(month.chargedMicros + (month.plansMicros ?? 0), month.costMicros);
                return (
                  <tr key={month.month} className="tabular border-b border-line last:border-0">
                    <td className="py-1.5 pr-3 text-fg-soft">{monthLong(month.month)}</td>
                    <td className="py-1.5 pr-3 text-right">{usd(month.chargedMicros)}</td>
                    <td className="py-1.5 pr-3 text-right">{usd(month.plansMicros ?? 0)}</td>
                    <td className="py-1.5 pr-3 text-right text-muted">{usd(month.costMicros)}</td>
                    <td className="py-1.5 pr-3 text-right text-accent">{usd(month.givenMicros ?? 0)}</td>
                    <td className={`py-1.5 pr-3 text-right ${margin.micros < 0 ? "text-danger" : "text-fg-soft"}`}>
                      {usd(margin.micros)}
                      {margin.percent != null && <span className="text-faint"> {margin.percent}%</span>}
                    </td>
                    <td className="py-1.5 text-right text-muted">{usd(month.paidMicros)}</td>
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

/** A thin bar for a share from 0 to 1, as a row of a breakdown. */
export function ShareBar({ share, label }: { share: number; label: string }) {
  const width = Math.max(0, Math.min(1, share)) * 100;
  return (
    <svg viewBox="0 0 100 4" preserveAspectRatio="none" className="block h-1.5 w-full" role="img" aria-label={label}>
      <rect x="0" y="0" width="100" height="4" rx="2" fill="var(--g1t-raised)" />
      {width > 0 && <rect x="0" y="0" width={Math.max(1.5, width)} height="4" rx="2" fill={CHARGED} />}
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  models: "Models",
  model: "Models",
  sandbox: "Sandboxes",
  sandboxes: "Sandboxes",
  deployments: "Deployments",
  builds: "Builds",
  plans: "Plans",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

/** This month by kind of usage: each kind's charge, cost and margin, largest first. */
export function KindBreakdown({ kinds }: { kinds: { kind: string; chargedMicros: number; costMicros: number }[] }) {
  if (kinds.length === 0) return <p className="text-sm text-muted">Nothing charged yet this month.</p>;
  const sorted = [...kinds].sort((a, b) => b.chargedMicros - a.chargedMicros || b.costMicros - a.costMicros);
  const total = sorted.reduce((sum, row) => sum + row.chargedMicros, 0);
  const bars = shares(sorted.map((row) => row.chargedMicros));
  return (
    <ul className="space-y-3.5">
      {sorted.map((row, index) => {
        const margin = marginOf(row.chargedMicros, row.costMicros);
        const share = total > 0 ? Math.round((row.chargedMicros / total) * 100) : 0;
        return (
          <li key={row.kind}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-fg-soft">{kindLabel(row.kind)}</span>
              <span className="tabular text-fg">{usd(row.chargedMicros)}</span>
            </div>
            <div className="mt-1.5">
              <ShareBar share={bars[index]} label={`${kindLabel(row.kind)}: ${share}% of this month's charges`} />
            </div>
            <p className="tabular mt-1 flex justify-between gap-3 text-xs text-faint">
              <span>
                {share}% of charges · cost {usd(row.costMicros)}
              </span>
              <span className={margin.micros < 0 ? "text-danger" : undefined}>
                margin {usd(margin.micros)}
                {margin.percent != null && ` · ${margin.percent}%`}
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
