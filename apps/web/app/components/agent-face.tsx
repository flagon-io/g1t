import { type CSSProperties, useId } from "react";

import type { AgentLook, AgentSessionStatus, AgentStatus, FaceColor, FaceShape } from "@g1t/contracts";
import { lookFromSeed } from "@g1t/contracts/agent-look";

import { cn } from "../lib/cn";

/**
 * An agent's face (docs.g1t.sh/guides/agents/, "Its face"): a small bot
 * drawn as SVG from its `look`, seven choices its owner makes, or from its
 * `avatar_seed` when it has chosen none. The same look draws the same face
 * at every size, from 16 px in a list to 128 px on a profile; at 20 px and
 * under the fine details (accessory, pattern, highlights) are left off so
 * what is left reads.
 *
 * It is alive but calm: it blinks every few seconds, at a moment and a
 * pace of its own so a row of faces never blinks in unison, and breathes
 * a little. Its `state` says what the agent is doing: `working` narrows
 * its eyes and pulses softly, `asleep` closes them (with a small z above
 * 40 px), `happy` is a brief grin and a bounce when work finished well.
 * Everything moves with CSS transforms and opacity alone (app.css, "An
 * agent's face"), and prefers-reduced-motion stops all of it: the face is
 * then still, with the eyes a state would have.
 */
export type FaceState = "idle" | "working" | "asleep" | "happy";

/** The face an agent's status calls for, where a list shows its status on its face. */
export function faceStateOf(status: AgentStatus | null | undefined): FaceState {
  if (status === "working") return "working";
  if (status === "paused" || status === "out_of_budget") return "asleep";
  return "idle";
}

/** The face beside a session: at work while it runs, happy once it finished well. */
export function sessionFaceOf(status: AgentSessionStatus | null | undefined): FaceState {
  if (status === "working" || status === "queued") return "working";
  if (status === "done") return "happy";
  return "idle";
}

/**
 * Each colour as it reads on the dark theme and the light one: a pastel
 * body on near-black, a step deeper on white, so the ink of the eyes and
 * mouth holds at least 7:1 on either.
 */
const COLORS: Record<FaceColor, { dark: string; light: string }> = {
  lavender: { dark: "#b6a8ff", light: "#a494f2" },
  mint: { dark: "#86efc4", light: "#5fd3a6" },
  peach: { dark: "#ffbd8c", light: "#f5a872" },
  sky: { dark: "#8ab4ff", light: "#709ff0" },
  pink: { dark: "#ff9ecf", light: "#f088bf" },
  lemon: { dark: "#f2dc72", light: "#e5c94f" },
  teal: { dark: "#7fe3e0", light: "#58cbc8" },
  coral: { dark: "#ff8f85", light: "#f27a70" },
  moss: { dark: "#b9d97a", light: "#9dc25a" },
  slate: { dark: "#a9b4c6", light: "#8d9ab0" },
};

/** The colours' names as the Face editor says them. */
export const FACE_COLOR_LABELS: Record<FaceColor, string> = {
  lavender: "Lavender",
  mint: "Mint",
  peach: "Peach",
  sky: "Sky",
  pink: "Pink",
  lemon: "Lemon",
  teal: "Teal",
  coral: "Coral",
  moss: "Moss",
  slate: "Slate",
};

/** A colour's swatch, for the editor: the dark theme's body on dark, the light one's on light. */
export function faceColorCss(color: FaceColor): string {
  const c = COLORS[color];
  return `light-dark(${c.light}, ${c.dark})`;
}

/** Where each head shape's top is, for the antenna and the hat to sit on. */
const TOP: Record<FaceShape, number> = { round: 14, square: 16, squircle: 14, blob: 14, hex: 12 };

type HeadProps = { className?: string; fill?: string; stroke?: string; strokeWidth?: number };

/** The head, in a 100×100 box, leaving room above for an antenna. */
function Head({ shape, ...p }: { shape: FaceShape } & HeadProps) {
  switch (shape) {
    case "round":
      return <circle cx={50} cy={54} r={40} {...p} />;
    case "square":
      return <rect x={12} y={16} width={76} height={76} rx={14} {...p} />;
    case "squircle":
      return <rect x={10} y={14} width={80} height={80} rx={30} {...p} />;
    case "blob":
      return <path d="M50 14 C 72 12, 92 28, 90 52 C 88 78, 70 94, 48 92 C 24 90, 8 74, 10 50 C 12 28, 30 16, 50 14 Z" {...p} />;
    case "hex":
      return <polygon points="50,12 86,32 86,76 50,96 14,76 14,32" strokeLinejoin="round" {...p} />;
  }
}

/** FNV-1a, 32 bits: the seed as a number, for a blink of its own. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function AgentFace({
  look,
  seed = "agent",
  size = 20,
  state = "idle",
  className,
}: {
  /** The face to draw; left out, the seed's. */
  look?: AgentLook | null;
  /** What the face is drawn from when there is no look, and what times its blink. */
  seed?: string;
  size?: number;
  state?: FaceState;
  className?: string;
}) {
  const face = look ?? lookFromSeed(seed);
  const id = useId();
  const tiny = size <= 20;
  const small = size <= 32;
  // Strokes in the 100-box: thicker as the face gets smaller, so a mouth is a mouth at 16 px.
  const sw = tiny ? 9 : small ? 7 : 5.5;
  const colour = COLORS[face.color];
  const h = hash(seed || "agent");
  // Blinks 3.6 to 6.8 s apart, starting anywhere in the cycle; breathing on its own beat too.
  const blinkPeriod = (3600 + (h % 3200)) / 1000;
  const blinkDelay = -(((h >>> 8) % 6000) / 1000);
  const bobDelay = -(((h >>> 16) % 4000) / 1000);
  const happy = state === "happy";
  const asleep = state === "asleep";
  const eyes = happy ? "happy" : face.eyes;
  const mouth = happy ? "grin" : face.mouth;
  const top = TOP[face.shape];
  const clip = `${id}-clip`;
  const sheen = `${id}-sheen`;
  const style = {
    "--face-body": `light-dark(${colour.light}, ${colour.dark})`,
    "--face-blink-period": `${blinkPeriod}s`,
    "--face-blink-delay": `${blinkDelay}s`,
    "--face-bob-delay": `${bobDelay}s`,
  } as CSSProperties;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      data-state={state}
      data-size={tiny ? "tiny" : small ? "small" : "full"}
      className={cn("agent-face shrink-0 overflow-visible", className)}
      style={style}
    >
      <defs>
        <clipPath id={clip}>
          <Head shape={face.shape} />
        </clipPath>
        {face.pattern === "gradient" && !tiny && (
          <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      <g className="face-bob">
        {/* The antenna, behind the head. */}
        {face.antenna === "single" && (
          <g className="face-antenna" stroke="var(--face-ink-out)" strokeWidth={sw * 0.8} strokeLinecap="round">
            <line x1={50} y1={top} x2={50} y2={7} />
            <circle cx={50} cy={6} r={tiny ? 5.5 : 4.5} fill="var(--face-ink-out)" stroke="none" />
          </g>
        )}
        {face.antenna === "double" && (
          <g className="face-antenna" stroke="var(--face-ink-out)" strokeWidth={sw * 0.8} strokeLinecap="round">
            <line x1={38} y1={top + 1} x2={31} y2={6} />
            <line x1={62} y1={top + 1} x2={69} y2={6} />
            <circle cx={30} cy={5} r={tiny ? 5.5 : 4.5} fill="var(--face-ink-out)" stroke="none" />
            <circle cx={70} cy={5} r={tiny ? 5.5 : 4.5} fill="var(--face-ink-out)" stroke="none" />
          </g>
        )}
        {face.antenna === "bulb" && (
          <g className="face-antenna">
            <line x1={50} y1={top} x2={50} y2={10} stroke="var(--face-ink-out)" strokeWidth={sw * 0.8} strokeLinecap="round" />
            <circle className="face-bulb" cx={50} cy={7.5} r={tiny ? 7 : 6.5} fill="var(--face-glow)" stroke="var(--face-ink-out)" strokeWidth={tiny ? 0 : 2.5} />
          </g>
        )}
        {/* The head: its colour, its pattern, its rim; and the glow a working face pulses. */}
        <Head shape={face.shape} className="face-glow" fill="none" stroke="var(--face-glow)" strokeWidth={10} />
        <Head shape={face.shape} fill="var(--face-body)" />
        {!tiny && face.pattern === "stripe" && (
          <g clipPath={`url(#${clip})`} fill="var(--face-ink)" opacity={0.12}>
            <polygon points="0,100 100,0 100,16 16,100" />
            <polygon points="0,78 78,0 90,0 0,90" />
          </g>
        )}
        {!tiny && face.pattern === "dots" && (
          <g clipPath={`url(#${clip})`} fill="var(--face-ink)" opacity={0.14}>
            {[
              [20, 28],
              [36, 20],
              [54, 18],
              [72, 24],
              [84, 40],
              [18, 70],
              [26, 86],
              [50, 90],
              [74, 86],
              [86, 70],
            ].map(([x, y]) => (
              <circle key={`${x}:${y}`} cx={x} cy={y} r={4} />
            ))}
          </g>
        )}
        {!tiny && face.pattern === "gradient" && <Head shape={face.shape} fill={`url(#${sheen})`} />}
        <Head shape={face.shape} fill="none" stroke="var(--face-rim)" strokeWidth={tiny ? 4 : 3} />

        {/* Eyes, which blink, narrow when working and close asleep. */}
        <g className="face-eyes">
          {eyes === "dots" && (
            <g fill="var(--face-ink)">
              <circle cx={36} cy={50} r={tiny ? 7 : 5.5} />
              <circle cx={64} cy={50} r={tiny ? 7 : 5.5} />
            </g>
          )}
          {eyes === "round" && (
            <g>
              <circle cx={36} cy={50} r={9} fill="var(--face-ink)" />
              <circle cx={64} cy={50} r={9} fill="var(--face-ink)" />
              {!tiny && (
                <g className="face-shine" fill="var(--face-light)">
                  <circle cx={39} cy={47} r={3} />
                  <circle cx={67} cy={47} r={3} />
                </g>
              )}
            </g>
          )}
          {eyes === "wide" && (
            <g>
              <circle cx={36} cy={50} r={12} fill="var(--face-light)" />
              <circle cx={64} cy={50} r={12} fill="var(--face-light)" />
              <g className="face-pupils" fill="var(--face-ink)">
                <circle cx={37} cy={51} r={6.5} />
                <circle cx={65} cy={51} r={6.5} />
              </g>
              {!tiny && (
                <g className="face-shine" fill="var(--face-light)">
                  <circle cx={39.5} cy={48.5} r={2.2} />
                  <circle cx={67.5} cy={48.5} r={2.2} />
                </g>
              )}
            </g>
          )}
          {eyes === "happy" && (
            <g fill="none" stroke="var(--face-ink)" strokeWidth={sw} strokeLinecap="round">
              <path d="M27 54 Q36 42 45 54" />
              <path d="M55 54 Q64 42 73 54" />
            </g>
          )}
          {eyes === "visor" && (
            <g>
              <rect x={21} y={41} width={58} height={18} rx={9} fill="var(--face-ink)" />
              <g className="face-pupils" fill="var(--face-glow)">
                <circle cx={36} cy={50} r={tiny ? 4.5 : 3.6} />
                <circle cx={64} cy={50} r={tiny ? 4.5 : 3.6} />
              </g>
            </g>
          )}
          {eyes === "sleepy" && (
            <g fill="var(--face-ink)">
              <path d="M27 50 A9 9 0 0 0 45 50 Z" />
              <path d="M55 50 A9 9 0 0 0 73 50 Z" />
            </g>
          )}
        </g>

        {/* The mouth. */}
        {mouth === "smile" && <path d="M40 68 Q50 78 60 68" fill="none" stroke="var(--face-ink)" strokeWidth={sw} strokeLinecap="round" />}
        {mouth === "grin" && (
          <g>
            <path d="M37 66 Q50 84 63 66 Z" fill="var(--face-ink)" />
            {!tiny && <path d="M40 67 Q50 71 60 67 L60 70 Q50 74 40 70 Z" fill="var(--face-light)" />}
          </g>
        )}
        {mouth === "flat" && <line x1={42} y1={70} x2={58} y2={70} stroke="var(--face-ink)" strokeWidth={sw} strokeLinecap="round" />}
        {mouth === "open" && <ellipse cx={50} cy={70} rx={tiny ? 7 : 6} ry={tiny ? 8 : 7} fill="var(--face-ink)" />}

        {/* Accessories, over everything; left off at 20 px and under. */}
        {!tiny && face.accessory === "glasses" && (
          <g fill="none" stroke="var(--face-ink)" strokeWidth={3.5} strokeLinecap="round">
            <circle cx={36} cy={50} r={14} />
            <circle cx={64} cy={50} r={14} />
            <line x1={50} y1={49} x2={50} y2={49} strokeWidth={5} />
            <line x1={20} y1={46} x2={14} y2={43} />
            <line x1={80} y1={46} x2={86} y2={43} />
          </g>
        )}
        {!tiny && face.accessory === "headphones" && (
          <g>
            <path d={`M 14 56 A 36 36 0 0 1 86 56`} fill="none" stroke="var(--face-ink-out)" strokeWidth={5} strokeLinecap="round" />
            <rect x={6} y={48} width={14} height={22} rx={5} fill="var(--face-ink-out)" />
            <rect x={80} y={48} width={14} height={22} rx={5} fill="var(--face-ink-out)" />
          </g>
        )}
        {!tiny && face.accessory === "bow" && (
          <g fill="var(--face-ribbon)" stroke="var(--face-ink-out)" strokeWidth={2} strokeLinejoin="round">
            <path d={`M74 ${top + 6} L60 ${top - 2} L62 ${top + 14} Z`} />
            <path d={`M74 ${top + 6} L88 ${top - 2} L86 ${top + 14} Z`} />
            <circle cx={74} cy={top + 6} r={4} />
          </g>
        )}
        {!tiny && face.accessory === "hat" && (
          <g fill="var(--face-ink-out)">
            <rect x={30} y={top - 13} width={40} height={16} rx={5} />
            <rect x={23} y={top - 2} width={54} height={5.5} rx={2.75} />
            <rect x={30} y={top - 6} width={40} height={3} fill="var(--face-ribbon)" />
          </g>
        )}
        {!tiny && face.accessory === "spark" && (
          <path className="face-spark" d={`M84 ${top - 8} L87 ${top - 1} L94 ${top + 2} L87 ${top + 5} L84 ${top + 12} L81 ${top + 5} L74 ${top + 2} L81 ${top - 1} Z`} fill="var(--face-spark)" />
        )}

        {/* Asleep: a z or two, above 40 px. */}
        {asleep && size >= 40 && (
          <g className="face-zz" fill="var(--face-ink-out)" fontFamily="var(--font-sans)" fontWeight={700}>
            <text x={76} y={28} fontSize={18} className="face-z">
              z
            </text>
            <text x={86} y={16} fontSize={12} className="face-z face-z-2">
              z
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}
