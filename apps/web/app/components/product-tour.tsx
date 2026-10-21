/**
 * The landing page's product tour: g1t browsing itself. A faithful app
 * frame (app bar, sidebars, the real colours) plays one story on a loop, with
 * a soft cursor that moves and clicks: Home as its author starts her day
 * (what settled by itself, what still needs her, and What changed in plain
 * English), her pull request going green and merging, the session her
 * coding agent recorded onto it, and the people in #web hearing it shipped.
 *
 * The frame is a pure function of time (lib/tour.ts). One rAF loop drives
 * the clock and re-renders only when the frame changes; the step pills'
 * progress bars are written straight to the DOM. The server renders t = 0
 * and the clock starts after mount, so there is no hydration mismatch.
 * Motion is transforms and opacity only. Reduced motion gets a still frame
 * per step, chosen with the pills.
 *
 * It is an honest miniature of the app: the same app bar across the top
 * (g1t's mark and the workspace, then Home, Work, Chat, Code, Artifacts and
 * Routines as named tabs, the pinned apps, Apps and Explore, and at its end
 * search, Ask, the bell, + and you), so the cursor opens Chat by its tab;
 * under it each mode's sidebar from the frame's edge, with its real
 * sections and words; the page's own slim bar (the sidebar's toggle and
 * where you are), with a conversation's header under it in Chat as the app
 * has it; and the app's own cards.
 * The coding agent is one people bring: its commits carry its mark, as
 * components/coding-agent.tsx draws it, and its session is the pull
 * request's Session tab.
 */
import {
  Activity,
  ArrowRight,
  ArrowUp,
  AtSign,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  Ellipsis,
  Code2,
  Compass,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hash,
  House,
  LayoutGrid,
  ListTodo,
  Loader,
  MessageSquare,
  MessagesSquare,
  PanelLeft,
  Paperclip,
  PlayCircle,
  Plus,
  Repeat,
  Rocket,
  RotateCcw,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  LibraryBig,
  Sparkles,
  SquarePen,
  User,
  Wrench,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { codingAgentById } from "@g1t/contracts/coding-agents";

import { brandIcon } from "../lib/brand-icons";
import { cn } from "../lib/cn";
import { WORK_KINDS, WORK_LABEL, type WorkKind } from "../lib/home";
import {
  CHECKS,
  type CursorTarget,
  type Frame,
  LOOP_MS,
  PILLS,
  SESSION,
  SETTLED,
  SUMMARY_WORDS,
  type SessionEntry,
  STILLS,
  type Scene,
  frameAt,
  pillAt,
  pillProgress,
  sameFrame,
} from "../lib/tour";
import { AgentBadge, AgentMark } from "./coding-agent";
import { MarkGlyph } from "./logo";

import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
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
      const next = frameAt(STILLS.home);
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
  return Math.max(
    0,
    PILLS.findIndex((pill) => pill.scene === frame.scene),
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
  return <Avatar name={who.toLowerCase()} image={null} size={size} />;
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
function PresenceDot({ away, ring = "var(--color-sidebar)" }: { away?: boolean; ring?: string }) {
  return (
    <span
      className={cn("absolute -right-0.5 -bottom-0.5 size-1.75 rounded-full", away ? "bg-sidebar shadow-[inset_0_0_0_1.5px_var(--color-faint)]" : "bg-success")}
      style={{ boxShadow: `0 0 0 1.5px ${ring}${away ? ", inset 0 0 0 1.5px var(--color-faint)" : ""}` }}
    />
  );
}

/** Text with @mentions, #channels and #numbers picked out, as chat shows them; `targets` marks some for the cursor. */
function Rich({ text, targets }: { text: string; targets?: Record<string, CursorTarget> }) {
  const parts = text.split(/(@[a-z0-9-]+|#[a-z0-9]+)/gi);
  return (
    <>
      {parts.map((part, index) =>
        /^[@#]/.test(part) ? (
          <span key={index} data-tour={targets?.[part]} className={part.startsWith("@") ? "rounded bg-accent/15 px-0.5 text-accent" : "text-accent"}>
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

/** The app bar's tabs, in the app's order (lib/apps.ts BAR_APPS), with their icons (components/apps.tsx). */
const APP_TABS: { key: string; icon: ReactNode; label: string; target?: CursorTarget; scenes?: Scene[]; badge?: number }[] = [
  // Chat first, and lit on Home too: the app opens on Chat, and Chat on Home.
  // Unread in #support, none of it a mention: the quiet count, as the app gives it.
  { key: "chat", icon: <MessagesSquare size={14} />, label: "Chat", target: "tab-chat", scenes: ["home", "chat"], badge: 3 },
  { key: "work", icon: <ListTodo size={14} />, label: "Work" },
  { key: "code", icon: <Code2 size={14} />, label: "Code", target: "tab-code", scenes: ["code", "session"] },
  { key: "artifacts", icon: <LibraryBig size={14} />, label: "Library" },
  { key: "routines", icon: <Repeat size={14} />, label: "Routines" },
];

/** One tab of the app bar: a rounded pill, filled for the app you are in. */
const TAB = "relative flex h-7 shrink-0 items-center gap-1.5 rounded-lg text-[11.5px] transition-colors duration-500";

/** An installed app's mark, as the app bar shows a pinned one (components/connectors.tsx MarkTile): its brand on a tile of its colour. */
function AppMark({ id }: { id: string }) {
  const brand = brandIcon(id);
  const tint = brand?.color ?? "var(--color-fg)";
  return (
    <span
      className="flex size-4 items-center justify-center rounded-[4.5px]"
      style={{
        background: `color-mix(in srgb, ${tint} ${brand?.color ? 16 : 8}%, transparent)`,
        color: brand?.color ? `color-mix(in srgb, ${brand.color} 60%, var(--color-fg))` : "var(--color-fg)",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} ${brand?.color ? 30 : 14}%, transparent)`,
      }}
    >
      {brand && (
        <svg viewBox="0 0 24 24" width={9} height={9} fill="currentColor">
          <path d={brand.path} />
        </svg>
      )}
    </span>
  );
}

/** A divider between the app bar's groups. */
function BarRule() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-sidebar-border" />;
}

/**
 * The app bar, as the app has it (components/app-bar.tsx): g1t's mark and
 * the workspace with its menu; the apps as named tabs, the one you are in
 * on a filled pill and Chat with what is unread; the apps Priya pinned
 * (Sentry, Linear), Apps and Explore; then, at its end, search, Ask, the
 * bell, + and Priya, with the dot that says how others see her. The bell
 * counts the two failures on Home, and loses them as they settle.
 */
function AppBar({ frame }: { frame: Frame }) {
  const unread = SETTLED.length - frame.settled;
  return (
    <header aria-hidden="true" className="relative z-10 flex h-11 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar pr-2.5 pl-2">
      <span className={cn(TAB, "w-7 justify-center text-fg")}>
        <MarkGlyph className="h-3.75" />
      </span>
      <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1">
        <Avatar name="acme" size={19} square />
        <span className="text-[12px] font-semibold text-fg">Acme</span>
        <ChevronDown size={12} className="text-faint" />
      </span>
      <BarRule />
      <nav className="flex min-w-0 grow items-center gap-0.5">
        {APP_TABS.map((tab) => {
          const on = !!tab.scenes?.includes(frame.scene);
          return (
            <span key={tab.key} data-tour={tab.target} className={cn(TAB, "px-1.75", on ? "bg-sidebar-accent text-fg" : "text-muted")}>
              {tab.icon}
              {tab.label}
              {tab.badge ? (
                <span className="min-w-3.75 rounded-full bg-line-strong px-1 text-center text-[8.5px] leading-3.75 font-bold text-fg tabular-nums">
                  {tab.badge}
                </span>
              ) : null}
            </span>
          );
        })}
        <BarRule />
        <span className={cn(TAB, "w-7 justify-center")}>
          <AppMark id="sentry" />
        </span>
        <span className={cn(TAB, "w-7 justify-center")}>
          <AppMark id="linear" />
        </span>
        <span className={cn(TAB, "w-7 justify-center text-muted")}>
          <LayoutGrid size={14} />
        </span>
        <span className={cn(TAB, "w-7 justify-center text-muted")}>
          <Compass size={14} />
        </span>
      </nav>
      <span className="flex shrink-0 items-center gap-1">
        <span className="mr-0.5 ml-2 flex h-6.5 w-30 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[10.5px] text-faint">
          <Search size={11} className="shrink-0" />
          <span className="grow">Search</span>
          <span className="rounded bg-raised px-1 font-mono text-[8.5px] whitespace-nowrap text-muted ring-1 ring-line">Ctrl K</span>
        </span>
        <span className="flex h-6.5 items-center gap-1.5 rounded-md bg-accent/10 px-2 text-[11px] text-fg ring-1 ring-accent/20 ring-inset">
          <MarkGlyph className="h-2.75" />
          Ask
        </span>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <span className="relative flex size-6.5 items-center justify-center text-muted">
          <Bell size={14} />
          {unread > 0 && (
            <span
              key={unread}
              className="tour-pop absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.75 text-[8.5px] font-semibold text-bg tabular-nums ring-[1.5px] ring-sidebar"
            >
              {unread}
            </span>
          )}
        </span>
        <span className="flex h-6.5 items-center gap-0.5 px-1 text-fg/90">
          <Plus size={14} />
          <ChevronDown size={10} className="text-faint" />
        </span>
        <span className="relative ml-0.5 flex">
          <Avatar name="priya" image={null} size={22} />
          <PresenceDot ring="var(--color-sidebar)" />
        </span>
      </span>
    </header>
  );
}

/**
 * The page's own bar under the app bar, as the app has it (components/shell.tsx):
 * a slim line with the sidebar's toggle when there is a sidebar, then where you
 * are, the workspace left out (the app bar names it).
 */
function PageBar({ crumbs, toggle }: { crumbs: { label: string; mono?: boolean }[]; toggle: boolean }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-bg px-2.5">
      {toggle && (
        <>
          <span className="flex size-6.5 items-center justify-center text-faint">
            <PanelLeft size={14} />
          </span>
          <span className="mx-1 h-3.5 w-px bg-line" />
        </>
      )}
      <span className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", !toggle && "pl-1")}>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.label}>
            {index > 0 && <span className="text-line-strong">/</span>}
            <span className={cn("truncate", index === crumbs.length - 1 ? "font-medium text-fg" : "text-muted", crumb.mono && "font-mono text-[11.5px]")}>
              {crumb.label}
            </span>
          </Fragment>
        ))}
      </span>
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
    <div
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-[12px]",
        on ? "bg-sidebar-accent font-medium text-fg" : bold ? "text-fg" : "text-muted",
        bold && "font-semibold",
      )}
    >
      {children}
    </div>
  );
}

/** The search at the top of Chat's sidebar, for its own list (the app bar's search is for everything). */
function SideSearch({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-7 items-center gap-2 rounded-md bg-surface px-2 text-[11px] text-faint ring-1 ring-line">
      <Search size={12} className="shrink-0" />
      <span className="grow truncate">{children}</span>
    </span>
  );
}

/* Chat ---------------------------------------------------------------- */

function ChatSide() {
  // As the app has it: direct messages with people, the latest first.
  const dms: { who: string; away?: boolean; status?: string }[] = [{ who: "Dana" }, { who: "Jordan" }, { who: "Alex", away: true, status: "🗓️" }];
  return (
    <>
      {/* Chat's own heading row (components/chat/sidebar.tsx): its name, quiet, then Do not disturb and New message. */}
      <div className="flex h-8 shrink-0 items-center justify-between pt-1 pr-1.5 pl-3">
        <span className="text-[9.5px] font-medium tracking-wide text-faint uppercase">Chat</span>
        <span className="flex items-center gap-1 text-faint">
          <span className="flex size-5.5 items-center justify-center">
            <BellOff size={12} />
          </span>
          <span className="flex size-5.5 items-center justify-center">
            <SquarePen size={13} />
          </span>
        </span>
      </div>
      <div className="space-y-2 px-2 pt-1.5">
        <SideSearch>Jump to channel or person</SideSearch>
        <span className="grid grid-cols-3 rounded-md bg-surface p-0.5 text-center text-[10px] font-medium ring-1 ring-line">
          <span className="rounded-sm bg-raised py-0.5 text-fg ring-1 ring-line-strong">All</span>
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
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden mask-[linear-gradient(to_bottom,transparent,black_2.5rem)] pb-1">
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
      {/* Under the app bar, Code's name is lit on its tab, so the sidebar opens straight on the project. */}
      <div className="px-2 pt-2">
        <div className="flex h-7 items-center gap-1 px-1 text-[12px] font-medium text-fg">
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
        {row(<ListTodo size={13} />, "Work", "12")}
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
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pb-2",
                on ? "border-accent font-medium text-fg" : "border-transparent text-muted",
              )}
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
              Exports loaded every row before sending the first byte, so big accounts hit the 60 s limit. Rows now stream in batches of 1,000. A 200,000-row
              account takes 3.1 s. Fixes the timeout Dana reported in <span className="text-accent">#web</span>.
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

/* Home ---------------------------------------------------------------- */

/** One of Home's cards (components/home.tsx Card): its title, a few words under it, then its rows. */
function HomeCard({ title, hint, link, children, className }: { title: ReactNode; hint?: string; link?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-line bg-surface", className)}>
      <header className="flex items-start gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-fg">{title}</p>
          {hint && <p className="mt-0.5 truncate text-[10.5px] text-muted">{hint}</p>}
        </div>
        {link && (
          <span className="ml-auto flex shrink-0 items-center gap-1 pt-0.5 text-[10.5px] text-muted">
            {link}
            <ArrowRight size={10} />
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

const HOME_ROW = "flex items-center gap-2.5 border-t border-line px-4 py-2";

/** What still waits on Priya once the notifications above settle: her pull request in review, and a review asked of her. */
const STAYING = [
  {
    icon: <GitPullRequest size={14} className="text-success" />,
    title: "Stream CSV exports in batches",
    detail: "acme/web #431 · Checks running · Dana is reviewing",
    stake: "Yours",
    action: "Open",
  },
  {
    icon: <GitPullRequest size={14} className="text-info" />,
    title: "Add audit log export",
    detail: "acme/web #435 · Your review",
    stake: "+212 −40",
    action: "Review",
  },
];

/** A row of Where you're needed that settles while you look: it says why, then leaves the list. */
function SettlingRow({ row, settled, cleared, index }: { row: (typeof SETTLED)[number]; settled: boolean; cleared: boolean; index: number }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-500 ease-out motion-reduce:transition-none",
        cleared ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn(HOME_ROW, index === 0 && "border-t-0", "transition-colors duration-500", settled && "bg-success/5")}>
          <span key={settled ? "done" : "open"} className="tour-pop shrink-0">
            {settled ? (
              <CheckCheck size={14} className="text-success" />
            ) : index === 0 ? (
              <Rocket size={14} className="text-danger" />
            ) : (
              <PlayCircle size={14} className="text-warn" />
            )}
          </span>
          <div className="min-w-0 grow">
            <p
              className={cn(
                "truncate text-[12px] font-semibold transition-colors duration-500",
                settled ? "text-muted line-through decoration-faint" : "text-fg",
              )}
            >
              {row.title}
            </p>
            <p key={settled ? "why" : "detail"} className={cn("tour-fade truncate text-[10.5px]", settled ? "text-success" : "text-muted")}>
              {settled ? `Settled · ${row.why}` : row.detail}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-md border border-line-strong px-2 py-1 text-[10.5px] text-fg transition-opacity duration-300",
              settled && "opacity-0",
            )}
          >
            {index === 0 ? "See the build" : "Look"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Where you're needed: the two notifications that settle themselves, then what is left for Priya. */
function NeededCard({ frame, phone }: { frame: Frame; phone?: boolean }) {
  return (
    <HomeCard title="Where you're needed" hint={phone ? undefined : "Everything waiting on you, however long ago it started"} link="Notifications">
      {SETTLED.map((row, index) => (
        <SettlingRow key={row.title} row={row} index={index} settled={frame.settled > index} cleared={frame.cleared > index} />
      ))}
      {STAYING.map((row, index) => (
        <div key={row.title} className={cn(HOME_ROW, index === 0 && frame.cleared >= SETTLED.length && "border-t-0")}>
          <span className="shrink-0">{row.icon}</span>
          <div className="min-w-0 grow">
            <p className="truncate text-[12px] font-semibold text-fg">{row.title}</p>
            <p className="truncate text-[10.5px] text-muted">{row.detail}</p>
          </div>
          {!phone && <span className="shrink-0 text-[10.5px] font-medium text-fg-soft">{row.stake}</span>}
          <span className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[10.5px] text-fg">{row.action}</span>
        </div>
      ))}
    </HomeCard>
  );
}

/** Start here: the deploy failure while it is open (it comes before anything else), then Priya's pull request. */
function StartCard({ frame }: { frame: Frame }) {
  const deploy = frame.settled === 0;
  const pick = deploy
    ? {
        icon: <Rocket size={14} className="text-danger" />,
        title: SETTLED[0].title,
        next: "See the build",
        why: "Production is serving an older build until this is fixed, so it comes before anything else.",
        button: "See the build",
      }
    : {
        icon: <GitPullRequest size={14} className="text-success" />,
        title: STAYING[0].title,
        next: "Lands when Dana approves",
        why: "Dana's report in #web is waiting on it. Once its checks pass and she approves, the merge queue lands it.",
        button: "Open pull request",
      };
  return (
    <HomeCard
      title={
        <>
          Start here <span className="font-normal text-faint">· picked by g1t</span>
        </>
      }
    >
      <div key={deploy ? "deploy" : "ready"} className="tour-in px-4 pb-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0">{pick.icon}</span>
          <p className="text-[12.5px] leading-snug font-semibold text-fg">{pick.title}</p>
        </div>
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10.5px]">
          <dt className="text-muted">Next</dt>
          <dd className="text-fg-soft">{pick.next}</dd>
          <dt className="text-muted">At stake</dt>
          <dd className={deploy ? "text-danger" : "text-fg-soft"}>{deploy ? "Production on an older build" : "Big accounts' exports time out"}</dd>
        </dl>
        <p className="mt-2.5 rounded-lg bg-raised/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-fg-soft">
          <span className="font-medium text-fg">Why this one: </span>
          {pick.why}
        </p>
        <span className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11.5px] font-medium text-bg">
          {pick.button}
          <ArrowRight size={12} />
        </span>
      </div>
    </HomeCard>
  );
}

/** What changed: Summarize, then g1t's answer streaming in, word by word, then Ask a follow-up. */
function WhatChangedCardMock({ frame }: { frame: Frame }) {
  const text = SUMMARY_WORDS.slice(0, frame.words).join(" ");
  return (
    <HomeCard title="What changed" hint="In plain English, since I was last here">
      <div className="px-4 pb-3.5">
        {!frame.summarizing ? (
          <div className="flex items-center gap-3">
            <p className="grow text-[11.5px] leading-relaxed text-muted">
              g1t reads the commits, pull requests, deploys and conversations since I was last here and tells you what changed, why, and what is live.
            </p>
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-bg">
              <Sparkles size={12} />
              Summarize
            </span>
          </div>
        ) : frame.words === 0 ? (
          <div className="tour-fade space-y-2">
            <p className="text-[11.5px] text-muted">Reading what happened…</p>
            <span className="tour-shimmer block h-2.5 w-11/12 rounded bg-raised" />
            <span className="tour-shimmer block h-2.5 w-3/4 rounded bg-raised" />
          </div>
        ) : (
          <>
            <p className="text-[12.5px] leading-[1.6] text-fg-soft">
              <Rich text={text} targets={{ "#431": "home-pr" }} />
              {!frame.summarized && <span className="tour-caret ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-[1px] bg-accent" />}
            </p>
            <div
              className={cn(
                "mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 transition-opacity duration-500",
                frame.summarized ? "opacity-100" : "opacity-0",
              )}
            >
              <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-accent/10 px-2 text-[10.5px] font-medium text-fg ring-1 ring-accent/20 ring-inset">
                <MarkGlyph className="h-2.5" />
                Ask a follow-up
              </span>
              <span className="inline-flex h-6 items-center gap-1.5 px-2 text-[10.5px] text-muted">
                <RotateCcw size={11} />
                Summarize again
              </span>
            </div>
          </>
        )}
      </div>
    </HomeCard>
  );
}

/** The chart's colour for each kind, as components/home.tsx gives it. */
const TOUR_FILL: Record<WorkKind, string> = {
  pushes: "bg-series-1",
  pulls: "bg-series-2",
  items: "bg-series-3",
  shipped: "bg-series-4",
  docs: "bg-series-5",
  chat: "bg-series-6",
};

/**
 * People: who did what overnight as the real card draws it (components/home.tsx
 * WhoChart): a row each for people and agents, a bar split by kind of work,
 * and the legend with the totals.
 */
function PeopleCardMock() {
  const rows: { name: string; agent: boolean; parts: Partial<Record<WorkKind, number>> }[] = [
    { name: "jordan", agent: false, parts: { pushes: 4, pulls: 2, items: 3, chat: 9 } },
    { name: "alex", agent: false, parts: { pulls: 3, items: 2, docs: 2, chat: 6 } },
    { name: "claude", agent: true, parts: { pushes: 6, pulls: 2 } },
    { name: "g1t", agent: true, parts: { shipped: 3, chat: 4 } },
  ];
  const legend: [WorkKind, string][] = [
    ["pushes", "23 commits to 2 projects"],
    ["pulls", "4 opened, 3 merged"],
    ["items", "3 opened, 2 closed"],
    ["shipped", "3 deploys"],
    ["docs", "2 docs edited"],
    ["chat", "19 messages in 4 conversations"],
  ];
  const total = (parts: Partial<Record<WorkKind, number>>) => Object.values(parts).reduce((a, b) => a + b, 0);
  const top = Math.max(...rows.map((row) => total(row.parts)));
  return (
    <HomeCard title="People" hint="2 people · 2 agents">
      <ul className="space-y-2 px-4 pb-3">
        {rows.map((row) => (
          <li key={row.name} className="grid grid-cols-[5.5rem_minmax(0,1fr)_1.5rem] items-center gap-2.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar name={row.name} size={16} agent={row.agent} ring="var(--color-surface)" />
              <span className="truncate text-[11.5px] text-fg">{row.name}</span>
            </span>
            <span className="flex h-2 gap-0.5 overflow-hidden rounded-full" style={{ width: `${(total(row.parts) / top) * 100}%` }}>
              {WORK_KINDS.filter((kind) => row.parts[kind]).map((kind) => (
                <span key={kind} className={cn("h-full", TOUR_FILL[kind])} style={{ flexGrow: row.parts[kind] }} />
              ))}
            </span>
            <span className="text-right text-[10.5px] text-muted tabular-nums">{total(row.parts)}</span>
          </li>
        ))}
      </ul>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line px-4 py-2.5">
        {legend.map(([kind, text]) => (
          <li key={kind} className="flex min-w-0 items-center gap-1.5 text-[10.5px]">
            <span className={cn("size-2 shrink-0 rounded-[2px]", TOUR_FILL[kind])} />
            <span className="truncate">
              <span className="font-medium text-fg">{WORK_LABEL[kind]}</span> <span className="text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ul>
    </HomeCard>
  );
}

/** Landed: each change that came in overnight with whether it is live, the agent's mark on the one it helped make, and Explain. */
function LandedCardMock() {
  const rows = [
    { title: "Pin the build image's cache key", detail: "web · 1 push by jordan", agent: false, live: "Live 4 min after push", at: "8:15 AM" },
    { title: "Retry webhook deliveries with backoff", detail: "web#433 · by alex", agent: true, live: "Live 6 min after merge", at: "7:52 AM" },
  ];
  return (
    <HomeCard title="Landed" hint="1 pull request merged · 1 push">
      {rows.map((row) => (
        <div key={row.title} className={HOME_ROW}>
          <span className="shrink-0">
            {row.agent ? <GitMerge size={14} className="text-merged" /> : <GitCommitHorizontal size={14} className="text-muted" />}
          </span>
          <div className="min-w-0 grow">
            <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg">
              <span className="truncate">{row.title}</span>
              {row.agent && <AgentMark agent={CLAUDE} size={12} />}
            </p>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-[10.5px] text-muted">{row.detail}</span>
              <Badge tone="success">
                <Rocket size={9} />
                {row.live}
              </Badge>
            </div>
          </div>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted">
            <Sparkles size={12} />
          </span>
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{row.at}</span>
        </div>
      ))}
    </HomeCard>
  );
}

/**
 * Home, as Priya starts her day on it (routes/workspace/home.tsx): "What are
 * we building today?" over the box that asks g1t, Where you're needed
 * beside Start here, then Since you were last here with What changed,
 * People (who did what, agents beside people) and Landed. Pressing the first starter brings What changed into view, as the
 * real one does, and its answer streams in.
 */
function HomeMain({ frame, phone = false }: { frame: Frame; phone?: boolean }) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const since = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  // Measured again as the answer grows, so the page follows it down as it streams in.
  const grown = Math.floor(frame.words / 12);
  useIsoLayoutEffect(() => {
    if (!frame.summarizing) {
      setOffset(0);
      return;
    }
    const view = viewport.current;
    const body = content.current;
    const mark = since.current;
    if (!view || !body || !mark) return;
    setOffset(Math.max(0, Math.min(mark.offsetTop - 14, body.scrollHeight - view.clientHeight)));
  }, [frame.summarizing, grown, frame.summarized]);
  const starters = phone ? ["What needs me first?"] : ["What needs me first?", "What shipped today?", "Who's working on what?"];
  return (
    <div ref={viewport} className="h-full overflow-hidden">
      <div
        ref={content}
        className={cn(
          "relative transition-transform duration-1000 ease-[cubic-bezier(.45,.05,.2,1)] motion-reduce:transition-none",
          phone ? "space-y-3 px-3 pt-4 pb-4" : "space-y-4 px-6 pt-5 pb-6",
        )}
        style={{ transform: offset ? `translateY(${-offset}px)` : undefined }}
      >
        <div className={cn("mx-auto flex flex-col items-center", phone ? "gap-2.5" : "max-w-xl gap-3")}>
          <p className={cn("text-center font-semibold tracking-tight text-fg", phone ? "text-[17px]" : "text-[21px]")}>What are we building today?</p>
          <div className="flex w-full items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 pl-3 shadow-sm">
            <MarkGlyph className="h-3.5 shrink-0" />
            <span className="min-w-0 grow truncate text-[12px] text-faint">Ask g1t what changed, what&apos;s blocked, or what to do next</span>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-bg opacity-50">
              <ArrowUp size={13} />
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            <span
              data-tour="home-summarize"
              className={cn(
                "rounded-full border px-2.5 py-1 text-[10.5px] text-fg transition-colors duration-300",
                frame.summarizing ? "border-accent bg-accent/15" : "border-accent-dim",
              )}
            >
              Summarize what changed since I was last here
            </span>
            {starters.map((label) => (
              <span key={label} className="rounded-full border border-line px-2.5 py-1 text-[10.5px] text-fg-soft">
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className={cn("grid items-start gap-3", !phone && "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4")}>
          <NeededCard frame={frame} phone={phone} />
          <StartCard frame={frame} />
        </div>

        <div ref={since} className="flex items-baseline gap-2.5 pt-1">
          <p className={cn("font-semibold tracking-tight text-fg", phone ? "text-[14px]" : "text-[15px]")}>Since you were last here</p>
          <p className="truncate text-[11px] text-muted">Yesterday at 6:12 PM · 15 hours</p>
        </div>
        <WhatChangedCardMock frame={frame} />
        <PeopleCardMock />
        <LandedCardMock />
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
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-20 transition-[transform,opacity] duration-900 ease-[cubic-bezier(.45,.05,.2,1)]",
        frame.cursorShown ? "opacity-100" : "opacity-0",
      )}
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

const SIDES: Record<Scene, ((props: { frame: Frame }) => ReactNode) | null> = {
  code: CodeSide,
  session: CodeSide,
  home: null,
  chat: ChatSide,
};

/** Where each page is, as the page's bar says it: the trail starts after the workspace, which the app bar names. */
const CRUMBS: Record<Scene, { label: string; mono?: boolean }[]> = {
  chat: [{ label: "Chat" }],
  code: [{ label: "web", mono: true }, { label: "Pull request #431" }],
  session: [{ label: "web", mono: true }, { label: "Pull request #431" }],
  home: [{ label: "Home" }],
};

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
  const scenes: Scene[] = ["home", "code", "session", "chat"];
  const mains: Record<Scene, ReactNode> = {
    chat: <ChatMain frame={frame} />,
    session: <SessionMain frame={frame} />,
    code: <CodeMain frame={frame} />,
    home: <HomeMain frame={frame} />,
  };
  return (
    <div
      ref={outer}
      className="relative w-full overflow-hidden rounded-2xl text-fg shadow-2xl shadow-black/50 ring-1 ring-line scheme-dark"
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      <div
        ref={canvas}
        className="absolute top-0 left-0 flex origin-top-left flex-col bg-bg text-left"
        style={{ width: W, height: H, transform: scale === 1 ? undefined : `scale(${scale})` } as CSSProperties}
      >
        {/* The app bar stays as the scenes change under it, so only its filled tab moves. */}
        <AppBar frame={frame} />
        <div className="relative min-h-0 flex-1">
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
                {Side && (
                  <div className="flex w-52 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
                    <Side frame={frame} />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <PageBar crumbs={crumbs} toggle={!!Side} />
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
  home: { icon: <House size={14} />, label: "Home" },
};

/** The phone's tab bar, as the app has it (components/mobile.tsx). */
const TABS: { scenes: Scene[]; icon: ReactNode; label: string }[] = [
  { scenes: ["home"], icon: <House size={16} />, label: "Home" },
  { scenes: [], icon: <ListTodo size={16} />, label: "Work" },
  { scenes: ["chat"], icon: <MessagesSquare size={16} />, label: "Chat" },
  { scenes: [], icon: <Bell size={16} />, label: "Notifications" },
  // Code is the first of More's tiles on a phone.
  { scenes: ["code", "session"], icon: <Ellipsis size={16} />, label: "More" },
];

function Phone({ frame }: { frame: Frame }) {
  const scenes: Scene[] = ["home", "code", "session", "chat"];
  return (
    <div className="relative flex h-136 w-full flex-col overflow-hidden rounded-2xl bg-bg text-left text-fg shadow-2xl shadow-black/50 ring-1 ring-line scheme-dark">
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
              {scene === "home" && <HomeMain frame={frame} phone />}
            </div>
          );
        })}
      </div>
      {/* Inside a conversation the tab bar steps aside, as it does on a phone. */}
      {frame.scene !== "chat" && (
        <div className="grid h-12 shrink-0 grid-cols-5 border-t border-line bg-[#0b0b0d]">
          {TABS.map((tab) => {
            const on = tab.scenes.includes(frame.scene);
            return (
              <span key={tab.label} className="flex flex-col items-center justify-center gap-0.5">
                <span className={cn("flex h-6 w-10 items-center justify-center rounded-full", on ? "bg-[#2c2c33] text-[#ededef]" : "text-muted")}>
                  {tab.icon}
                </span>
                <span className={cn("text-[9.5px] font-medium", on ? "text-[#ededef]" : "text-faint")}>{tab.label}</span>
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
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden mask-[linear-gradient(to_bottom,transparent,black_2.5rem)] [&>div]:px-3">
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
      <pre
        className={cn(
          "overflow-hidden rounded-xl border border-line bg-surface py-1.5 font-mono text-[10.5px] leading-[1.7] transition-opacity duration-500",
          frame.diff ? "opacity-100" : "opacity-0",
        )}
      >
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
.tour-caret { animation: tour-caret 1s steps(1) infinite; }
@keyframes tour-caret { 50% { opacity: 0; } }
.tour-shimmer { animation: tour-shimmer 1.2s ease-in-out infinite; }
@keyframes tour-shimmer { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  .tour-in, .tour-pop, .tour-fade, .tour-spin, .tour-caret, .tour-shimmer { animation: none; }
}
`;

/**
 * The hero's tour: the frame (a full app on wider screens, one pane on a
 * phone) and the step pills under it.
 */
export function ProductTour({ className }: { className?: string }) {
  const clock = useTourClock();
  const { frame } = clock;
  return (
    <div ref={clock.rootRef} className={className}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div
        role="img"
        aria-label="A tour of g1t: on Home, notifications that settled themselves overnight leave Where you're needed, Start here picks the pull request in review, and What changed sums up in plain English what landed and that it is live. The pull request then passes its checks, is approved and is merged by the merge queue, and the session from the coding agent that helped write it is replayed. Then the team hears it shipped in a channel."
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
      <div className="mx-auto mt-4 grid max-w-xl grid-cols-4 gap-2" role="tablist" aria-label="Steps of the tour">
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
              <span className="relative flex items-center justify-center gap-1.5">{pill.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
