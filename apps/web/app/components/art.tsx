/**
 * g1t's artwork: thin isometric line drawings of what it does, on a faint
 * grid, with small dots at the corners. Everything is drawn from one
 * projection so the pieces sit together.
 *
 * The drawings move, and the motion explains the idea: changes stacking
 * in the queue, a line tracing back to why it exists, a deploy reaching
 * the edge. It is CSS only (the `art-*` classes in app.css):
 * transforms, opacity and stroke offsets, which the GPU handles. Each
 * drawing pauses while it is off-screen (`Live`), and under
 * prefers-reduced-motion nothing moves and every drawing shows its
 * finished state.
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { type Point, iso, isoPath, pts, timing } from "../lib/art";

const LINE = "var(--color-fg)";
const MINT = "var(--color-success)";
const LAVENDER = "var(--color-accent)";
const PEACH = "var(--color-warn)";
const DANGER = "var(--color-danger)";

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/**
 * Plays the drawings inside only while they are on screen, so a page of
 * them costs nothing once scrolled past. They hold still until the page
 * has loaded and hydrated, so the first paint is not spent on motion.
 */
export function Live({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPaused(!entry?.isIntersecting), { rootMargin: "80px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} data-live="" data-paused={paused ? "" : undefined}>
      {children}
    </div>
  );
}

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
  className,
  style,
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
  className?: string;
  style?: CSSProperties;
}) {
  const corners = [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)];
  return (
    <g className={className} style={style}>
      <polygon
        points={pts(corners)}
        fill={fill}
        stroke={stroke}
        strokeOpacity={opacity}
        strokeWidth={1}
        strokeDasharray={dash}
        vectorEffect="non-scaling-stroke"
      />
      {dots && corners.map(([cx, cy], index) => <circle key={index} cx={cx} cy={cy} r={1.6} fill={stroke} fillOpacity={Math.min(1, opacity + 0.3)} />)}
    </g>
  );
}

/**
 * A box: its visible edges, and a faint fill on the top face. `glow`
 * paints the top face in a colour that comes and goes on the drawing's
 * loop, starting at `delay`.
 */
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
  glow,
  dur = 8,
  delay = 0,
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
  glow?: string;
  dur?: number;
  delay?: number | string;
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
      {glow && <polygon points={pts(t)} fill={tint(glow, 38)} className="art-lit" style={timing(dur, delay) as CSSProperties} />}
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
  points: Point[];
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

/**
 * Something travelling along a track: a short bright stroke that runs from
 * the first point to the last, once per `dur` seconds. Hidden when still.
 */
function Packet({
  points,
  z = 0,
  color = LAVENDER,
  dur = 3,
  delay = 0,
  size = 2.6,
}: {
  points: Point[];
  z?: number;
  color?: string;
  dur?: number;
  delay?: number | string;
  size?: number;
}) {
  return (
    <path
      d={isoPath(points, z)}
      pathLength={100}
      fill="none"
      stroke={color}
      strokeWidth={size}
      strokeLinecap="round"
      className="art-packet"
      style={timing(dur, delay) as CSSProperties}
    />
  );
}

/** The faint floor grid every drawing stands on. */
function Grid({ size, step = 20, opacity = 0.08, from = 0 }: { size: number; step?: number; opacity?: number; from?: number }) {
  const lines: ReactNode[] = [];
  for (let i = from; i <= size; i += step) {
    lines.push(
      <Track
        key={`a${i}`}
        points={[
          [i, from],
          [i, size],
        ]}
        opacity={opacity}
      />,
    );
    lines.push(
      <Track
        key={`b${i}`}
        points={[
          [from, i],
          [size, i],
        ]}
        opacity={opacity}
      />,
    );
  }
  return <g>{lines}</g>;
}

/** A grid that fades out towards its edges, so the drawing floats. */
function FadedGrid({ id, size, step, from = 0, box }: { id: string; size: number; step: number; from?: number; box: [number, number, number, number] }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-fade`} cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-mask`}>
          <rect x={box[0]} y={box[1]} width={box[2]} height={box[3]} fill={`url(#${id}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <Grid size={size} step={step} opacity={0.08} from={from} />
      </g>
    </>
  );
}

function Label({
  x,
  y,
  z = 0,
  children,
  tone = "var(--color-muted)",
  className,
  style,
}: {
  x: number;
  y: number;
  z?: number;
  children: string;
  tone?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [px, py] = iso(x, y, z);
  return (
    <text x={px} y={py} fill={tone} fontSize={9} fontFamily="var(--font-mono)" letterSpacing="0.06em" className={className} style={style}>
      {children}
    </text>
  );
}

/** A label off to the side of a shape, joined to it by a short line. */
function Callout({ at, dx, dy, children, tone = "var(--color-muted)" }: { at: Point; dx: number; dy: number; children: string; tone?: string }) {
  const [x, y] = at;
  const end: Point = [x + dx, y + dy];
  return (
    <g>
      <line x1={x} y1={y} x2={end[0]} y2={end[1]} stroke="var(--color-faint)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <circle cx={x} cy={y} r={1.8} fill="var(--color-faint)" />
      <text
        x={end[0] + (dx >= 0 ? 6 : -6)}
        y={end[1] + 3}
        textAnchor={dx >= 0 ? "start" : "end"}
        fill={tone}
        fontSize={9}
        fontFamily="var(--font-mono)"
        letterSpacing="0.12em"
      >
        {children}
      </text>
    </g>
  );
}

/** A flat, upright chip with words on it, such as an address. */
function Chip({ at, children, tone, dur, delay, width }: { at: Point; children: string; tone: string; dur: number; delay: number | string; width: number }) {
  const [x, y] = at;
  return (
    <g className="art-pop" style={timing(dur, delay) as CSSProperties}>
      <rect
        x={x}
        y={y - 9}
        width={width}
        height={14}
        rx={7}
        fill="var(--color-surface)"
        stroke={tone}
        strokeOpacity={0.55}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x + 8} cy={y - 2} r={2} fill={tone} />
      <text x={x + 14} y={y + 1} fill="var(--color-fg-soft)" fontSize={7.5} fontFamily="var(--font-mono)">
        {children}
      </text>
    </g>
  );
}

/**
 * The merge queue: changes drop onto the stack and are tested together
 * with what is ahead of them; the one that breaks is sent back, and main
 * advances to what passed.
 */
export function QueueArt({ className }: { className?: string }) {
  const D = 7;
  const labels = ["MAIN + #41", "+ #44", "+ #46", "+ #48 ✕"];
  return (
    <svg
      viewBox="-105 -38 240 182"
      className={className}
      role="img"
      aria-label="Pull requests stacking in the merge queue; the failing one goes back and main moves forward"
    >
      <FadedGrid id="queue" size={180} step={20} box={[-105, -38, 240, 182]} />
      <Track
        points={[
          [0, 90],
          [190, 90],
        ]}
        stroke={MINT}
        opacity={0.9}
        width={2}
      />
      {[20, 40, 140, 160].map((x, index) => {
        const [cx, cy] = iso(x, 90);
        return (
          <circle
            key={x}
            cx={cx}
            cy={cy}
            r={2.4}
            fill={MINT}
            fillOpacity={index < 2 ? 0.6 : 1}
            className={index < 2 ? undefined : "art-pop"}
            style={index < 2 ? undefined : (timing(D, `${4.6 + (index - 2) * 0.4}s`) as CSSProperties)}
          />
        );
      })}
      <Packet
        points={[
          [80, 90],
          [190, 90],
        ]}
        color={MINT}
        dur={D}
        delay="4.4s"
        size={3}
      />
      {[0, 1, 2, 3].map((level) => {
        const failed = level === 3;
        const tone = failed ? DANGER : level === 0 ? MINT : LAVENDER;
        const style = timing(D, `${(level * 0.55).toFixed(2)}s`) as CSSProperties;
        return (
          <g key={level} className={failed ? "art-eject" : "art-drop"} style={style}>
            <Plate x={50} y={50} w={60} d={60} z={10 + level * 14} stroke={tone} opacity={0.75 - level * 0.08} />
            <Label x={118} y={52} z={10 + level * 14} tone={failed ? DANGER : level === 0 ? MINT : "var(--color-faint)"}>
              {labels[level]!}
            </Label>
          </g>
        );
      })}
      <Plate
        x={50}
        y={50}
        w={60}
        d={60}
        z={10}
        stroke={MINT}
        opacity={0}
        fill={tint(MINT, 20)}
        dots={false}
        className="art-scan"
        style={timing(D, "3.2s") as CSSProperties}
      />
    </svg>
  );
}

/**
 * Why-blame: a file in layers. One line lights up, and its provenance
 * rises out of it in turn: the commit, the pull request, the work item and
 * the session the coding agent that wrote it recorded.
 */
export function WhyArt({ className }: { className?: string }) {
  const D = 7;
  const layers = ["COMMIT", "PULL REQUEST", "WORK ITEM", "SESSION"];
  return (
    <svg
      viewBox="-112 -36 252 176"
      className={className}
      role="img"
      aria-label="A line in a file tracing back to its commit, pull request, work item and the coding agent's recorded session"
    >
      <FadedGrid id="why" size={170} step={17} box={[-112, -36, 252, 176]} />
      <Plate x={30} y={30} w={90} d={110} stroke={LINE} opacity={0.4} />
      {[45, 58, 71, 97, 110, 123].map((y) => (
        <Track
          key={y}
          points={[
            [40, y],
            [100, y],
          ]}
          opacity={0.3}
        />
      ))}
      <Track
        points={[
          [40, 84],
          [110, 84],
        ]}
        stroke={MINT}
        opacity={0.9}
        width={2}
      />
      <path
        d={isoPath([
          [40, 84],
          [110, 84],
        ])}
        pathLength={100}
        fill="none"
        stroke={MINT}
        strokeWidth={5}
        strokeOpacity={0.25}
        strokeLinecap="round"
        className="art-lit"
        style={timing(D, 0) as CSSProperties}
      />
      {(() => {
        const [x1, y1] = iso(100, 84);
        const [x2, y2] = iso(100, 65, 82);
        return (
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            pathLength={100}
            stroke={LAVENDER}
            strokeOpacity={0.7}
            strokeWidth={1.2}
            strokeDasharray="100"
            className="art-draw"
            style={timing(D, "0.4s") as CSSProperties}
          />
        );
      })()}
      {layers.map((name, level) => {
        const style = timing(D, `${(0.6 + level * 0.6).toFixed(1)}s`) as CSSProperties;
        return (
          <g key={name} className="art-rise" style={style}>
            <Plate
              x={70}
              y={70 - level * 6}
              w={60}
              d={26}
              z={28 + level * 18}
              stroke={level === 3 ? LAVENDER : "var(--color-muted)"}
              opacity={0.6}
              fill="var(--color-bg)"
            />
            <Label x={134} y={70 - level * 6} z={28 + level * 18} tone={level === 3 ? LAVENDER : "var(--color-faint)"}>
              {name}
            </Label>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A deploy reaching the edge: main builds once, goes out to many places
 * at once, and the addresses come up: production, and a preview of each
 * pull request.
 */
export function DeployArt({ className }: { className?: string }) {
  const D = 7;
  const build = { x: 10, y: 70 };
  const sites: Point[] = [
    [110, 10],
    [140, 50],
    [120, 95],
    [165, 120],
    [185, 70],
    [90, 140],
  ];
  return (
    <svg
      viewBox="-150 -62 272 222"
      className={className}
      role="img"
      aria-label="A build going out to many edge locations, with production and preview addresses appearing"
    >
      <FadedGrid id="deploy" size={200} step={20} from={-40} box={[-150, -62, 272, 222]} />
      <Track
        points={[
          [-40, build.y + 8],
          [build.x, build.y + 8],
        ]}
        stroke={MINT}
        opacity={0.9}
        width={2}
      />
      <Packet
        points={[
          [-40, build.y + 8],
          [build.x, build.y + 8],
        ]}
        color={MINT}
        dur={D}
        delay="0s"
        size={3}
      />
      <Callout at={iso(-30, build.y + 8)} dx={-6} dy={18} tone={MINT}>
        MAIN
      </Callout>
      <Box x={build.x} y={build.y} w={16} d={16} h={14} stroke={PEACH} opacity={0.8} glow={PEACH} dur={D} delay="0.5s" />
      {sites.map(([x, y], index) => {
        const path: Point[] = [
          [build.x + 16, build.y + 8],
          [x, y + 5],
        ];
        return (
          <g key={index}>
            <Track points={path} stroke={LINE} opacity={0.14} dash="2 4" />
            <Packet points={path} color={MINT} dur={D} delay={`${(1.4 + index * 0.12).toFixed(2)}s`} size={2.2} />
            <Box x={x} y={y} w={10} d={10} h={4} stroke={MINT} opacity={0.7} glow={MINT} dur={D} delay={`${(2.2 + index * 0.12).toFixed(2)}s`} />
          </g>
        );
      })}
      <Chip at={[-138, -42]} tone={MINT} dur={D} delay="2.8s" width={112}>
        web-acme.g1t.page
      </Chip>
      <Chip at={[-138, -22]} tone={LAVENDER} dur={D} delay="3.3s" width={152}>
        web-git-pr-41-acme.g1t.page
      </Chip>
      <Chip at={[-138, -2]} tone={LAVENDER} dur={D} delay="3.8s" width={152}>
        web-git-pr-44-acme.g1t.page
      </Chip>
    </svg>
  );
}
