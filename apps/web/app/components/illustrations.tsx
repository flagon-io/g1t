/**
 * Line-art illustrations for the marketing pages. They are plain SVG with
 * SMIL animation, so they render on the server and move without any script.
 */

const LINE = "var(--color-line-strong)";
const FAINT = "var(--color-faint)";
const MUTED = "var(--color-muted)";
const ACCENT = "var(--color-accent)";
const DANGER = "var(--color-danger)";
const SURFACE = "var(--color-surface)";
const RAISED = "var(--color-raised)";

/** A dot that travels along `path` forever. */
function Pulse({
  path,
  dur,
  begin = "0s",
  color = ACCENT,
  r = 3,
}: {
  path: string;
  dur: string;
  begin?: string;
  color?: string;
  r?: number;
}) {
  return (
    <circle r={r} fill={color}>
      <animateMotion path={path} dur={dur} begin={begin} repeatCount="indefinite" />
      <animate
        attributeName="opacity"
        values="0;1;1;0"
        keyTimes="0;0.1;0.85;1"
        dur={dur}
        begin={begin}
        repeatCount="indefinite"
      />
    </circle>
  );
}

const LANES = [
  { y: 60, state: "passed" },
  { y: 135, state: "failed" },
  { y: 210, state: "shipped" },
  { y: 285, state: "passed" },
  { y: 360, state: "working" },
] as const;

/**
 * The hero: one intent fans out to five attempts, each in its own lane;
 * the one that ships lands on main.
 */
export function ArenaIllustration() {
  return (
    <svg
      viewBox="0 0 1000 420"
      fill="none"
      className="w-full"
      role="img"
      aria-label="An intent fans out to five attempts running in parallel; one ships to main."
    >
      {/* Faint grid. */}
      <g stroke={LINE} strokeWidth="1" opacity="0.35">
        {[60, 135, 210, 285, 360].map((y) => (
          <path key={y} d={`M0 ${y}H1000`} strokeDasharray="2 10" />
        ))}
        {[250, 400, 550, 700].map((x) => (
          <path key={x} d={`M${x} 20V400`} strokeDasharray="2 10" />
        ))}
      </g>

      {/* The intent. */}
      <g>
        <rect x="24" y="150" width="170" height="120" rx="12" fill={SURFACE} stroke={LINE} />
        <text x="42" y="178" fill={MUTED} fontSize="11" fontFamily="var(--font-mono)">
          intent #12
        </text>
        <rect x="42" y="190" width="120" height="7" rx="3.5" fill={FAINT} />
        <rect x="42" y="206" width="134" height="5" rx="2.5" fill={LINE} />
        <rect x="42" y="218" width="104" height="5" rx="2.5" fill={LINE} />
        <g fontSize="10" fontFamily="var(--font-mono)" fill={MUTED}>
          <path d="M43 245l3 3 6-6" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" />
          <text x="58" y="250">
            cargo test
          </text>
        </g>
        <circle cx="194" cy="210" r="4" fill={SURFACE} stroke={MUTED} strokeWidth="1.5" />
      </g>

      {LANES.map(({ y, state }, i) => {
        const out = `M194 210C250 210 250 ${y} 310 ${y}`;
        const lane = `M310 ${y}H690`;
        const back = `M690 ${y}C750 ${y} 750 210 806 210`;
        const ships = state === "shipped";
        const failed = state === "failed";
        const working = state === "working";
        const stroke = ships ? ACCENT : failed ? LINE : FAINT;
        const end = working ? 520 : failed ? 480 : 690;
        return (
          <g key={y}>
            <path d={out} stroke={stroke} strokeWidth="1.5" />
            <path
              d={`M310 ${y}H${end}`}
              stroke={stroke}
              strokeWidth="1.5"
              strokeDasharray={failed ? "4 5" : undefined}
            />
            {working && (
              <path
                d={`M${end} ${y}H690`}
                stroke={LINE}
                strokeWidth="1.5"
                strokeDasharray="4 4"
                className="animate-dash"
              />
            )}
            {!failed && !working && (
              <path
                d={back}
                stroke={stroke}
                strokeWidth="1.5"
                strokeDasharray={ships ? undefined : "3 6"}
                opacity={ships ? 1 : 0.5}
              />
            )}

            <text x="310" y={y - 14} fill={ships ? ACCENT : MUTED} fontSize="11" fontFamily="var(--font-mono)">
              attempt {i + 1}
            </text>

            {/* Commits along the lane. */}
            {[350, 410, 470, 560, 630]
              .filter((x) => x <= end)
              .map((x) => (
                <circle
                  key={x}
                  cx={x}
                  cy={y}
                  r="4"
                  fill={SURFACE}
                  stroke={ships ? ACCENT : MUTED}
                  strokeWidth="1.5"
                />
              ))}

            {failed && (
              <path
                d={`M${end + 6} ${y - 5}l10 10m0-10l-10 10`}
                stroke={DANGER}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
            {working && (
              <circle cx={end} cy={y} r="5" fill={ACCENT}>
                <animate attributeName="r" values="4;7;4" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}

            <Pulse
              path={`${out}H${end}`}
              dur={`${3.2 + i * 0.35}s`}
              begin={`${i * 0.5}s`}
              color={ships ? ACCENT : MUTED}
            />
            {ships && <Pulse path={`${lane}${back.replace("M690 " + y, "")}`} dur="2.4s" begin="1.2s" r={3.5} />}
          </g>
        );
      })}

      {/* Main. */}
      <g>
        <circle cx="840" cy="210" r="34" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
        <circle cx="840" cy="210" r="34" stroke={ACCENT} strokeWidth="1.5" opacity="0.5">
          <animate attributeName="r" values="34;50" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0" dur="2.4s" repeatCount="indefinite" />
        </circle>
        <path
          d="M826 210l10 10 18-20"
          stroke={ACCENT}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M874 210H976" stroke={ACCENT} strokeWidth="1.5" />
        <text x="902" y="198" fill={ACCENT} fontSize="12" fontFamily="var(--font-mono)">
          main
        </text>
        {[910, 945].map((x) => (
          <circle key={x} cx={x} cy="210" r="4" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
        ))}
      </g>
    </svg>
  );
}

/** An isometric tile, as a path centred on (cx, cy). */
function tile(cx: number, cy: number, w = 60, h = 30): string {
  return `M${cx} ${cy - h}L${cx + w} ${cy}L${cx} ${cy + h}L${cx - w} ${cy}Z`;
}

/** A brief with acceptance checks ticking off. */
export function IntentIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      <path d="M0 150H320" stroke={LINE} strokeDasharray="2 8" />
      <rect x="70" y="22" width="180" height="136" rx="10" fill={RAISED} stroke={LINE} />
      <rect x="90" y="42" width="96" height="8" rx="4" fill={MUTED} />
      <rect x="90" y="62" width="140" height="5" rx="2.5" fill={LINE} />
      <rect x="90" y="74" width="120" height="5" rx="2.5" fill={LINE} />
      <rect x="90" y="86" width="132" height="5" rx="2.5" fill={LINE} />
      {[110, 128, 146].map((y, i) => (
        <g key={y}>
          <rect x="90" y={y - 7} width="12" height="12" rx="3" stroke={FAINT} />
          <path
            d={`M93 ${y - 1}l2.5 2.5 4.5-5`}
            stroke={ACCENT}
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0"
          >
            <animate
              attributeName="opacity"
              values="0;0;1;1;0"
              keyTimes={`0;${0.15 + i * 0.2};${0.2 + i * 0.2};0.95;1`}
              dur="5s"
              repeatCount="indefinite"
            />
          </path>
          <rect x="110" y={y - 3} width={90 - i * 14} height="5" rx="2.5" fill={FAINT} />
        </g>
      ))}
    </svg>
  );
}

/** One repository lifting into a stack of separate copies. */
export function ForkIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      <path d="M40 150L160 90L280 150" stroke={LINE} strokeDasharray="2 8" />
      <path d={tile(160, 138)} fill={RAISED} stroke={MUTED} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <path
            d={tile(160, 138)}
            fill={SURFACE}
            stroke={i === 1 ? ACCENT : FAINT}
            opacity="0"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values={`0 0;${(i - 1) * 84} ${-58 - (i === 1 ? 22 : 0)};${(i - 1) * 84} ${-58 - (i === 1 ? 22 : 0)};0 0`}
              keyTimes="0;0.3;0.85;1"
              dur="5s"
              begin={`${i * 0.15}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              keyTimes="0;0.15;0.85;1"
              dur="5s"
              begin={`${i * 0.15}s`}
              repeatCount="indefinite"
            />
          </path>
        </g>
      ))}
      <path d="M160 138V168M100 138V160M220 138V160" stroke={LINE} />
    </svg>
  );
}

/** A line of code linked to the reasoning that produced it. */
export function SessionIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      <rect x="20" y="30" width="150" height="120" rx="10" fill={RAISED} stroke={LINE} />
      {[52, 68, 84, 100, 116, 132].map((y, i) => (
        <g key={y}>
          <rect x="34" y={y - 3} width="8" height="5" rx="2" fill={LINE} />
          <rect
            x="50"
            y={y - 3}
            width={[80, 104, 64, 96, 72, 88][i]}
            height="5"
            rx="2.5"
            fill={i === 3 ? ACCENT : FAINT}
            opacity={i === 3 ? 0.9 : 0.6}
          />
        </g>
      ))}
      <rect x="28" y="92" width="134" height="16" rx="4" stroke={ACCENT} opacity="0.5" />
      <path d="M162 100H196" stroke={ACCENT} strokeDasharray="3 4" className="animate-dash" />
      <rect x="196" y="58" width="108" height="84" rx="10" fill={SURFACE} stroke={ACCENT} strokeOpacity="0.6" />
      <circle cx="212" cy="76" r="5" fill={ACCENT} />
      <rect x="224" y="73" width="52" height="5" rx="2.5" fill={MUTED} />
      <rect x="208" y="92" width="84" height="5" rx="2.5" fill={FAINT} />
      <rect x="208" y="104" width="70" height="5" rx="2.5" fill={FAINT} />
      <rect x="208" y="116" width="78" height="5" rx="2.5" fill={FAINT} />
    </svg>
  );
}

/** Any agent, anywhere, joining through one endpoint. */
export function AgentsIllustration() {
  const spokes = [
    { x: 50, y: 40 },
    { x: 50, y: 140 },
    { x: 270, y: 40 },
    { x: 270, y: 140 },
  ];
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      {spokes.map(({ x, y }, i) => {
        const path = `M${x} ${y}L160 90`;
        return (
          <g key={`${x}-${y}`}>
            <path d={path} stroke={LINE} />
            <rect x={x - 26} y={y - 16} width="52" height="32" rx="6" fill={RAISED} stroke={FAINT} />
            <path d={`M${x - 16} ${y - 4}l5 4-5 4`} stroke={MUTED} strokeWidth="1.5" strokeLinecap="round" />
            <rect x={x - 5} y={y + 2} width="14" height="3" rx="1.5" fill={FAINT} />
            <Pulse path={path} dur="2.4s" begin={`${i * 0.6}s`} />
          </g>
        );
      })}
      <circle cx="160" cy="90" r="26" fill={SURFACE} stroke={ACCENT} />
      <text x="160" y="94" textAnchor="middle" fill={ACCENT} fontSize="11" fontFamily="var(--font-mono)">
        mcp
      </text>
    </svg>
  );
}

/** Every change published once and delivered to each subscriber. */
export function EventsIllustration() {
  const sinks = [50, 90, 130];
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      <path d="M20 90H150" stroke={FAINT} />
      {[0, 1, 2].map((i) => (
        <Pulse key={i} path="M20 90H150" dur="1.8s" begin={`${i * 0.6}s`} color={MUTED} />
      ))}
      <rect x="150" y="68" width="44" height="44" rx="10" fill={RAISED} stroke={ACCENT} />
      <path d="M163 90h18m-6-6l6 6-6 6" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {sinks.map((y, i) => {
        const path = `M194 90C230 90 220 ${y} 256 ${y}`;
        return (
          <g key={y}>
            <path d={path} stroke={LINE} />
            <rect x="256" y={y - 12} width="44" height="24" rx="6" fill={SURFACE} stroke={FAINT} />
            <rect x="266" y={y - 2.5} width="24" height="5" rx="2.5" fill={FAINT} />
            <Pulse path={path} dur="1.8s" begin={`${0.9 + i * 0.3}s`} />
          </g>
        );
      })}
    </svg>
  );
}

/** Attempts queued in order, landing on main one at a time. */
export function ShipIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="w-full" aria-hidden="true">
      <path d="M20 120H300" stroke={ACCENT} strokeWidth="1.5" />
      {[60, 110, 160].map((x) => (
        <circle key={x} cx={x} cy="120" r="4" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
      ))}
      {[0, 1, 2].map((i) => {
        const x = 200 + i * 34;
        return (
          <g key={i}>
            <rect
              x={x - 12}
              y={50 - i * 4}
              width="24"
              height="24"
              rx="6"
              fill={RAISED}
              stroke={i === 0 ? ACCENT : FAINT}
            >
              {i === 0 && (
                <animate attributeName="y" values="50;108;108;50" keyTimes="0;0.4;0.9;1" dur="4s" repeatCount="indefinite" />
              )}
            </rect>
            {i > 0 && <path d={`M${x} ${78 - i * 4}V120`} stroke={LINE} strokeDasharray="2 5" />}
          </g>
        );
      })}
      <text x="20" y="144" fill={MUTED} fontSize="11" fontFamily="var(--font-mono)">
        main
      </text>
    </svg>
  );
}
