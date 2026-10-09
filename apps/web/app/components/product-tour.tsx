/**
 * The landing page's product tour: g1t browsing itself. A faithful app
 * frame (rail, sidebars, the real colours) plays one story on a loop, with
 * a soft cursor that moves and clicks: the pull request going green and
 * merging, the request in #web it came from and the ship note, the agent's
 * sessions, the docs page.
 *
 * The frame is a pure function of time (lib/tour.ts). One rAF loop drives
 * the clock and re-renders only when the frame changes; the step pills'
 * progress bars are written straight to the DOM. The server renders t = 0
 * and the clock starts after mount, so there is no hydration mismatch.
 * Motion is transforms and opacity only. Reduced motion gets a still frame
 * per step, chosen with the pills.
 *
 * It is an honest miniature of the app: the same rail (the workspace on
 * the top bar's line, then Home, Code, Chat, Docs, Agents and the Inbox,
 * with names), each mode's sidebar with its real sections and words, the
 * same top bar (where you are, Explore, Docs, Ask g1t, the inbox and +),
 * which Chat gives up to the conversation's own header as the app does,
 * and the app's own cards. Parts of the story are not built yet (g1t
 * splitting a request between colleagues, and Docs); the line under the
 * frame says so as they play, and the caption under the steps.
 */
import {
  Activity,
  ArrowRight,
  AtSign,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Box,
  Brain,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDot,
  CircleHelp,
  Code2,
  Compass,
  CornerDownRight,
  FileText,
  GitMerge,
  GitPullRequest,
  Hash,
  House,
  Inbox,
  MessagesSquare,
  Network,
  Paperclip,
  PlayCircle,
  Plus,
  Rocket,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { ASK, CHECKS, type CursorTarget, type Frame, LOOP_MS, PILLS, STEPS, STILLS, type Scene, frameAt, pillAt, pillProgress, sameFrame } from "../lib/tour";
import { AgentAvatar } from "./agent-avatar";
import { G1tMark } from "./orchestrator";
import { Avatar } from "./ui";
import { Badge } from "./ui/badge";

/** The frame's design size; it scales to fit, keeping its aspect. */
const W = 992;
const H = 600;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

type Clock = {
  frame: Frame;
  reduced: boolean;
  /** The pill shown as current. */
  pill: number;
  jump: (index: number) => void;
  hover: (on: boolean) => void;
  /** Observed for being on screen. */
  rootRef: React.RefObject<HTMLDivElement | null>;
  /** The pills' progress bars, written each tick. */
  barRefs: React.RefObject<(HTMLSpanElement | null)[]>;
};

function useTourClock(): Clock {
  const [frame, setFrame] = useState<Frame>(() => frameAt(0));
  const [reduced, setReduced] = useState(false);
  const [still, setStill] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const time = useRef(0);
  const shown = useRef(frame);
  const paused = useRef({ hover: false, offscreen: true, hidden: false });

  const paint = useCallback((t: number) => {
    const next = frameAt(t);
    if (!sameFrame(next, shown.current)) {
      shown.current = next;
      setFrame(next);
    }
    const current = pillAt(t);
    const progress = pillProgress(t);
    barRefs.current.forEach((bar, index) => {
      if (!bar) return;
      const amount = index === current ? progress : 0;
      bar.style.transform = `scaleX(${amount})`;
    });
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) {
      setReduced(true);
      const next = frameAt(STILLS.chat);
      shown.current = next;
      setFrame(next);
      return;
    }
    const root = rootRef.current;
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            paused.current.offscreen = !entry?.isIntersecting;
          });
    if (root && observer) observer.observe(root);
    else paused.current.offscreen = false;
    const visibility = () => {
      paused.current.hidden = document.hidden;
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);

    let last: number | null = null;
    let raf = 0;
    const tick = (now: number) => {
      const { hover, offscreen, hidden } = paused.current;
      // A long gap (a background tab, a debugger) moves time on by one frame, not by the gap.
      if (last !== null && !hover && !offscreen && !hidden) time.current = (time.current + Math.min(now - last, 64)) % LOOP_MS;
      last = now;
      paint(time.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [paint]);

  const jump = useCallback(
    (index: number) => {
      const pill = PILLS[index];
      if (reduced) {
        setStill(index);
        const next = frameAt(STILLS[pill.scene]);
        shown.current = next;
        setFrame(next);
        return;
      }
      time.current = pill.start + 1;
      paint(time.current);
    },
    [paint, reduced],
  );

  const hover = useCallback((on: boolean) => {
    paused.current.hover = on;
  }, []);

  return { frame, reduced, pill: reduced ? still : pillOf(frame), jump, hover, rootRef, barRefs };
}

/** The pill a frame belongs to, from what it shows (the clock's time is not React state). */
function pillOf(frame: Frame): number {
  return Math.max(0, PILLS.findIndex((pill) => pill.scene === frame.scene));
}

/** What the line under the frame says about the moment: working today, or a preview. */
function honesty(frame: Frame): { today: boolean; label: string } {
  if (frame.scene === "docs") return { today: false, label: "Docs works today; an agent updating a page after a merge on its own is coming soon" };
  if (frame.scene === "agents") return { today: true, label: "Sessions work today" };
  if (frame.scene === "code") return { today: true, label: "Works today" };
  if (frame.handoff && !frame.shipped) return { today: false, label: "g1t splitting work between colleagues: coming soon" };
  return { today: true, label: "Works today" };
}

/** The line under the frame: today, or soon. Not part of the app, so it sits outside it. */
function HonestyNote({ frame, className }: { frame: Frame; className?: string }) {
  const note = honesty(frame);
  return (
    <span
      key={note.label}
      className={cn(
        "tour-fade inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
        note.today ? "bg-success/10 text-success ring-success/25" : "bg-raised text-muted ring-line-strong",
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", note.today ? "bg-success" : "bg-faint")} />
      {note.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Small parts                                                         */
/* ------------------------------------------------------------------ */

/** The people in the story; everyone else is an agent. */
const PEOPLE: Record<string, string> = { Priya: "Priya Shah", Dana: "Dana Ruiz", Alex: "Alex Lee" };

/** The agents in the story: a human name, a title, and a pixel creature of their own. */
const AGENTS: Record<string, { title: string; team: string }> = {
  g1t: { title: "Orchestrator", team: "" },
  Otto: { title: "Software Engineer", team: "Engineering" },
  Margo: { title: "QA Engineer", team: "QA" },
  Inky: { title: "Technical Writer", team: "Docs" },
  Sam: { title: "Support Specialist", team: "Customer Support" },
  Dot: { title: "Product Manager", team: "Product" },
  David: { title: "Sales Operations", team: "Sales" },
  Bruno: { title: "Operations Engineer", team: "Operations" },
};

/** A face: an agent's own creature (g1t keeps its pixel 1), or a person's avatar, as the app draws them. */
function Face({ who, size = 28 }: { who: string; size?: number }) {
  if (!PEOPLE[who]) return <AgentAvatar agent={{ handle: who.toLowerCase(), name: who, builtin: who === "g1t" }} size={size} />;
  return <Avatar name={who.toLowerCase()} size={size} />;
}

/** A person's presence, as the app shows it on their avatar: active, or away. */
function PresenceDot({ away, ring = "var(--tour-side)" }: { away?: boolean; ring?: string }) {
  return (
    <span
      className={cn("absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full", away ? "bg-[var(--tour-side)] shadow-[inset_0_0_0_1.5px_var(--color-faint)]" : "bg-success")}
      style={{ boxShadow: `0 0 0 1.5px ${ring}${away ? ", inset 0 0 0 1.5px var(--color-faint)" : ""}` }}
    />
  );
}

/** An agent's status dot, as chat/marks.tsx draws it: working glows green, idle is quiet. */
function AgentDot({ working }: { working: boolean }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full transition-colors duration-500",
        working ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_18%,transparent)]" : "bg-faint/70",
      )}
    />
  );
}

function AgentTag() {
  return <span className="rounded bg-accent/15 px-1 py-px font-mono text-[9px] tracking-wide text-accent uppercase">Agent</span>;
}

/** Text with @mentions, #channels and #numbers picked out, as chat shows them. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9-]+|#[a-z0-9]+)/gi);
  return (
    <>
      {parts.map((part, index) =>
        /^[@#]/.test(part) ? (
          <span key={index} className={part.startsWith("@") ? "rounded bg-accent/15 px-0.5 text-accent" : "text-accent"}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Message({ who, role, time, children, enter }: { who: string; role?: string; time: string; children: ReactNode; enter?: boolean }) {
  const agent = !PEOPLE[who];
  return (
    <div className={cn("flex gap-3 px-5 py-2", enter && "tour-in")}>
      <Face who={who} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <span className="font-semibold text-fg">{PEOPLE[who] ?? who}</span>
          {agent && <AgentTag />}
          {(role ?? AGENTS[who]?.title) && <span className="text-[11px] text-faint">{role ?? AGENTS[who]?.title}</span>}
          <span className="text-[11px] text-faint">{time}</span>
        </p>
        <div className="mt-0.5 space-y-2 text-[13px] leading-[1.55] text-fg-soft">{children}</div>
      </div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="tour-dot size-1.5 rounded-full bg-faint" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

/**
 * The session's card in #web, drawn as chat draws an agent session's card
 * (components/chat/card.tsx, CardBox): it changes in place as the
 * session moves, wherever the story is.
 */
function TaskCard({ frame }: { frame: Frame }) {
  const done = frame.cardMerged;
  const cost = STEPS[frame.steps - 1]?.cost ?? 0;
  return (
    <div className="mt-1.5 flex max-w-[26rem] items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors", done ? "bg-raised text-muted" : "bg-accent/10 text-accent")}>
        <Bot size={16} />
      </span>
      <span className="min-w-0 grow">
        <span className="line-clamp-2 text-[13px] font-medium text-fg">CSV export times out for big accounts</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted tabular-nums">
          @otto · {frame.steps} of {STEPS.length} steps · ${cost.toFixed(2)}
        </span>
      </span>
      <Badge key={done ? "done" : "working"} tone={done ? "success" : "accent"} className="tour-pop mt-0.5">
        {!done && (
          <span aria-hidden="true" className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
        )}
        {done ? "Done" : "Working"}
      </Badge>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The app frame                                                       */
/* ------------------------------------------------------------------ */

/** The rail's modes, in the app's order (components/rail.tsx), with its icons. */
const RAIL: { key: string; icon: ReactNode; label: string; target?: CursorTarget; scene?: Scene; badge?: number }[] = [
  { key: "home", icon: <House size={15} />, label: "Home" },
  { key: "code", icon: <Code2 size={15} />, label: "Code", target: "rail-code", scene: "code" },
  { key: "chat", icon: <MessagesSquare size={15} />, label: "Chat", target: "rail-chat", scene: "chat", badge: 3 },
  { key: "docs", icon: <BookOpen size={15} />, label: "Docs", target: "rail-docs", scene: "docs" },
  { key: "agents", icon: <Sparkles size={15} />, label: "Agents", target: "rail-agents", scene: "agents" },
  { key: "inbox", icon: <Inbox size={15} />, label: "Inbox", badge: 2 },
];

/** One rail item: the square behind its icon, filled for the mode you are in, and its name under it. */
function RailItem({ icon, label, on, target, badge }: { icon: ReactNode; label: string; on: boolean; target?: CursorTarget; badge?: number }) {
  return (
    <span className="flex w-full flex-col items-center gap-[3px] py-0.5">
      <span
        data-tour={target}
        className={cn(
          "relative flex size-7 items-center justify-center rounded-[8px] transition-colors duration-500",
          on ? "bg-[#2c2c33] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "text-muted",
        )}
      >
        {icon}
        {badge ? (
          <span className="absolute -top-1 -right-1.5 min-w-[0.875rem] rounded-full bg-accent px-[3px] text-center text-[8px] leading-[0.875rem] font-bold text-bg tabular-nums ring-[1.5px] ring-[#0b0b0d]">
            {badge}
          </span>
        ) : null}
      </span>
      <span className={cn("text-[9px] leading-none font-medium transition-colors duration-500", on ? "text-fg" : "text-faint")}>{label}</span>
    </span>
  );
}

/**
 * The rail, as the app has it: the workspace on the top bar's line (its
 * switcher), the modes with their names, then the workspace's own pages,
 * help, and you, with the dot that says how others see you.
 */
function Rail({ scene }: { scene: Scene }) {
  return (
    <nav aria-hidden="true" className="flex w-16 shrink-0 flex-col items-center bg-[#0b0b0d] pb-2.5 shadow-[inset_-1px_0_0_var(--color-line)]">
      <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-line bg-bg shadow-[inset_-1px_0_0_var(--color-line)]">
        <Avatar name="acme" size={28} square />
      </div>
      <div className="mt-2.5 flex w-full flex-col items-center gap-1.5 px-1">
        {RAIL.map((item) => (
          <RailItem key={item.key} icon={item.icon} label={item.label} on={item.scene === scene} target={item.target} badge={item.badge} />
        ))}
      </div>
      <div className="mt-auto flex w-full flex-col items-center gap-1.5 px-1">
        <RailItem icon={<Building2 size={15} />} label="Workspace" on={false} />
        <RailItem icon={<CircleHelp size={15} />} label="Help" on={false} />
        <span className="relative mt-1">
          <Avatar name="priya" size={26} />
          <PresenceDot ring="#0b0b0d" />
        </span>
      </div>
    </nav>
  );
}

/**
 * The top bar, as the app has it (components/shell.tsx): where you are,
 * then Explore, Docs, Ask g1t, the inbox and the + menu. Chat has none on
 * a computer: the conversation's header takes its line.
 */
function TopBar({ crumbs }: { crumbs: { label: string; mono?: boolean }[] }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg px-4">
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.label}>
            {index > 0 && <span className="text-line-strong">/</span>}
            <span className={cn("truncate", index === crumbs.length - 1 ? "font-medium text-fg" : "text-muted", crumb.mono && "font-mono text-[12px]")}>{crumb.label}</span>
          </Fragment>
        ))}
      </span>
      <span className="ml-auto flex items-center gap-1 text-[12px]">
        <span className="px-1.5 text-muted">Explore</span>
        <span className="px-1.5 text-muted">Docs</span>
        <span className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-fg/90">
          <G1tMark size={14} />
          Ask g1t
        </span>
        <span className="relative flex size-7 items-center justify-center text-muted">
          <Bell size={14} />
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" />
        </span>
        <span className="mx-1 h-4 w-px bg-line" />
        <span className="flex h-7 items-center gap-0.5 rounded-md border border-line px-1.5 text-fg/90">
          <Plus size={13} />
          <ChevronDown size={11} className="text-muted" />
        </span>
      </span>
    </div>
  );
}

/** A mode's sidebar heading (ModeHeader): on the top bar's line, with what it makes. */
function SideHead({ children, action, soon }: { children: ReactNode; action?: ReactNode; soon?: boolean }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line pr-2 pl-3.5">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        {children}
        {soon && <Soon />}
      </span>
      {action && <span className="flex size-6 items-center justify-center text-faint">{action}</span>}
    </div>
  );
}

/** A section's heading, with its fold, as Chat's sections have it. */
function SideLabel({ children, fold = true }: { children: ReactNode; fold?: boolean }) {
  return (
    <p className="mt-3 mb-0.5 flex items-center gap-1 px-1 text-[10.5px] font-medium text-faint">
      {fold && <ChevronDown size={10} />}
      {children}
    </p>
  );
}

function SideRow({ on, children, bold }: { on?: boolean; children: ReactNode; bold?: boolean }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-[12px]", on ? "bg-raised text-fg" : bold ? "text-fg" : "text-muted", bold && "font-semibold")}>
      {children}
    </div>
  );
}

/** The search at the top of a sidebar. */
function SideSearch({ children, keys }: { children: ReactNode; keys?: boolean }) {
  return (
    <span className="flex h-7 items-center gap-2 rounded-md bg-surface px-2 text-[11px] text-faint ring-1 ring-line">
      <Search size={12} className="shrink-0" />
      <span className="grow truncate">{children}</span>
      {keys && <span className="rounded bg-raised px-1 font-mono text-[9px] text-muted ring-1 ring-line">Ctrl K</span>}
    </span>
  );
}

/* Chat ---------------------------------------------------------------- */

function ChatSide({ frame }: { frame: Frame }) {
  // Otto works from the handoff until the merge; everyone else is idle.
  const ottoBusy = frame.handoff && !frame.merged;
  const margoBusy = frame.consult && !frame.approved;
  // As the app has it: direct messages with people and agents alike, the
  // latest first; then the agents not talked to yet.
  const dms: { who: string; away?: boolean; status?: string; working?: boolean }[] = [
    { who: "g1t" },
    { who: "Dana" },
    { who: "Margo", working: margoBusy },
    { who: "Alex", away: true, status: "🗓️" },
  ];
  const agents: { who: string; working: boolean }[] = [
    { who: "Otto", working: ottoBusy },
    { who: "Inky", working: frame.docUpdated },
    { who: "Sam", working: frame.shipped && !frame.sam },
  ];
  return (
    <>
      <SideHead action={<SquarePen size={14} />}>Chat</SideHead>
      <div className="space-y-2 px-2 pt-2.5">
        <SideSearch>Jump to channel or person</SideSearch>
        <span className="grid grid-cols-3 rounded-md bg-surface p-0.5 text-center text-[10px] font-medium ring-1 ring-line">
          <span className="rounded-[4px] bg-raised py-0.5 text-fg ring-1 ring-line-strong">All</span>
          <span className="py-0.5 text-muted">Unread</span>
          <span className="py-0.5 text-muted">Mentions</span>
        </span>
      </div>
      <div className="px-2">
        <SideLabel>Pinned</SideLabel>
        <SideRow>
          <Hash size={12} className="text-faint" />
          <span className="flex-1">releases</span>
        </SideRow>
        <SideLabel>Channels</SideLabel>
        {["web", "support", "general"].map((name) => (
          <SideRow key={name} on={name === "web"} bold={name === "support"}>
            <Hash size={12} className="text-faint" />
            <span className="flex-1">{name}</span>
            {name === "support" && <span className="min-w-4 rounded-full bg-line-strong px-1 text-center text-[9.5px] font-semibold text-fg">3</span>}
          </SideRow>
        ))}
        <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-faint">
          <Compass size={12} />
          <span className="flex-1">Browse channels</span>
          <span className="text-[10.5px]">3</span>
        </div>
        <SideLabel>Direct messages</SideLabel>
        {dms.map((dm) => {
          const agent = dm.who in AGENTS;
          return (
            <SideRow key={dm.who}>
              <span className="relative flex">
                <Face who={dm.who} size={16} />
                {!agent && <PresenceDot away={dm.away} />}
                {agent && dm.working && <PresenceDot />}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {agent ? dm.who : PEOPLE[dm.who]}
                {agent && <span className="text-faint"> · {dm.who === "g1t" ? "orchestrator" : AGENTS[dm.who].title}</span>}
                {dm.status && <span className="ml-1.5 text-[11px]">{dm.status}</span>}
              </span>
            </SideRow>
          );
        })}
        <SideLabel>Agents</SideLabel>
        {agents.map((agent) => (
          <SideRow key={agent.who}>
            <span className="relative flex">
              <Face who={agent.who} size={16} />
              {agent.working && <PresenceDot />}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {agent.who}
              <span className="text-faint"> · {AGENTS[agent.who].title}</span>
            </span>
          </SideRow>
        ))}
      </div>
    </>
  );
}

function ChatMain({ frame }: { frame: Frame }) {
  const typing = ASK.slice(0, frame.typed);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-5">
        <Hash size={15} className="text-faint" />
        <span className="text-sm font-semibold text-fg">web</span>
        <span aria-hidden="true" className="h-3.5 w-px bg-line" />
        <span className="truncate text-xs text-muted">The web app, its releases and its bugs</span>
        <span className="ml-auto flex -space-x-1.5" aria-hidden="true">
          {["Priya", "g1t", "Otto", "Margo", "Dana"].map((who) => (
            <span key={who} className="rounded-lg ring-2 ring-surface">
              <Face who={who} size={20} />
            </span>
          ))}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)] pb-1">
        <div className="flex items-center gap-3 px-5 pt-1 pb-2 text-[11px] text-faint">
          <span className="h-px flex-1 bg-line" />
          Today
          <span className="h-px flex-1 bg-line" />
        </div>
        <Message who="Priya" time="09:02">
          <p>Morning! Thursday&apos;s release closes Wednesday night, so anything for it needs to land by then.</p>
        </Message>
        <Message who="Dana" time="09:12">
          <p>Two enterprise customers hit the CSV export timeout again this morning. Both have over 100k rows.</p>
        </Message>
        {frame.sent && (
          <Message who="Priya" time="09:15" enter>
            <p>
              <Rich text={ASK} />
            </p>
          </Message>
        )}
        {frame.g1tTyping && (
          <div className="tour-in flex items-center gap-3 px-5 py-2 text-[12px] text-faint">
            <Face who="g1t" size={28} />
            <Dots />
            g1t is typing
          </div>
        )}
        {frame.handoff && (
          <Message who="g1t" time="09:15" enter>
            <p>
              <Rich text="On it. @otto will make the fix and @margo will review it. I'll post here when it ships." />
            </p>
            <TaskCard frame={frame} />
          </Message>
        )}
        {frame.shipped && (
          <Message who="g1t" time="09:41" enter>
            <p>
              <Rich text="Shipped. A 200,000-row export now finishes in about 3 s. @sam, can you let #support know?" />
            </p>
          </Message>
        )}
        {frame.sam && (
          <Message who="Sam" time="09:42" enter>
            <p>
              <Rich text="Done. Told #support, and Dana's two customers can export again." />
            </p>
          </Message>
        )}
      </div>
      <div className="px-5 pt-1 pb-4">
        <div
          data-tour="composer"
          className={cn(
            "flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[13px] ring-1 transition-shadow duration-300",
            frame.typed > 0 ? "ring-accent/50 shadow-[0_0_0_3px_rgb(182_168_255/0.08)]" : "ring-line",
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {frame.typed > 0 ? (
              <span className="text-fg">
                {typing}
                <span className="tour-caret ml-px inline-block h-[14px] w-px translate-y-[2px] bg-accent" />
              </span>
            ) : (
              <span className="text-faint">Message #web</span>
            )}
          </span>
          <AtSign size={15} className="text-faint" />
          <Paperclip size={15} className="text-faint" />
          <span
            data-tour="send"
            className={cn(
              "flex size-7 items-center justify-center rounded-md transition-colors duration-300",
              frame.typed === ASK.length ? "bg-accent text-bg" : "text-faint",
            )}
          >
            <SendHorizontal size={14} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* Agents -------------------------------------------------------------- */

/** The specialists the demo workspace hired, from the role templates, by team (agents-mode.tsx, orgChart). */
const SPECIALISTS: { who: string; working?: boolean }[] = [
  { who: "Otto", working: true },
  { who: "Margo" },
  { who: "Inky" },
  { who: "Sam" },
  { who: "Dot" },
];

/** Agents mode's sidebar, as the app has it: the fleet's pages, g1t, then the specialists by team. */
function AgentsSide({ frame }: { frame: Frame }) {
  const link = (icon: ReactNode, label: string, on = false) => (
    <SideRow on={on}>
      <span className="text-faint">{icon}</span>
      {label}
    </SideRow>
  );
  return (
    <>
      <SideHead action={<Plus size={14} />}>Agents</SideHead>
      <div className="px-2 pt-2.5">
        {link(<Activity size={13} />, "Overview")}
        {link(<Network size={13} />, "Context")}
        {link(<Brain size={13} />, "Memory")}
        <SideLabel fold={false}>Orchestrator</SideLabel>
        <AgentRow who="g1t" line="Orchestrator" />
        <p className="mt-2.5 px-2 text-[10px] leading-snug text-faint">Specialists are colleagues hired into a role. g1t hands them work.</p>
        {SPECIALISTS.map((agent) => {
          const working = agent.who === "Otto" ? !frame.merged : agent.who === "Margo" ? frame.consult && !frame.approved : false;
          return (
            <Fragment key={agent.who}>
              <SideLabel>{AGENTS[agent.who].team} · 1</SideLabel>
              <AgentRow who={agent.who} line={working ? `Working · ${AGENTS[agent.who].title}` : AGENTS[agent.who].title} working={working} on={agent.who === "Otto"} />
            </Fragment>
          );
        })}
        <div className="mt-2 flex h-7 items-center gap-2 rounded-md border border-dashed border-line px-2 text-[12px] text-muted">
          <Plus size={13} />
          New agent
        </div>
      </div>
    </>
  );
}

/** One agent in Agents mode's sidebar: its face and status, name, and what it is doing. */
function AgentRow({ who, line, working = false, on = false }: { who: string; line: string; working?: boolean; on?: boolean }) {
  return (
    <div className={cn("flex h-9 items-center gap-2 rounded-md px-2", on && "bg-raised")}>
      <span className="relative shrink-0">
        <Face who={who} size={20} />
        {who !== "g1t" && (
          <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full ring-[1.5px] ring-[var(--tour-side)]">
            <AgentDot working={working} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12px] font-medium text-fg">{who}</span>
        <span className="block truncate text-[10px] text-faint">{line}</span>
      </span>
    </div>
  );
}

const FILES: { path: string; from: number }[] = [
  { path: "services/export/csv.py", from: 3 },
  { path: "services/export/query.py", from: 3 },
  { path: "tests/test_export.py", from: 4 },
];

/** A colleague brought into the session, in the open: a line anyone can open. */
function Consult({ frame, compact }: { frame: Frame; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[12px] transition-[opacity,transform] duration-500",
        frame.consult ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
    >
      <span className="flex -space-x-1">
        <Face who="Otto" size={18} />
        <Face who="Margo" size={18} />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted">
        <span className="text-fg-soft">Otto brought in Margo</span> · Helper session
        {!compact && <span className="text-faint">: &ldquo;Is 1,000 a safe batch size for the 200k test?&rdquo;</span>}
      </span>
      <CornerDownRight size={13} className="shrink-0 text-faint" />
    </div>
  );
}

/** The quiet tag on parts of the story that are not built yet. */
function Soon() {
  return (
    <span className="shrink-0 rounded-full bg-raised px-1.5 py-0.5 font-mono text-[9px] tracking-wide whitespace-nowrap text-muted uppercase ring-1 ring-line-strong">
      Coming soon
    </span>
  );
}

function AgentsMain({ frame }: { frame: Frame }) {
  const cost = STEPS[frame.steps - 1]?.cost ?? 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 pt-4 pb-3">
        <span className="relative">
          <Face who="Otto" size={36} />
          <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full ring-2 ring-bg">
            <AgentDot working={!frame.merged} />
          </span>
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-fg">
            Otto <AgentTag />
          </p>
          <p className="text-xs text-muted">
            <span className="font-mono">@otto</span> · Software Engineer, Engineering
          </p>
        </div>
        <span className="ml-auto flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-bg">
          <MessagesSquare size={12} />
          Message
        </span>
      </div>
      <div className="flex gap-5 border-b border-line px-5 text-[12px]">
        {["Sessions", "Memory", "Routines", "Spend", "Profile"].map((tab) => (
          <span key={tab} className={cn("py-2", tab === "Sessions" ? "border-b-2 border-accent text-fg" : "text-faint")}>
            {tab}
          </span>
        ))}
      </div>
      <div className="flex-1 space-y-3 overflow-hidden px-5 py-4">
        <div className="rounded-xl border border-line bg-surface">
          <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
                CSV export times out for big accounts
                <span className="inline-flex h-4 items-center rounded-[5px] bg-raised px-1.5 text-[10px] font-medium text-muted ring-1 ring-line ring-inset">Chat</span>
                <Badge key={frame.merged ? "done" : "working"} tone={frame.merged ? "success" : "accent"} className="tour-pop">
                  {frame.merged ? "Done" : "Working"}
                </Badge>
              </p>
              <p className="mt-0.5 text-[11px] text-faint">
                asked by @priya through @g1t · <span className="text-fg-soft">#web</span> · {frame.steps * 3} steps
              </p>
            </div>
            <div className="w-32 text-right">
              <p className="text-[12px] text-fg tabular-nums">
                ${cost.toFixed(2)} <span className="text-faint">of $5.00</span>
              </p>
              <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full origin-left rounded-full bg-accent transition-transform duration-700"
                  style={{ transform: `scaleX(${cost / 5})` }}
                />
              </span>
            </div>
          </div>
          <ol className="space-y-1.5 border-t border-line px-4 py-3">
            {STEPS.map((step, index) => {
              const done = index < frame.steps;
              const now = index === frame.steps;
              return (
                <li key={step.text} className={cn("flex items-center gap-2.5 text-[12.5px] transition-colors duration-300", done ? "text-fg-soft" : now ? "text-fg" : "text-faint")}>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {done ? (
                      <span className="tour-pop flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    ) : now ? (
                      <span className="tour-spin size-3.5 rounded-full border-2 border-accent/25 border-t-accent" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-line-strong" />
                    )}
                  </span>
                  {step.text}
                </li>
              );
            })}
          </ol>
          <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
            <span className="text-[11px] text-faint">Files</span>
            <span className="flex min-h-[20px] flex-1 flex-wrap gap-1.5">
              {FILES.filter((file) => frame.steps >= file.from).map((file) => (
                <span key={file.path} className="tour-pop rounded bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-muted ring-1 ring-line">
                  {file.path}
                </span>
              ))}
            </span>
            <span
              data-tour="task-pull"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-opacity duration-500",
                frame.steps >= STEPS.length ? "bg-accent/15 text-accent opacity-100" : "text-faint opacity-0",
              )}
            >
              <GitPullRequest size={13} />
              Pull request #431
              <ArrowRight size={12} />
            </span>
          </div>
        </div>
        <Consult frame={frame} />
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[12px] text-muted">
          <span className="text-fg-soft">Upgrade the date library across the web app</span>
          <Badge>Queued</Badge>
          <span className="ml-auto text-faint">Routine · Mondays</span>
        </div>
      </div>
    </div>
  );
}

/* Code ---------------------------------------------------------------- */

/** Code's sidebar in a project, as the app has it (shell.tsx, RepoMenu): its pages in the order people use them. */
function CodeSide() {
  const row = (icon: ReactNode, label: string, count?: string, on = false) => (
    <SideRow on={on}>
      <span className="text-faint">{icon}</span>
      <span className="flex-1">{label}</span>
      {count && <span className="text-[10.5px] text-faint">{count}</span>}
    </SideRow>
  );
  return (
    <>
      <SideHead>Code</SideHead>
      <div className="px-2 pt-2.5">
        <SideSearch keys>Search or jump to…</SideSearch>
        <div className="mt-2.5 flex h-7 items-center gap-1 px-1 text-[12px] font-medium text-fg">
          <ChevronLeft size={14} className="text-faint" />
          All projects
        </div>
        <div className="mt-1 flex items-center gap-2 rounded-md px-2 py-1">
          <span className="flex size-5 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
            <Box size={11} />
          </span>
          <span className="font-mono text-[12px]">
            <span className="text-faint">acme/</span>
            <span className="font-semibold text-fg">web</span>
          </span>
        </div>
        <div className="mx-2 my-2 h-px bg-line" />
        {row(<Code2 size={13} />, "Code")}
        {row(<CircleDot size={13} />, "Issues", "12")}
        {row(<GitPullRequest size={13} />, "Pull requests", "3", true)}
        {row(<Bot size={13} />, "Agents")}
        {row(<PlayCircle size={13} />, "Workflows")}
        <div className="mx-2 my-2 h-px bg-line" />
        {row(<Rocket size={13} />, "Deployments")}
        <SideRow>
          <span className="text-faint">
            <Activity size={13} />
          </span>
          <span className="flex-1">Observability</span>
          <span className="rounded-full px-1.5 text-[9px] text-faint ring-1 ring-line">Soon</span>
        </SideRow>
        {row(<ShieldCheck size={13} />, "Security")}
        {row(<BarChart3 size={13} />, "Insights")}
        <div className="mx-2 my-2 h-px bg-line" />
        {row(<Settings size={13} />, "Settings")}
      </div>
    </>
  );
}

const DIFF: { sign: " " | "-" | "+"; text: string }[] = [
  { sign: " ", text: "def export_csv(account, writer):" },
  { sign: "-", text: "    rows = list(rows_for_export(account))" },
  { sign: "-", text: "    for row in rows:" },
  { sign: "-", text: "        writer.writerow(row)" },
  { sign: "+", text: "    for batch in rows_for_export(account, batch_size=1_000):" },
  { sign: "+", text: "        writer.writerows(batch)" },
  { sign: "+", text: "        yield writer.flush()" },
];

function CodeMain({ frame }: { frame: Frame }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-5 pt-4 pb-3">
        <p className="text-[15px] font-semibold text-fg">
          Stream CSV exports in batches <span className="font-normal text-faint">#431</span>
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
          <span
            key={frame.merged ? "merged" : "open"}
            className={cn(
              "tour-pop flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              frame.merged ? "bg-merged/15 text-merged" : "bg-success/15 text-success",
            )}
          >
            {frame.merged ? <GitMerge size={11} /> : <GitPullRequest size={11} />}
            {frame.merged ? "Merged" : "Open"}
          </span>
          <span className="text-fg-soft">@otto</span> wants to merge into <span className="font-mono text-[11px] text-fg-soft">main</span> · fixes the
          request from <span className="text-accent">#web</span>
        </p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_15rem] gap-4 px-5 py-4">
        <div className="min-w-0 space-y-3">
          <div className="flex gap-3 text-[12.5px] leading-[1.6] text-fg-soft">
            <Face who="Otto" size={24} />
            <p>
              Exports loaded every row before sending the first byte, so big accounts hit the 60 s limit. Rows now stream in
              batches of 1,000. A 200,000-row account takes 3.1 s.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <p className="flex items-center gap-2 border-b border-line px-3.5 py-2 font-mono text-[11px] text-muted">
              <FileText size={12} />
              services/export/csv.py
              <span className="ml-auto">
                <span className="text-success">+3</span> <span className="text-danger">−3</span>
              </span>
            </p>
            <pre className="py-1.5 font-mono text-[11px] leading-[1.75]">
              {DIFF.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    "px-3.5 transition-opacity duration-500",
                    line.sign === "+" ? "bg-success/10 text-success" : line.sign === "-" ? "bg-danger/10 text-danger" : "text-muted",
                    frame.diff ? "opacity-100" : "opacity-0",
                  )}
                  style={{ transitionDelay: frame.diff ? `${index * 70}ms` : "0ms" }}
                >
                  <span className="mr-3 inline-block w-2 text-faint select-none">{line.sign}</span>
                  {line.text}
                </div>
              ))}
            </pre>
          </div>
          <div
            className={cn(
              "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[12px] ring-1 transition-opacity duration-500",
              frame.approved ? "bg-success/5 text-fg-soft opacity-100 ring-success/25" : "opacity-0 ring-line",
            )}
          >
            <Face who="Margo" size={22} />
            <span>
              <span className="text-fg">@margo</span> approved: batching keeps memory flat, and the 200k-row test covers it.
            </span>
            <Check size={14} className="ml-auto shrink-0 text-success" />
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-surface">
            <p className="border-b border-line px-3.5 py-2 text-[11px] font-medium text-muted">
              Checks · {frame.checks} of {CHECKS.length} passed
            </p>
            <ul className="space-y-2 px-3.5 py-2.5">
              {CHECKS.map((check, index) => {
                const done = index < frame.checks;
                return (
                  <li key={check} className="flex items-center gap-2 text-[12px]">
                    {done ? (
                      <span className="tour-pop flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    ) : (
                      <span className="tour-spin size-3.5 rounded-full border-2 border-warn/25 border-t-warn" />
                    )}
                    <span className={done ? "text-fg-soft" : "text-muted"}>{check}</span>
                    <span className="ml-auto font-mono text-[10px] text-faint">{done ? `${18 + index * 23}s` : ""}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div
            className={cn(
              "rounded-xl px-3.5 py-3 text-[12px] ring-1 transition-colors duration-500",
              frame.merged ? "bg-merged/10 text-merged ring-merged/30" : frame.approved ? "bg-success/10 text-success ring-success/30" : "text-muted ring-line",
            )}
          >
            <p className="flex items-center gap-2 font-medium">
              <GitMerge size={13} />
              {frame.merged ? "Merged by the merge queue" : frame.approved ? "In the merge queue" : "Waiting on checks and review"}
            </p>
            <p className="mt-1 text-[11px] text-faint">{frame.merged ? "Deploying to production" : "Main only moves to what passed."}</p>
          </div>
          <div
            className={cn(
              "rounded-xl border border-line bg-surface px-3.5 py-3 text-[12px] transition-opacity duration-500",
              frame.checks >= CHECKS.length ? "opacity-100" : "opacity-0",
            )}
          >
            <p className="text-[11px] font-medium text-muted">Preview</p>
            <p className="mt-1 truncate font-mono text-[11px] text-accent">pr-431.web.acme.g1t.page</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Docs ---------------------------------------------------------------- */

/** Docs' sidebar: search, then each space's pages. */
function DocsSide() {
  return (
    <>
      <SideHead action={<Plus size={14} />}>
        Docs
      </SideHead>
      <div className="px-2 pt-2.5">
        <SideSearch>Search docs</SideSearch>
        <SideLabel>Product</SideLabel>
        {["Getting started", "Billing", "Exporting data", "Integrations"].map((page) => (
          <SideRow key={page} on={page === "Exporting data"}>
            <FileText size={12} className="text-faint" />
            {page}
          </SideRow>
        ))}
        <SideLabel>Engineering</SideLabel>
        {["Runbooks", "Decisions"].map((page) => (
          <SideRow key={page}>
            <FileText size={12} className="text-faint" />
            {page}
          </SideRow>
        ))}
      </div>
    </>
  );
}

function DocsMain({ frame }: { frame: Frame; tag?: boolean }) {
  return (
    <div className="relative h-full px-10 py-7">
      <p className="text-[11px] text-faint">Product / Exporting data</p>
      <h3 className="mt-2 text-[22px] font-semibold tracking-tight text-fg">Exporting data</h3>
      <p className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
        Owned by <span className="text-fg-soft">@inky</span> ·{" "}
        <span key={frame.docUpdated ? "now" : "then"} className="tour-fade">
          {frame.docUpdated ? "updated just now from #431" : "updated 3 weeks ago"}
        </span>
      </p>
      <div className="mt-5 max-w-xl space-y-3 text-[13px] leading-[1.7] text-fg-soft">
        <p>Export any table as CSV from Settings, then Data. An export includes every row you can see, in the order shown.</p>
        <p className="pt-2 text-[14px] font-semibold text-fg">Large accounts</p>
        <div className="relative">
          <p
            className={cn(
              "rounded-md px-3 py-2 transition-all duration-500",
              frame.docUpdated ? "bg-danger/5 text-faint line-through decoration-danger/50" : "text-fg-soft",
            )}
          >
            Exports over 50,000 rows can time out. Split them by date range.
          </p>
          <div
            className={cn(
              "mt-1.5 rounded-md border-l-2 border-success bg-success/10 px-3 py-2 text-fg transition-all duration-700",
              frame.docUpdated ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
            )}
          >
            Exports of any size stream in batches of 1,000 rows. A 200,000-row account finishes in about 3 seconds.
          </div>
        </div>
        <div
          className={cn(
            "flex items-center gap-2 pt-1 text-[11px] text-muted transition-opacity delay-300 duration-500",
            frame.docUpdated ? "opacity-100" : "opacity-0",
          )}
        >
          <Face who="Inky" size={18} />
          <span>
            Updated by <span className="text-fg">@inky</span> after <span className="text-accent">#431</span> merged
          </span>
        </div>
        <p className="pt-3 text-[14px] font-semibold text-fg">Scheduled exports</p>
        <p>Owners can send an export to a storage bucket every day or week. Each run uses the same columns as the last.</p>
      </div>
    </div>
  );
}

/* The cursor ------------------------------------------------------------ */

function Cursor({ frame, canvas, scale }: { frame: Frame; canvas: React.RefObject<HTMLDivElement | null>; scale: number }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useIsoLayoutEffect(() => {
    const root = canvas.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const target = frame.cursor === "idle" ? null : root.querySelector<HTMLElement>(`[data-tour="${frame.cursor}"]`);
    if (!target) {
      setAt({ x: W * 0.64, y: H * 0.88 });
      return;
    }
    const rect = target.getBoundingClientRect();
    // The composer is clicked towards its right, clear of the words being typed; everything else in its middle.
    const across = frame.cursor === "composer" ? 0.82 : 0.5;
    setAt({ x: (rect.left - box.left + rect.width * across) / scale, y: (rect.top - box.top + rect.height * 0.55) / scale });
  }, [frame.cursor, scale, canvas]);
  if (!at) return null;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute top-0 left-0 z-20 transition-[transform,opacity] duration-[900ms] ease-[cubic-bezier(.45,.05,.2,1)]", frame.cursorShown ? "opacity-100" : "opacity-0")}
      style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
    >
      <span
        className={cn(
          "absolute -top-4 -left-4 size-8 rounded-full bg-accent/30 transition-[transform,opacity] duration-300",
          frame.click ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
      <svg
        width="18"
        height="20"
        viewBox="0 0 18 20"
        className={cn("relative drop-shadow-[0_2px_6px_rgb(0_0_0/0.5)] transition-transform duration-150", frame.click && "scale-90")}
      >
        <path d="M1.5 1.5 L1.5 15.5 L5.5 12 L8.3 18 L11 16.8 L8.3 11 L13.5 11 Z" fill="#ededef" stroke="#0f0f11" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/* Desktop ------------------------------------------------------------- */

const SIDES: Record<Scene, (props: { frame: Frame }) => ReactNode> = {
  chat: ChatSide,
  agents: AgentsSide,
  code: CodeSide,
  docs: DocsSide,
};

/** Where each page is, as the top bar's trail says it; Chat has no top bar on a computer. */
const CRUMBS: Record<Scene, { label: string; mono?: boolean }[] | null> = {
  chat: null,
  agents: [{ label: "acme", mono: true }, { label: "Agents" }],
  code: [{ label: "acme", mono: true }, { label: "web", mono: true }, { label: "Pull request #431" }],
  docs: [{ label: "acme", mono: true }, { label: "Docs" }],
};

/** The sidebar's colour, a shade lighter than the page (shell.tsx, SIDEBAR_BOX). */
const SIDE_BG = "color-mix(in srgb, var(--color-surface) 70%, var(--color-bg))";

function Desktop({ frame, reduced }: { frame: Frame; reduced: boolean }) {
  const outer = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = outer.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? W;
      if (width > 0) setScale(width / W);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scenes: Scene[] = ["code", "chat", "agents", "docs"];
  const mains: Record<Scene, ReactNode> = {
    chat: <ChatMain frame={frame} />,
    agents: <AgentsMain frame={frame} />,
    code: <CodeMain frame={frame} />,
    docs: <DocsMain frame={frame} />,
  };
  return (
    <div ref={outer} className="relative w-full overflow-hidden rounded-2xl shadow-2xl shadow-black/50 ring-1 ring-line" style={{ aspectRatio: `${W} / ${H}` }}>
      <div
        ref={canvas}
        className="absolute top-0 left-0 flex origin-top-left bg-bg text-left"
        style={{ width: W, height: H, transform: scale === 1 ? undefined : `scale(${scale})`, ["--tour-side" as string]: SIDE_BG } as CSSProperties}
      >
        <Rail scene={frame.scene} />
        <div className="relative min-w-0 flex-1">
          {scenes.map((scene) => {
            const Side = SIDES[scene];
            const on = frame.scene === scene;
            const crumbs = CRUMBS[scene];
            return (
              <div
                key={scene}
                aria-hidden={!on}
                className={cn(
                  "absolute inset-0 flex transition-[opacity,transform] duration-500 ease-out",
                  on ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0",
                )}
              >
                <div className="flex w-52 shrink-0 flex-col overflow-hidden border-r border-line" style={{ background: SIDE_BG }}>
                  <Side frame={frame} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  {crumbs && <TopBar crumbs={crumbs} />}
                  <div className="min-h-0 flex-1">{mains[scene]}</div>
                </div>
              </div>
            );
          })}
        </div>
        {!reduced && <Cursor frame={frame} canvas={canvas} scale={scale} />}
      </div>
    </div>
  );
}

/* Phone --------------------------------------------------------------- */

const MODE: Record<Scene, { icon: ReactNode; label: string }> = {
  chat: { icon: <Hash size={14} />, label: "web" },
  agents: { icon: <Sparkles size={14} />, label: "Otto · Sessions" },
  code: { icon: <GitPullRequest size={14} />, label: "Pull request #431" },
  docs: { icon: <BookOpen size={14} />, label: "Exporting data" },
};

/** The phone's tab bar, as the app has it (components/mobile.tsx). */
const TABS: { scene: Scene | null; icon: ReactNode; label: string }[] = [
  { scene: null, icon: <House size={16} />, label: "Home" },
  { scene: "code", icon: <Code2 size={16} />, label: "Code" },
  { scene: "chat", icon: <MessagesSquare size={16} />, label: "Chat" },
  { scene: "agents", icon: <Sparkles size={16} />, label: "Agents" },
  { scene: null, icon: <Inbox size={16} />, label: "Inbox" },
];

function Phone({ frame }: { frame: Frame }) {
  const scenes: Scene[] = ["code", "chat", "agents", "docs"];
  return (
    <div className="relative flex h-[34rem] w-full flex-col overflow-hidden rounded-2xl bg-bg text-left shadow-2xl shadow-black/50 ring-1 ring-line">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Avatar name="acme" size={26} square />
        <span key={frame.scene} className="tour-fade flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-fg">
          <span className="text-faint">{MODE[frame.scene].icon}</span>
          <span className="truncate">{MODE[frame.scene].label}</span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {scenes.map((scene) => {
          const on = frame.scene === scene;
          return (
            <div
              key={scene}
              aria-hidden={!on}
              className={cn("absolute inset-0 transition-opacity duration-500", on ? "opacity-100" : "pointer-events-none opacity-0")}
            >
              {scene === "chat" && <PhoneChat frame={frame} />}
              {scene === "agents" && <PhoneAgents frame={frame} />}
              {scene === "code" && <PhoneCode frame={frame} />}
              {scene === "docs" && (
                <div className="origin-top-left scale-[0.86]" style={{ width: "116%" }}>
                  <DocsMain frame={frame} tag={false} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Inside a conversation the tab bar steps aside, as it does on a phone. */}
      {frame.scene !== "chat" && (
        <div className="grid h-12 shrink-0 grid-cols-5 border-t border-line bg-[#0b0b0d]">
          {TABS.map((tab) => {
            const on = tab.scene === frame.scene;
            return (
              <span key={tab.label} className="flex flex-col items-center justify-center gap-0.5">
                <span className={cn("flex h-6 w-10 items-center justify-center rounded-full", on ? "bg-[#2c2c33] text-fg" : "text-muted")}>{tab.icon}</span>
                <span className={cn("text-[9.5px] font-medium", on ? "text-fg" : "text-faint")}>{tab.label}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PhoneChat({ frame }: { frame: Frame }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)] [&>div]:px-3">
        <Message who="Priya" time="09:02">
          <p>Morning! Thursday&apos;s release closes Wednesday night.</p>
        </Message>
        <Message who="Dana" time="09:12">
          <p>Two enterprise customers hit the CSV export timeout again this morning.</p>
        </Message>
        {frame.sent && (
          <Message who="Priya" time="09:15" enter>
            <p>
              <Rich text={ASK} />
            </p>
          </Message>
        )}
        {frame.g1tTyping && (
          <div className="tour-in flex items-center gap-3 py-2 text-[12px] text-faint">
            <Face who="g1t" />
            <Dots />
          </div>
        )}
        {frame.handoff && (
          <Message who="g1t" time="09:15" enter>
            <p>
              <Rich text="On it. @otto will fix it and @margo will review." />
            </p>
            <TaskCard frame={frame} />
          </Message>
        )}
        {frame.shipped && (
          <Message who="g1t" time="09:41" enter>
            <p>
              <Rich text="Shipped. @sam, can you tell #support?" />
            </p>
          </Message>
        )}
        {frame.sam && (
          <Message who="Sam" time="09:42" enter>
            <p>
              <Rich text="Done. Told #support." />
            </p>
          </Message>
        )}
      </div>
      <div className="px-3 pt-1 pb-3">
        <div className={cn("flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[13px] ring-1", frame.typed > 0 ? "ring-accent/50" : "ring-line")}>
          <span className="min-w-0 flex-1 truncate">
            {frame.typed > 0 ? (
              <span className="text-fg">
                {ASK.slice(Math.max(0, frame.typed - 34), frame.typed)}
                <span className="tour-caret ml-px inline-block h-[14px] w-px translate-y-[2px] bg-accent" />
              </span>
            ) : (
              <span className="text-faint">Message #web</span>
            )}
          </span>
          <SendHorizontal size={15} className={frame.typed === ASK.length ? "text-accent" : "text-faint"} />
        </div>
      </div>
    </div>
  );
}

function PhoneAgents({ frame }: { frame: Frame }) {
  const cost = STEPS[frame.steps - 1]?.cost ?? 0;
  return (
    <div className="space-y-3 px-3 py-4">
      <div className="flex items-center gap-3">
        <Face who="Otto" size={32} />
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-fg">
            Otto <AgentTag />
          </p>
          <p className="text-[11px] text-muted">{frame.merged ? "Shipped #431" : "Working"} · ${cost.toFixed(2)} of $5</p>
        </div>
      </div>
      <div className="rounded-xl border border-line bg-surface">
        <p className="border-b border-line px-3.5 py-2.5 text-[13px] font-medium text-fg">CSV export times out for big accounts</p>
        <ol className="space-y-2 px-3.5 py-3">
          {STEPS.map((step, index) => {
            const done = index < frame.steps;
            const now = index === frame.steps;
            return (
              <li key={step.text} className={cn("flex items-start gap-2.5 text-[12.5px]", done ? "text-fg-soft" : now ? "text-fg" : "text-faint")}>
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {done ? (
                    <span className="tour-pop flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  ) : now ? (
                    <span className="tour-spin size-3.5 rounded-full border-2 border-accent/25 border-t-accent" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-line-strong" />
                  )}
                </span>
                {step.text}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3.5 py-2.5">
          {FILES.filter((file) => frame.steps >= file.from).map((file) => (
            <span key={file.path} className="tour-pop rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-line">
              {file.path}
            </span>
          ))}
          <span className="min-h-[18px]" />
        </div>
      </div>
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl bg-accent/10 px-3.5 py-2.5 text-[12px] font-medium text-accent ring-1 ring-accent/25 transition-opacity duration-500",
          frame.steps >= STEPS.length ? "opacity-100" : "opacity-0",
        )}
      >
        <GitPullRequest size={13} />
        Pull request #431 opened
        <ArrowRight size={12} className="ml-auto" />
      </div>
      <Consult frame={frame} compact />
      <div className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[11.5px] text-faint ring-dashed">
        <span className="rounded bg-raised px-1.5 py-0.5 text-[9.5px] uppercase">Queued</span>
        Upgrade the date library
      </div>
    </div>
  );
}

function PhoneCode({ frame }: { frame: Frame }) {
  return (
    <div className="space-y-3 px-3 py-4">
      <p className="text-[14px] font-semibold text-fg">
        Stream CSV exports in batches <span className="font-normal text-faint">#431</span>
      </p>
      <p className="text-[12px] leading-[1.6] text-muted">
        <span className="text-fg-soft">@otto</span> wants to merge into <span className="font-mono text-[11px] text-fg-soft">main</span>. Rows now
        stream in batches of 1,000; a 200,000-row account takes 3.1 s.
      </p>
      <div className="rounded-xl border border-line bg-surface">
        <ul className="space-y-2 px-3.5 py-3">
          {CHECKS.map((check, index) => {
            const done = index < frame.checks;
            return (
              <li key={check} className="flex items-center gap-2 text-[12px]">
                {done ? (
                  <span className="tour-pop flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                    <Check size={10} strokeWidth={3} />
                  </span>
                ) : (
                  <span className="tour-spin size-3.5 rounded-full border-2 border-warn/25 border-t-warn" />
                )}
                <span className={done ? "text-fg-soft" : "text-muted"}>{check}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <pre className={cn("overflow-hidden rounded-xl border border-line bg-surface py-1.5 font-mono text-[10.5px] leading-[1.7] transition-opacity duration-500", frame.diff ? "opacity-100" : "opacity-0")}>
        {DIFF.slice(1).map((line, index) => (
          <div key={index} className={cn("truncate px-3", line.sign === "+" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
            {line.sign} {line.text.trim()}
          </div>
        ))}
      </pre>
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[12px] ring-1 transition-colors duration-500",
          frame.merged ? "bg-merged/10 text-merged ring-merged/30" : frame.approved ? "bg-success/10 text-success ring-success/30" : "text-muted ring-line",
        )}
      >
        <GitMerge size={13} />
        {frame.merged ? "Merged · deploying" : frame.approved ? "Approved by @margo" : "Waiting on checks and review"}
      </div>
    </div>
  );
}

/* The tour -------------------------------------------------------------- */

/** Keyframes the tour's parts use; transforms and opacity only. */
const STYLES = `
.tour-in { animation: tour-in 420ms cubic-bezier(.2,.7,.2,1) both; }
@keyframes tour-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.tour-pop { animation: tour-pop 360ms cubic-bezier(.3,1.4,.5,1) both; }
@keyframes tour-pop { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: none; } }
.tour-fade { animation: tour-fade 400ms ease-out both; }
@keyframes tour-fade { from { opacity: 0; } to { opacity: 1; } }
.tour-dot { animation: tour-dot 1.1s ease-in-out infinite; }
@keyframes tour-dot { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
.tour-caret { animation: tour-caret 1s steps(1) infinite; }
@keyframes tour-caret { 50% { opacity: 0; } }
.tour-spin { animation: tour-spin .9s linear infinite; }
@keyframes tour-spin { to { transform: rotate(360deg); } }
.tour-pulse { animation: tour-pulse 1.6s ease-in-out infinite; }
@keyframes tour-pulse { 50% { opacity: .35; } }
.ring-dashed { box-shadow: none; outline: 1px dashed var(--g1t-line-strong); outline-offset: -1px; }
@media (prefers-reduced-motion: reduce) {
  .tour-in, .tour-pop, .tour-fade, .tour-dot, .tour-caret, .tour-spin, .tour-pulse { animation: none; }
}
`;

/**
 * The hero's tour: the frame (a full app on wider screens, one pane on a
 * phone), the step pills under it, and a line saying what is a preview.
 */
export function ProductTour({ className }: { className?: string }) {
  const clock = useTourClock();
  const { frame } = clock;
  return (
    <div ref={clock.rootRef} className={className}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div
        role="img"
        aria-label="A tour of g1t: a person asks g1t in a channel to fix a slow export, an agent works the task, the pull request passes its checks and merges, g1t says it shipped, and the docs page updates."
        onMouseEnter={() => clock.hover(true)}
        onMouseLeave={() => clock.hover(false)}
      >
        <div className="hidden md:block">
          <Desktop frame={frame} reduced={clock.reduced} />
        </div>
        <div className="md:hidden">
          <Phone frame={frame} />
        </div>
      </div>
      <div className="mt-4 flex justify-center" aria-live="polite">
        <HonestyNote frame={frame} />
      </div>
      <div className="mx-auto mt-3 grid max-w-xl grid-cols-4 gap-2" role="tablist" aria-label="Steps of the tour">
        {PILLS.map((pill, index) => {
          const on = clock.pill === index;
          return (
            <button
              key={pill.scene}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => clock.jump(index)}
              className={cn(
                "group relative overflow-hidden rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors",
                on ? "bg-surface text-fg ring-line-strong" : "text-muted ring-line hover:text-fg-soft",
              )}
            >
              <span
                ref={(element) => {
                  clock.barRefs.current[index] = element;
                }}
                aria-hidden="true"
                className="absolute inset-0 origin-left bg-accent/15"
                style={{ transform: `scaleX(${clock.reduced && on ? 1 : 0})` }}
              />
              <span className="relative flex items-center justify-center gap-1.5">
                {pill.label}
                {pill.soon && (
                  <>
                    <span className="hidden text-[10px] font-normal text-faint sm:inline">soon</span>
                    <span className="size-1 rounded-full bg-faint sm:hidden" aria-label="coming soon" />
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mx-auto mt-3 max-w-xl text-center text-xs leading-5 text-faint text-balance">
        Chat, agents and their sessions (colleagues brought in included), pull requests, checks and the merge queue work
        today, and so does Docs. g1t splitting one request between colleagues on its own, and an agent updating a page after a merge by itself, are coming soon. Otto, Margo and the others are
        agents this workspace hired from role templates; only @g1t comes built in.
      </p>
    </div>
  );
}
