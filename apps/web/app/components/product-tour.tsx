/**
 * The landing page's product tour: g1t browsing itself. A faithful app
 * frame (rail, sidebars, the real colours) plays one story on a loop, with
 * a soft cursor that moves and clicks: the pull request going green and
 * merging, the session its author's coding agent recorded onto it, the
 * people in #web hearing it shipped, and the docs page.
 *
 * The frame is a pure function of time (lib/tour.ts). One rAF loop drives
 * the clock and re-renders only when the frame changes; the step pills'
 * progress bars are written straight to the DOM. The server renders t = 0
 * and the clock starts after mount, so there is no hydration mismatch.
 * Motion is transforms and opacity only. Reduced motion gets a still frame
 * per step, chosen with the pills.
 *
 * It is an honest miniature of the app: the same rail (the workspace on
 * the top bar's line, then Home, Chat, Code and Artifacts, with names),
 * each mode's sidebar with its real sections and words, the same top bar
 * (where you are, Explore, Docs, the inbox and +), which Chat gives up to
 * the conversation's own header as the app does, and the app's own cards.
 * The coding agent is one people bring: its commits carry its mark, as
 * components/coding-agent.tsx draws it, and its session is the pull
 * request's Session tab. Everything the tour shows works today.
 */
import {
  Activity,
  AtSign,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Box,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDot,
  CircleHelp,
  Code2,
  Compass,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hash,
  House,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  PlayCircle,
  Plus,
  Rocket,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Shapes,
  SquarePen,
  User,
  Wrench,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { codingAgentById } from "@g1t/contracts/coding-agents";

import { cn } from "../lib/cn";
import { CHECKS, type CursorTarget, type Frame, LOOP_MS, PILLS, SESSION, type SessionEntry, STILLS, type Scene, frameAt, pillAt, pillProgress, sameFrame } from "../lib/tour";
import { AgentBadge, AgentMark } from "./coding-agent";

import { Avatar } from "./ui/avatar";
import { Card } from "./ui/card";

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
      const next = frameAt(STILLS.code);
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

/** What the line under the frame says about the moment. Everything in the tour works today. */
const HONESTY: Record<Scene, string> = {
  code: "Works today",
  session: "Works today: recorded by your coding agent through MCP",
  chat: "Works today",
  docs: "Works today",
};

/** The line under the frame. Not part of the app, so it sits outside it. */
function HonestyNote({ frame, className }: { frame: Frame; className?: string }) {
  const label = HONESTY[frame.scene];
  return (
    <span
      key={label}
      className={cn(
        "tour-fade inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success ring-1 ring-success/25",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-success" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Small parts                                                         */
/* ------------------------------------------------------------------ */

/** The people in the story. */
const PEOPLE: Record<string, string> = { Priya: "Priya Shah", Dana: "Dana Ruiz", Alex: "Alex Lee", Jordan: "Jordan Kim" };

/** The coding agent Priya brought: known by the address on its commits, not an account on g1t. */
const CLAUDE = codingAgentById("claude")!;

/** A person's avatar, as the app draws it. */
function Face({ who, size = 28 }: { who: string; size?: number }) {
  return <Avatar name={who.toLowerCase()} size={size} />;
}

/** The coding agent's mark, its name and its badge, as commits and sessions show them. */
function WithAgent() {
  return (
    <span className="inline-flex items-center gap-1">
      <AgentMark agent={CLAUDE} size={14} />
      <span className="text-fg-soft">{CLAUDE.name}</span>
      <AgentBadge agent={CLAUDE} />
    </span>
  );
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

function Message({ who, time, children, enter }: { who: string; time: string; children: ReactNode; enter?: boolean }) {
  return (
    <div className={cn("flex gap-3 px-5 py-2", enter && "tour-in")}>
      <Face who={who} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <span className="font-semibold text-fg">{PEOPLE[who] ?? who}</span>
          <span className="text-[11px] text-faint">{time}</span>
        </p>
        <div className="mt-0.5 space-y-2 text-[13px] leading-[1.55] text-fg-soft">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The app frame                                                       */
/* ------------------------------------------------------------------ */

/** The rail's modes, in the app's order (components/rail.tsx), with its icons. */
const RAIL: { key: string; icon: ReactNode; label: string; target?: CursorTarget; scenes?: Scene[]; badge?: number }[] = [
  { key: "home", icon: <House size={15} />, label: "Home" },
  { key: "chat", icon: <MessagesSquare size={15} />, label: "Chat", target: "rail-chat", scenes: ["chat"], badge: 3 },
  { key: "code", icon: <Code2 size={15} />, label: "Code", target: "rail-code", scenes: ["code", "session"] },
  { key: "artifacts", icon: <Shapes size={15} />, label: "Artifacts", target: "rail-docs", scenes: ["docs"] },
  { key: "inbox", icon: <Bell size={15} />, label: "Notifications", badge: 2 },
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
          <RailItem key={item.key} icon={item.icon} label={item.label} on={!!item.scenes?.includes(scene)} target={item.target} badge={item.badge} />
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
 * then Explore, Docs, the inbox and the + menu. Chat has none on a
 * computer: the conversation's header takes its line.
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
function SideHead({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line pr-2 pl-3.5">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">{children}</span>
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

function ChatSide() {
  // As the app has it: direct messages with people, the latest first.
  const dms: { who: string; away?: boolean; status?: string }[] = [
    { who: "Dana" },
    { who: "Jordan" },
    { who: "Alex", away: true, status: "🗓️" },
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
        {dms.map((dm) => (
          <SideRow key={dm.who}>
            <span className="relative flex">
              <Face who={dm.who} size={16} />
              <PresenceDot away={dm.away} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {PEOPLE[dm.who]}
              {dm.status && <span className="ml-1.5 text-[11px]">{dm.status}</span>}
            </span>
          </SideRow>
        ))}
      </div>
    </>
  );
}

function ChatMain({ frame }: { frame: Frame }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-5">
        <Hash size={15} className="text-faint" />
        <span className="text-sm font-semibold text-fg">web</span>
        <span aria-hidden="true" className="h-3.5 w-px bg-line" />
        <span className="truncate text-xs text-muted">The web app, its releases and its bugs</span>
        <span className="ml-auto flex -space-x-1.5" aria-hidden="true">
          {["Priya", "Dana", "Jordan", "Alex"].map((who) => (
            <span key={who} className="rounded-full ring-2 ring-surface">
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
        <Message who="Jordan" time="09:02">
          <p>Morning! Thursday&apos;s release closes Wednesday night, so anything for it needs to land by then.</p>
        </Message>
        <Message who="Dana" time="09:12">
          <p>Two enterprise customers hit the CSV export timeout again this morning. Both have over 100k rows.</p>
        </Message>
        <Message who="Priya" time="09:15">
          <p>
            <Rich text="I'll take it, @dana. I'll post here when it ships." />
          </p>
        </Message>
        {frame.shipped && (
          <Message who="Priya" time="09:41" enter>
            <p>
              <Rich text="Shipped in #431. A 200,000-row export now finishes in about 3 s. @dana, can you let your two customers know?" />
            </p>
          </Message>
        )}
        {frame.told && (
          <Message who="Dana" time="09:42" enter>
            <p>
              <Rich text="Done. Both can export again, and I told #support." />
            </p>
          </Message>
        )}
      </div>
      <div className="px-5 pt-1 pb-4">
        <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[13px] ring-1 ring-line">
          <span className="min-w-0 flex-1 truncate text-faint">Message #web</span>
          <AtSign size={15} className="text-faint" />
          <Paperclip size={15} className="text-faint" />
          <span className="flex size-7 items-center justify-center rounded-md text-faint">
            <SendHorizontal size={14} />
          </span>
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
        {row(<PlayCircle size={13} />, "Workflows")}
        <div className="mx-2 my-2 h-px bg-line" />
        {row(<Rocket size={13} />, "Deployments")}
        {row(<Activity size={13} />, "Observability")}
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

/**
 * The pull request's header and tabs, as routes/repo/pull.tsx has them:
 * its title, state and author (with the coding agent on its commits), then
 * Conversation, Session and Files changed.
 */
function PullHead({ frame, tab }: { frame: Frame; tab: "conversation" | "session" }) {
  const tabs: { key: string; icon: ReactNode; label: string; count?: number; target?: CursorTarget }[] = [
    { key: "conversation", icon: <MessageSquare size={13} />, label: "Conversation", count: 2 },
    { key: "session", icon: <MessagesSquare size={13} />, label: "Session", target: "pr-session" },
    { key: "changes", icon: <FileDiff size={13} />, label: "Files changed", count: 3 },
  ];
  return (
    <div className="px-5 pt-4">
      <p className="text-[15px] font-semibold text-fg">
        Stream CSV exports in batches <span className="font-normal text-faint">#431</span>
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
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
        <span className="text-fg-soft">{PEOPLE.Priya}</span> wants to merge into <span className="font-mono text-[11px] text-fg-soft">main</span> · with
        <WithAgent />
      </p>
      <div className="mt-3 flex items-end gap-1 border-b border-line text-[12px]">
        {tabs.map((item) => {
          const on = item.key === tab;
          return (
            <span
              key={item.key}
              data-tour={item.target}
              className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pb-2", on ? "border-accent font-medium text-fg" : "border-transparent text-muted")}
            >
              {item.icon}
              {item.label}
              {item.count ? <span className="rounded-full bg-raised px-1.5 text-[10px] text-muted tabular-nums ring-1 ring-line">{item.count}</span> : null}
            </span>
          );
        })}
        <span className="ml-auto pb-2 font-mono text-[11px]">
          <span className="text-success">+41</span> <span className="text-danger">−12</span>
        </span>
      </div>
    </div>
  );
}

function CodeMain({ frame }: { frame: Frame }) {
  return (
    <div className="flex h-full flex-col">
      <PullHead frame={frame} tab="conversation" />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_15rem] gap-4 px-5 py-4">
        <div className="min-w-0 space-y-3">
          <div className="flex gap-3 text-[12.5px] leading-[1.6] text-fg-soft">
            <Face who="Priya" size={24} />
            <p>
              Exports loaded every row before sending the first byte, so big accounts hit the 60 s limit. Rows now stream in
              batches of 1,000. A 200,000-row account takes 3.1 s. Fixes the timeout Dana reported in <span className="text-accent">#web</span>.
            </p>
          </div>
          <Card className="overflow-hidden">
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
          </Card>
          <div
            className={cn(
              "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[12px] ring-1 transition-opacity duration-500",
              frame.approved ? "bg-success/5 text-fg-soft opacity-100 ring-success/25" : "opacity-0 ring-line",
            )}
          >
            <Face who="Dana" size={22} />
            <span>
              <span className="text-fg">{PEOPLE.Dana}</span> approved: tried it on the preview with a 200k-row account. Done in seconds.
            </span>
            <Check size={14} className="ml-auto shrink-0 text-success" />
          </div>
        </div>
        <div className="space-y-3">
          <Card>
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
          </Card>
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
            <p className="mt-1 truncate font-mono text-[11px] text-accent">web-git-csv-acme.g1t.page</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One entry of the session, on the timeline's rail, as the pull request's Session tab draws it. */
function SessionLine({ entry, shown }: { entry: SessionEntry; shown: boolean }) {
  const Icon = entry.kind === "prompt" ? User : entry.kind === "tool" ? Wrench : Bot;
  return (
    <li className={cn("relative pl-9 transition-[opacity,transform] duration-500", shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}>
      <span
        className={cn(
          "absolute top-0 left-0 flex size-6 items-center justify-center rounded-full border bg-bg",
          entry.kind === "prompt" ? "border-accent/50 text-accent" : "border-line text-faint",
        )}
      >
        <Icon size={12} />
      </span>
      {entry.kind === "tool" ? (
        <Card className="flex items-center gap-2 px-3 py-1.5">
          <span className="font-mono text-[11px] text-accent">{entry.tool}</span>
          <span className="truncate font-mono text-[11px] text-muted">{entry.text}</span>
        </Card>
      ) : (
        <div>
          <p className="text-[11px] font-medium text-faint">{entry.kind === "prompt" ? "Prompt" : CLAUDE.name}</p>
          {entry.kind === "prompt" ? (
            <Card className="mt-1 px-3 py-2 text-[12.5px] leading-[1.55] text-fg-soft">{entry.text}</Card>
          ) : (
            <p className="mt-0.5 text-[12.5px] leading-[1.55] text-fg-soft">{entry.text}</p>
          )}
        </div>
      )}
      {entry.commit && (
        <p className="mt-1 flex items-center gap-1 font-mono text-[11px] text-faint">
          <GitCommitHorizontal size={12} />
          {entry.commit}
        </p>
      )}
    </li>
  );
}

/** The pull request's Session tab: what the coding agent was asked, read, ran and decided, recorded as it worked. */
function SessionMain({ frame }: { frame: Frame }) {
  return (
    <div className="flex h-full flex-col">
      <PullHead frame={frame} tab="session" />
      <div className="min-h-0 flex-1 overflow-hidden px-5 py-4">
        <p className="mb-3 flex items-center gap-1.5 text-[11.5px] text-muted">
          Recorded by <WithAgent /> for {PEOPLE.Priya} through g1t&apos;s MCP server · {SESSION.length} entries
        </p>
        <ol className="space-y-3">
          {SESSION.map((entry, index) => (
            <SessionLine key={index} entry={entry} shown={index < frame.entries} />
          ))}
        </ol>
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

function DocsMain({ frame }: { frame: Frame }) {
  return (
    <div className="relative h-full px-10 py-7">
      <p className="text-[11px] text-faint">Product / Exporting data</p>
      <h3 className="mt-2 text-[22px] font-semibold tracking-tight text-fg">Exporting data</h3>
      <p className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
        Owned by <span className="text-fg-soft">{PEOPLE.Dana}</span> ·{" "}
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
          <Face who="Dana" size={18} />
          <span>
            Updated by <span className="text-fg">{PEOPLE.Dana}</span> after <span className="text-accent">#431</span> merged
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
    setAt({ x: (rect.left - box.left + rect.width * 0.5) / scale, y: (rect.top - box.top + rect.height * 0.55) / scale });
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
  code: CodeSide,
  session: CodeSide,
  chat: ChatSide,
  docs: DocsSide,
};

/** Where each page is, as the top bar's trail says it; Chat has no top bar on a computer. */
const CRUMBS: Record<Scene, { label: string; mono?: boolean }[] | null> = {
  chat: null,
  code: [{ label: "acme", mono: true }, { label: "web", mono: true }, { label: "Pull request #431" }],
  session: [{ label: "acme", mono: true }, { label: "web", mono: true }, { label: "Pull request #431" }],
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
  const scenes: Scene[] = ["code", "session", "chat", "docs"];
  const mains: Record<Scene, ReactNode> = {
    chat: <ChatMain frame={frame} />,
    session: <SessionMain frame={frame} />,
    code: <CodeMain frame={frame} />,
    docs: <DocsMain frame={frame} />,
  };
  return (
    <div ref={outer} className="relative w-full overflow-hidden rounded-2xl text-fg shadow-2xl shadow-black/50 ring-1 ring-line scheme-dark" style={{ aspectRatio: `${W} / ${H}` }}>
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
  code: { icon: <GitPullRequest size={14} />, label: "Pull request #431" },
  session: { icon: <MessagesSquare size={14} />, label: "#431 · Session" },
  chat: { icon: <Hash size={14} />, label: "web" },
  docs: { icon: <BookOpen size={14} />, label: "Exporting data" },
};

/** The phone's tab bar, as the app has it (components/mobile.tsx). */
const TABS: { scenes: Scene[]; icon: ReactNode; label: string }[] = [
  { scenes: [], icon: <House size={16} />, label: "Home" },
  { scenes: ["chat"], icon: <MessagesSquare size={16} />, label: "Chat" },
  { scenes: [], icon: <Bell size={16} />, label: "Notifications" },
  { scenes: ["code", "session"], icon: <Code2 size={16} />, label: "Code" },
];

function Phone({ frame }: { frame: Frame }) {
  const scenes: Scene[] = ["code", "session", "chat", "docs"];
  return (
    <div className="relative flex h-[34rem] w-full flex-col overflow-hidden rounded-2xl bg-bg text-left text-fg shadow-2xl shadow-black/50 ring-1 ring-line scheme-dark">
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
              {scene === "code" && <PhoneCode frame={frame} />}
              {scene === "session" && <PhoneSession frame={frame} />}
              {scene === "chat" && <PhoneChat frame={frame} />}
              {scene === "docs" && (
                <div className="origin-top-left scale-[0.86]" style={{ width: "116%" }}>
                  <DocsMain frame={frame} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Inside a conversation the tab bar steps aside, as it does on a phone. */}
      {frame.scene !== "chat" && (
        <div className="grid h-12 shrink-0 grid-cols-4 border-t border-line bg-[#0b0b0d]">
          {TABS.map((tab) => {
            const on = tab.scenes.includes(frame.scene);
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
        <Message who="Dana" time="09:12">
          <p>Two enterprise customers hit the CSV export timeout again this morning.</p>
        </Message>
        <Message who="Priya" time="09:15">
          <p>
            <Rich text="I'll take it, @dana." />
          </p>
        </Message>
        {frame.shipped && (
          <Message who="Priya" time="09:41" enter>
            <p>
              <Rich text="Shipped in #431. @dana, can you tell your customers?" />
            </p>
          </Message>
        )}
        {frame.told && (
          <Message who="Dana" time="09:42" enter>
            <p>
              <Rich text="Done. Both can export again." />
            </p>
          </Message>
        )}
      </div>
      <div className="px-3 pt-1 pb-3">
        <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[13px] ring-1 ring-line">
          <span className="min-w-0 flex-1 truncate text-faint">Message #web</span>
          <SendHorizontal size={15} className="text-faint" />
        </div>
      </div>
    </div>
  );
}

function PhoneSession({ frame }: { frame: Frame }) {
  return (
    <div className="h-full space-y-3 overflow-hidden px-3 py-4">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        Recorded by <WithAgent /> through MCP
      </p>
      <ol className="space-y-3">
        {SESSION.map((entry, index) => (
          <SessionLine key={index} entry={entry} shown={index < frame.entries} />
        ))}
      </ol>
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
        <span className="text-fg-soft">{PEOPLE.Priya}</span> wants to merge into <span className="font-mono text-[11px] text-fg-soft">main</span>. Rows now
        stream in batches of 1,000; a 200,000-row account takes 3.1 s.
      </p>
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        Commits with <WithAgent />
      </p>
      <Card>
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
      </Card>
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
        {frame.merged ? "Merged · deploying" : frame.approved ? `Approved by ${PEOPLE.Dana}` : "Waiting on checks and review"}
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
.tour-spin { animation: tour-spin .9s linear infinite; }
@keyframes tour-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .tour-in, .tour-pop, .tour-fade, .tour-spin { animation: none; }
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
        aria-label="A tour of g1t: a pull request passes its checks, is approved and is merged by the merge queue, its session from the coding agent that helped write it is replayed, the team hears it shipped in a channel, and the docs page is updated."
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
                "group relative overflow-hidden rounded-full px-2 py-1.5 text-[11px] font-medium whitespace-nowrap ring-1 transition-colors sm:px-3 sm:text-xs",
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
              </span>
            </button>
          );
        })}
      </div>
      <p className="mx-auto mt-3 max-w-xl text-center text-xs leading-5 text-faint text-balance">
        Everything here works today. Priya wrote the fix with Claude Code, connected to g1t through its MCP server: the
        commits carry its mark, and the session it recorded stays on the pull request.
      </p>
    </div>
  );
}
