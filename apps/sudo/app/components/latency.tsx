/**
 * An incident's parts, check by check: a latency chart per part, drawn as
 * SVG on the server, with the slow line, slow checks dotted and failures
 * marked along the top, and the latest checks as a table under it. No
 * script and no inline style (sudo ships no JavaScript); the table is the
 * way to read exact figures.
 */
import type { CheckHistory } from "@g1t/contracts";

import { When } from "~/components/ui";
import { latencyPlot, latencySummary, msWords, summaryWords } from "~/lib/latency";

/** How many of the latest checks the table lists. */
const LISTED = 30;

const OUTCOME = { up: "OK", degraded: "Slow", down: "Not answering" } as const;

function Chart({ history, name }: { history: CheckHistory; name: string }) {
  const p = latencyPlot(history);
  return (
    <svg viewBox={`0 0 ${p.width} ${p.height}`} className="block h-auto w-full" role="img" aria-label={`${name}: how long each check took, ${summaryWords(latencySummary(history.samples))}`}>
      {p.ticks.map((t) => (
        <g key={t.label}>
          <line x1={p.plot.x} x2={p.plot.x + p.plot.width} y1={t.y} y2={t.y} stroke="var(--g1t-line)" strokeWidth="1" strokeDasharray={t.label === "0" ? undefined : "2 4"} />
          <text x={p.plot.x - 6} y={t.y + 3.5} textAnchor="end" fontSize="10" className="fill-faint tabular">
            {t.label}
          </text>
        </g>
      ))}
      {p.slowY != null && (
        <g>
          <line x1={p.plot.x} x2={p.plot.x + p.plot.width} y1={p.slowY} y2={p.slowY} stroke="var(--g1t-warn)" strokeWidth="1" strokeDasharray="4 3" />
          <text x={p.plot.x + p.plot.width} y={p.slowY - 3} textAnchor="end" fontSize="10" className="fill-warn">
            slow over {msWords(history.slow_ms!)}
          </text>
        </g>
      )}
      {p.down.map((d, i) => (
        <rect key={`d${i}`} x={d.x - 1} y={p.plot.y} width="2" height={p.plot.height} className="fill-danger/35" />
      ))}
      <path d={p.line} fill="none" stroke="var(--g1t-accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {p.slow.map((s, i) => (
        <circle key={`s${i}`} cx={s.x} cy={s.y} r="2.5" className="fill-warn" />
      ))}
      <text x={p.plot.x} y={p.height - 4} fontSize="10" className="fill-faint">
        {new Date(history.from).toISOString().slice(11, 16)} UTC
      </text>
      <text x={p.plot.x + p.plot.width} y={p.height - 4} textAnchor="end" fontSize="10" className="fill-faint">
        {new Date(history.to).toISOString().slice(11, 16)} UTC
      </text>
    </svg>
  );
}

function Part({ history, name }: { history: CheckHistory; name: string }) {
  const summary = latencySummary(history.samples);
  const latest = history.samples.slice(-LISTED).reverse();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-sm font-medium">{name}</h3>
        {summary.checks > 0 && <p className="text-xs text-faint">{summaryWords(summary)}</p>}
      </div>
      {history.samples.length === 0 ? (
        <p className="text-sm text-muted">No checks kept for this span: checks are kept for 7 days.</p>
      ) : (
        <>
          <Chart history={history} name={name} />
          <details className="group">
            <summary className="cursor-pointer text-xs text-muted select-none hover:text-fg">
              The latest {Math.min(LISTED, history.samples.length)} checks
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs tabular">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1 pr-3 font-normal">At</th>
                    <th className="py-1 pr-3 font-normal">Took</th>
                    <th className="py-1 pr-3 font-normal">Result</th>
                    <th className="py-1 pr-3 font-normal">From</th>
                    <th className="py-1 font-normal">First try</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.map((s) => (
                    <tr key={s.at} className="border-t border-line">
                      <td className="py-1 pr-3 whitespace-nowrap">
                        <When at={s.at} time />
                      </td>
                      <td className="py-1 pr-3">{s.ms != null ? msWords(s.ms) : "—"}</td>
                      <td className={`py-1 pr-3 ${s.outcome === "down" ? "text-danger" : s.outcome === "degraded" ? "text-warn" : "text-muted"}`}>{OUTCOME[s.outcome]}</td>
                      <td className="py-1 pr-3 font-mono">{s.colo ?? "—"}</td>
                      <td className="py-1 text-faint">{s.first_ms != null ? `${msWords(s.first_ms)}, asked again` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

/** Every part's checks around an incident. */
export function IncidentChecks({ checks, names }: { checks: CheckHistory[]; names: Map<string, string> }) {
  return (
    <div className="space-y-5">
      {checks.map((h) => (
        <Part key={h.key} history={h} name={names.get(h.key) ?? h.key} />
      ))}
    </div>
  );
}
