/**
 * Spend threaded to the work it produced (lib/signals.ts spendFlow): the
 * quarter's milestones, the chosen one's work items, the chosen work
 * item's change set in each project, and that change set's pull requests.
 * Each box is sized by what the agents' usage on it came to (by its pull
 * requests when usage is not known) and shaded by how much of it was an
 * agent's. Choosing a box opens what is under it; on a phone the columns
 * stack.
 */
import { Bot } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Link } from "react-router";

import { cn } from "../lib/cn";
import { type FlowNode, type FlowPull, agentStep, flowAgentShare, dollars, percent } from "../lib/signals";

/** The five steps of agent use: the accent, from a wash to full. */
const STEP_FILL = [
  "color-mix(in oklab, var(--color-accent) 10%, var(--color-surface))",
  "color-mix(in oklab, var(--color-accent) 24%, var(--color-surface))",
  "color-mix(in oklab, var(--color-accent) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-accent) 68%, var(--color-surface))",
  "var(--color-accent)",
];
/** Steps deep enough that their text turns: white on the light theme's accent, near black on the dark theme's pale one. */
const DARK_STEP = 3;

const HEIGHT = 480;
const GAP = 12;
const MIN_BOX = 76;
/** Columns' left edges and width, in percent of the canvas: the pull requests' column is wider, for their titles. */
const COLUMN = 19;
const left = (column: number) => column * 23.5;

type Box = { top: number; height: number };

/** Boxes down a column, each at least MIN_BOX tall and the rest shared by weight. */
function stack(weights: number[]): Box[] {
  const n = weights.length;
  if (n === 0) return [];
  const free = HEIGHT - GAP * (n - 1) - MIN_BOX * n;
  const total = weights.reduce((sum, w) => sum + w, 0);
  let top = 0;
  return weights.map((w) => {
    const height = MIN_BOX + (total > 0 ? (w / total) * free : free / n);
    const box = { top, height };
    top += height + GAP;
    return box;
  });
}

const weightOf = (sized: "spend" | "pulls") => (node: { micros: number; pulls: number }) => (sized === "spend" ? node.micros : node.pulls);

/** A band from a slice of `from` (in column `a`) to all of `to` (in column `a + 1`), as an SVG path in percent across. */
function band(a: number, from: Box, to: Box): string {
  const x0 = left(a) + COLUMN;
  const x1 = left(a + 1);
  const mid = (x0 + x1) / 2;
  return `M${x0},${from.top} C${mid},${from.top} ${mid},${to.top} ${x1},${to.top} L${x1},${to.top + to.height} C${mid},${to.top + to.height} ${mid},${from.top + from.height} ${x0},${from.top + from.height} Z`;
}

/** Slices of a box, one per child, by weight. */
function slices(box: Box, weights: number[]): Box[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let top = box.top;
  return weights.map((w) => {
    const height = total > 0 ? (w / total) * box.height : box.height / weights.length;
    const slice = { top, height };
    top += height;
    return slice;
  });
}

function Legend() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className="font-medium text-fg">Agent use</span>
      <span>less</span>
      <span className="flex gap-0.5" aria-hidden>
        {STEP_FILL.map((fill, i) => (
          <span key={i} className="h-2.5 w-5 rounded-sm" style={{ background: fill }} />
        ))}
      </span>
      <span>more</span>
    </div>
  );
}

function figures(node: FlowNode, sized: "spend" | "pulls"): string {
  const cost = sized === "spend" && node.micros > 0 ? ` · ${dollars(node.micros)}` : "";
  // Only sessions that opened no pull request: what they cost is all there is to say.
  if (node.pulls === 0 && node.direct > 0) return `No PRs${cost}`;
  return `${node.pulls} ${node.pulls === 1 ? "PR" : "PRs"} · ${percent(flowAgentShare(node))} agent${cost}`;
}

function NodeBox({
  node,
  sized,
  chosen,
  onChoose,
  style,
}: {
  node: FlowNode;
  sized: "spend" | "pulls";
  chosen: boolean;
  onChoose?: () => void;
  style?: CSSProperties;
}) {
  const step = agentStep(flowAgentShare(node));
  const dark = step >= DARK_STEP;
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      className={cn(
        "flex flex-col items-start overflow-hidden rounded-xl px-3.5 py-3 text-left transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        chosen ? "ring-[1.5px] ring-fg/80" : "hover:ring-1 hover:ring-line-strong",
        dark ? "text-[light-dark(#ffffff,#141018)]" : "text-fg",
      )}
      style={{ background: STEP_FILL[step], ...style }}
    >
      <span className="line-clamp-2 text-sm leading-snug font-semibold">{node.label}</span>
      <span className={cn("mt-1 font-mono text-[0.6875rem]", dark ? "text-[light-dark(rgb(255_255_255/0.82),rgb(20_16_24/0.75))]" : "text-fg-soft")}>
        {figures(node, sized)}
      </span>
    </button>
  );
}

function PullRow({ pull, style }: { pull: FlowPull; style?: CSSProperties }) {
  return (
    <Link to={pull.to} className="flex items-center gap-3 border-b border-line px-3 text-sm last:border-b-0 hover:bg-raised" style={style}>
      <span className="shrink-0 font-mono text-xs text-muted">#{pull.number}</span>
      <span className="min-w-0 grow truncate font-medium text-fg">{pull.title}</span>
      {pull.agent && <Bot size={13} className="shrink-0 text-accent" aria-label="An agent's" />}
    </Link>
  );
}

const HEADS = ["Milestone", "Work item", "Change set", "Pull requests"];

export function SpendFlow({ flow, sized }: { flow: FlowNode[]; sized: "spend" | "pulls" }) {
  const [path, setPath] = useState<string[]>([]);
  const weight = weightOf(sized);
  // A workspace with no milestones starts at its work items: one "No milestone" box tells nothing.
  const skip = flow.length === 1 && flow[0]!.key === "m-";
  const depth = skip ? 2 : 3;
  const heads = HEADS.slice(3 - depth);
  // The chosen node at each level: the one asked for, else the biggest.
  const columns: FlowNode[][] = [skip ? flow[0]!.children : flow];
  const chosen: FlowNode[] = [];
  for (let level = 0; level < depth; level++) {
    const nodes = columns[level] ?? [];
    const pick = nodes.find((node) => node.key === path[level]) ?? nodes[0];
    if (!pick) break;
    chosen.push(pick);
    if (level < depth - 1) columns.push(pick.children);
  }
  const pulls = chosen[depth - 1]?.list ?? [];
  const direct = chosen[depth - 1]?.direct ?? 0;
  const choose = (level: number, key: string) => setPath([...chosen.slice(0, level).map((node) => node.key), key]);
  const boxes = columns.map((nodes) => stack(nodes.map(weight)));
  const rowHeight = pulls.length > 0 ? HEIGHT / Math.max(pulls.length, 5) : 0;
  const rows: Box[] = pulls.map((_, i) => ({ top: i * rowHeight, height: rowHeight }));

  if (flow.length === 0) return <p className="text-sm text-muted">No pull requests were opened or merged this quarter yet.</p>;

  return (
    <div className="space-y-4">
      <Legend />
      {/* Wide: the columns, joined. */}
      <div className="hidden md:block">
        <div className="relative h-7">
          {heads.map((head, column) => (
            <p key={head} className="absolute top-0 font-mono text-[0.6875rem] tracking-[0.14em] text-muted uppercase" style={{ left: `${left(column)}%` }}>
              {head}
            </p>
          ))}
        </div>
        <div className="relative" style={{ height: HEIGHT }}>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none" aria-hidden>
            {chosen.map((node, level) => {
              const index = columns[level]!.indexOf(node);
              const from = boxes[level]![index]!;
              if (level < depth - 1) {
                const children = columns[level + 1]!;
                return slices(from, children.map(weight)).map((slice, i) => (
                  <path key={`${level}-${i}`} d={band(level, slice, boxes[level + 1]![i]!)} className="fill-line-strong" opacity={0.45} />
                ));
              }
              return slices(
                from,
                rows.map(() => 1),
              ).map((slice, i) => (
                <path
                  key={`p-${i}`}
                  d={band(level, slice, { top: rows[i]!.top + 6, height: rows[i]!.height - 12 })}
                  className="fill-line-strong"
                  opacity={0.35}
                />
              ));
            })}
          </svg>
          {columns.map((nodes, level) =>
            nodes.map((node, i) => (
              <NodeBox
                key={node.key}
                node={node}
                sized={sized}
                chosen={chosen[level]?.key === node.key}
                onChoose={() => choose(level, node.key)}
                style={{ position: "absolute", left: `${left(level)}%`, width: `${COLUMN}%`, top: boxes[level]![i]!.top, height: boxes[level]![i]!.height }}
              />
            )),
          )}
          <div
            className="absolute rounded-xl border border-line bg-surface"
            style={{ left: `${left(depth)}%`, width: `${100 - left(depth)}%`, top: 0, height: pulls.length * rowHeight || MIN_BOX }}
          >
            {pulls.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">
                {direct > 0 ? `No pull requests: ${dollars(direct)} of agent sessions pushed straight to a branch, or opened none.` : "No pull requests here."}
              </p>
            ) : (
              pulls.map((pull, i) => <PullRow key={pull.key} pull={pull} style={{ height: rows[i]!.height }} />)
            )}
          </div>
        </div>
      </div>
      {/* A phone: each level as a list, the chosen one open. */}
      <div className="space-y-5 md:hidden">
        {columns.map((nodes, level) => (
          <div key={level} className="space-y-2">
            <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted uppercase">{heads[level]}</p>
            <div className="grid gap-2">
              {nodes.map((node) => (
                <NodeBox key={node.key} node={node} sized={sized} chosen={chosen[level]?.key === node.key} onChoose={() => choose(level, node.key)} />
              ))}
            </div>
          </div>
        ))}
        <div className="space-y-2">
          <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted uppercase">{heads[depth]}</p>
          <div className="rounded-xl border border-line bg-surface">
            {pulls.map((pull) => (
              <PullRow key={pull.key} pull={pull} style={{ height: 48 }} />
            ))}
            {pulls.length === 0 && direct > 0 && (
              <p className="px-3 py-4 text-sm text-muted">No pull requests: {dollars(direct)} of agent sessions pushed straight to a branch, or opened none.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
