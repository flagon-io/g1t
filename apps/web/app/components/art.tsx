/**
 * g1t's artwork: thin isometric line drawings of what it does, on a faint
 * grid, with small dots at the corners. Everything is drawn from one
 * projection so the pieces sit together.
 */
import type { ReactNode } from "react";

/** Isometric projection: x runs down-right, y down-left, z up. */
const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
function iso(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * COS, (x + y) * SIN - z];
}
function pts(points: [number, number][]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

const LINE = "var(--color-fg)";

/** A flat rectangle on the floor (or at height `z`). */
function Plate({
  x,
  y,
  w,
  d,
  z = 0,
  stroke = LINE,
  opacity = 0.45,
  fill = "none",
  dots = true,
  dash,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  z?: number;
  stroke?: string;
  opacity?: number;
  fill?: string;
  dots?: boolean;
  dash?: string;
}) {
  const corners = [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)];
  return (
    <g>
      <polygon
        points={pts(corners)}
        fill={fill}
        stroke={stroke}
        strokeOpacity={opacity}
        strokeWidth={1}
        strokeDasharray={dash}
        vectorEffect="non-scaling-stroke"
      />
      {dots &&
        corners.map(([cx, cy], index) => (
          <circle key={index} cx={cx} cy={cy} r={1.6} fill={stroke} fillOpacity={Math.min(1, opacity + 0.3)} />
        ))}
    </g>
  );
}

/** A box: its visible edges, and a faint fill on the top face. */
function Box({
  x,
  y,
  z = 0,
  w,
  d,
  h,
  stroke = LINE,
  opacity = 0.6,
  top,
}: {
  x: number;
  y: number;
  z?: number;
  w: number;
  d: number;
  h: number;
  stroke?: string;
  opacity?: number;
  top?: string;
}) {
  const b = [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)];
  const t = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)];
  const common = {
    stroke,
    strokeOpacity: opacity,
    strokeWidth: 1,
    vectorEffect: "non-scaling-stroke" as const,
  };
  return (
    <g>
      <polygon points={pts([b[1]!, b[2]!, t[2]!, t[1]!])} fill="var(--color-bg)" {...common} />
      <polygon points={pts([b[2]!, b[3]!, t[3]!, t[2]!])} fill="var(--color-bg)" {...common} />
      <polygon points={pts(t)} fill={top ?? "var(--color-surface)"} {...common} />
      {t.map(([cx, cy], index) => (
        <circle key={index} cx={cx} cy={cy} r={1.4} fill={stroke} fillOpacity={opacity} />
      ))}
    </g>
  );
}

/** A path along the floor through `points`, given in floor coordinates. */
function Track({
  points,
  z = 0,
  stroke = LINE,
  opacity = 0.5,
  width = 1,
  dash,
  flow,
}: {
  points: [number, number][];
  z?: number;
  stroke?: string;
  opacity?: number;
  width?: number;
  dash?: string;
  /** Animate the dashes along the track. */
  flow?: boolean;
}) {
  return (
    <polyline
      points={pts(points.map(([x, y]) => iso(x, y, z)))}
      fill="none"
      stroke={stroke}
      strokeOpacity={opacity}
      strokeWidth={width}
      strokeDasharray={dash}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      className={flow ? "art-flow" : undefined}
    />
  );
}

/** The faint floor grid every drawing stands on. */
function Grid({ size, step = 20, opacity = 0.08 }: { size: number; step?: number; opacity?: number }) {
  const lines: ReactNode[] = [];
  for (let i = 0; i <= size; i += step) {
    lines.push(<Track key={`a${i}`} points={[[i, 0], [i, size]]} opacity={opacity} />);
    lines.push(<Track key={`b${i}`} points={[[0, i], [size, i]]} opacity={opacity} />);
  }
  return <g>{lines}</g>;
}

function Label({ x, y, z = 0, children, tone = "var(--color-muted)" }: { x: number; y: number; z?: number; children: string; tone?: string }) {
  const [px, py] = iso(x, y, z);
  return (
    <text x={px} y={py} fill={tone} fontSize={9} fontFamily="var(--font-mono)" letterSpacing="0.06em">
      {children}
    </text>
  );
}

const MINT = "var(--color-accent)";
const LAVENDER = "var(--color-merged)";
const PEACH = "var(--color-warn)";

/**
 * The hero: lanes of agents at work, each on its own track, converging
 * through the queue into one main line that only moves forward.
 */
export function ConvergeArt({ className }: { className?: string }) {
  const lanes = [20, 60, 100, 140, 180];
  return (
    <svg viewBox="-260 -70 560 300" className={className} role="img" aria-label="Agents on parallel lanes converging into main">
      <Grid size={300} />
      {/* The lanes, each with an agent at work. */}
      {lanes.map((y, index) => (
        <g key={y}>
          <Plate x={0} y={y - 8} w={150} d={16} opacity={0.22} dots={false} />
          <Track
            points={[[0, y], [150, y], [205, 100]]}
            stroke={index === 2 ? MINT : LAVENDER}
            opacity={0.65}
            dash="3 5"
            flow
          />
          <Box x={30 + ((index * 37) % 80)} y={y - 6} w={12} d={12} h={10} stroke={LAVENDER} opacity={0.8} />
        </g>
      ))}
      {/* The queue: combinations stacked and checked before they land. */}
      {[0, 1, 2].map((level) => (
        <Plate key={level} x={200} y={84} w={34} d={32} z={level * 9} stroke={PEACH} opacity={0.55 - level * 0.12} />
      ))}
      <Label x={196} y={124} tone="var(--color-faint)">QUEUE</Label>
      {/* Main: one line, only forward. */}
      <Track points={[[234, 100], [300, 100]]} stroke={MINT} opacity={0.95} width={2} />
      {[248, 266, 284].map((x) => {
        const [cx, cy] = iso(x, 100);
        return <circle key={x} cx={cx} cy={cy} r={3} fill={MINT} />;
      })}
      {(() => {
        const [cx, cy] = iso(300, 100);
        return (
          <g>
            <circle cx={cx} cy={cy} r={11} fill={MINT} fillOpacity={0.12} />
            <circle cx={cx} cy={cy} r={5} fill={MINT} />
          </g>
        );
      })()}
      <Label x={270} y={112} tone={MINT}>MAIN</Label>
      <Label x={-2} y={8} tone="var(--color-faint)">AGENTS</Label>
    </svg>
  );
}

/** An outcome split into a plan: a brief, then issues with dependencies. */
export function PlanArt({ className }: { className?: string }) {
  const nodes: [number, number, number][] = [
    [40, 20, 0],
    [40, 70, 0],
    [40, 120, 0],
    [110, 45, 1],
    [110, 105, 1],
    [175, 75, 2],
  ];
  const edges: [number, number][] = [
    [0, 3],
    [1, 3],
    [1, 4],
    [2, 4],
    [3, 5],
    [4, 5],
  ];
  return (
    <svg viewBox="-170 -40 330 210" className={className} aria-hidden="true">
      <Grid size={200} opacity={0.06} />
      <Plate x={-30} y={50} w={40} d={50} z={0} stroke={PEACH} opacity={0.6} />
      <Label x={-30} y={110} tone="var(--color-faint)">BRIEF</Label>
      {[0, 1, 2].map((index) => (
        <Track key={index} points={[[10, 75], [40, nodes[index]![1]]]} stroke={PEACH} opacity={0.35} dash="2 4" />
      ))}
      {edges.map(([from, to]) => (
        <Track
          key={`${from}-${to}`}
          points={[
            [nodes[from]![0] + 10, nodes[from]![1] + 5],
            [nodes[to]![0], nodes[to]![1] + 5],
          ]}
          stroke={LAVENDER}
          opacity={0.55}
        />
      ))}
      {nodes.map(([x, y, level], index) => (
        <Box key={index} x={x} y={y} w={10} d={10} h={6 + level * 3} stroke={level === 2 ? MINT : LAVENDER} opacity={0.8} />
      ))}
    </svg>
  );
}

/** Agents aware of each other: boxes linked, one opening an issue for another. */
export function TeamArt({ className }: { className?: string }) {
  const agents: [number, number][] = [
    [30, 30],
    [110, 20],
    [70, 100],
    [150, 90],
  ];
  return (
    <svg viewBox="-150 -40 300 200" className={className} aria-hidden="true">
      <Grid size={180} opacity={0.06} />
      {agents.map(([x, y], i) =>
        agents.slice(i + 1).map(([x2, y2], j) => (
          <Track key={`${i}-${j}`} points={[[x + 6, y + 6], [x2 + 6, y2 + 6]]} stroke={LAVENDER} opacity={0.3} dash="2 4" flow />
        )),
      )}
      {agents.map(([x, y], index) => (
        <Box key={index} x={x} y={y} w={14} d={14} h={14} stroke={LAVENDER} opacity={0.85} />
      ))}
      {/* A note passed between two of them. */}
      <Plate x={92} y={58} w={16} d={12} z={22} stroke={MINT} opacity={0.8} />
      <Track points={[[100, 64], [100, 64]]} />
    </svg>
  );
}

/** The queue: combinations stacked and tested, one passing into main. */
export function QueueArt({ className }: { className?: string }) {
  return (
    <svg viewBox="-150 -60 300 200" className={className} aria-hidden="true">
      <Grid size={180} opacity={0.06} />
      <Track points={[[0, 90], [190, 90]]} stroke={MINT} opacity={0.9} width={2} />
      {[0, 1, 2, 3].map((level) => (
        <Plate
          key={level}
          x={50}
          y={50}
          w={60}
          d={60}
          z={10 + level * 14}
          stroke={level === 3 ? "var(--color-danger)" : level === 0 ? MINT : LAVENDER}
          opacity={0.75 - level * 0.08}
        />
      ))}
      <Label x={118} y={52} z={10} tone={MINT}>MAIN + #41</Label>
      <Label x={118} y={52} z={24} tone="var(--color-faint)">+ #44</Label>
      <Label x={118} y={52} z={38} tone="var(--color-faint)">+ #46</Label>
      <Label x={118} y={52} z={52} tone="var(--color-danger)">+ #48 ✕</Label>
    </svg>
  );
}

/** Why-blame: a file in layers, one line lifted to show where it came from. */
export function WhyArt({ className }: { className?: string }) {
  return (
    <svg viewBox="-140 -50 280 190" className={className} aria-hidden="true">
      <Grid size={170} opacity={0.06} />
      <Plate x={30} y={30} w={90} d={110} stroke={LINE} opacity={0.4} />
      {[45, 58, 71, 97, 110, 123].map((y) => (
        <Track key={y} points={[[40, y], [100, y]]} opacity={0.3} />
      ))}
      <Track points={[[40, 84], [110, 84]]} stroke={MINT} opacity={0.9} width={2} />
      {/* Lifted: the commit, the pull request, the session. */}
      {[0, 1, 2].map((level) => (
        <Plate
          key={level}
          x={70}
          y={70 - level * 6}
          w={60}
          d={26}
          z={28 + level * 18}
          stroke={level === 2 ? LAVENDER : "var(--color-muted)"}
          opacity={0.6}
        />
      ))}
      <Track points={[[100, 84], [100, 84]]} />
    </svg>
  );
}
