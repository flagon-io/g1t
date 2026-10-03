import {
  Check,
  CircleDashed,
  Eye,
  Hand,
  Layers,
  Lock,
  Loader2,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import type { IssueProgress, Plan } from "@g1t/contracts";

import { Avatar } from "./ui";

type Look = { label: string; icon: ReactNode; ring: string; text: string; bar: string; live?: boolean };

/** How each state looks: its colour, icon and a word for it. */
const LOOK: Record<string, Look> = {
  blocked: {
    label: "Blocked",
    icon: <Lock size={13} />,
    ring: "ring-line border-dashed",
    text: "text-faint",
    bar: "bg-line-strong",
  },
  open: { label: "Open", icon: <CircleDashed size={13} />, ring: "ring-line", text: "text-muted", bar: "bg-line-strong" },
  waiting: {
    label: "Waiting for an agent",
    icon: <CircleDashed size={13} />,
    ring: "ring-line-strong",
    text: "text-muted",
    bar: "bg-faint",
  },
  working: {
    label: "Agent working",
    icon: <Sparkles size={13} />,
    ring: "ring-merged/60",
    text: "text-merged",
    bar: "bg-merged",
    live: true,
  },
  revising: {
    label: "Revising",
    icon: <Sparkles size={13} />,
    ring: "ring-merged/60",
    text: "text-merged",
    bar: "bg-merged",
    live: true,
  },
  answering: {
    label: "Answering an agent",
    icon: <Sparkles size={13} />,
    ring: "ring-merged/60",
    text: "text-merged",
    bar: "bg-merged",
    live: true,
  },
  catching_up: {
    label: "Catching up",
    icon: <Loader2 size={13} className="animate-spin" />,
    ring: "ring-merged/60",
    text: "text-merged",
    bar: "bg-merged",
    live: true,
  },
  checking: {
    label: "Checking",
    icon: <Terminal size={13} />,
    ring: "ring-info/60",
    text: "text-info",
    bar: "bg-info",
    live: true,
  },
  reviewing: {
    label: "In review",
    icon: <Eye size={13} />,
    ring: "ring-info/60",
    text: "text-info",
    bar: "bg-info",
    live: true,
  },
  queued: {
    label: "In the merge queue",
    icon: <Layers size={13} />,
    ring: "ring-accent/60",
    text: "text-accent",
    bar: "bg-accent/60",
    live: true,
  },
  ready: { label: "Ready to merge", icon: <Check size={13} />, ring: "ring-accent/60", text: "text-accent", bar: "bg-accent/60" },
  needs_you: { label: "Needs you", icon: <Hand size={13} />, ring: "ring-warn/70", text: "text-warn", bar: "bg-warn" },
  landed: { label: "Landed", icon: <Check size={13} />, ring: "ring-accent/30", text: "text-accent", bar: "bg-accent" },
  closed: { label: "Closed", icon: <X size={13} />, ring: "ring-line", text: "text-faint", bar: "bg-line" },
};

const look = (state: string) => LOOK[state] ?? LOOK.open!;

/** Columns by how deep each issue sits in the plan's dependencies. */
function columns(plan: Plan): { position: number; item: IssueProgress }[][] {
  const byNumber = new Map(plan.progress.map((item) => [item.number, item]));
  const depth = new Map<number, number>();
  const depthOf = (position: number, seen = new Set<number>()): number => {
    if (depth.has(position)) return depth.get(position)!;
    if (seen.has(position)) return 0;
    seen.add(position);
    const deps = plan.issues[position - 1]?.dependsOn ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)));
    depth.set(position, value);
    return value;
  };
  const result: { position: number; item: IssueProgress }[][] = [];
  plan.issues.forEach((issue, index) => {
    const item = issue.number != null ? byNumber.get(issue.number) : undefined;
    if (!item) return;
    const column = depthOf(index + 1);
    (result[column] ??= []).push({ position: index + 1, item });
  });
  return result.filter(Boolean);
}

function Node({ item, base }: { item: IssueProgress; base: string }) {
  const style = look(item.state);
  const to = item.pull != null ? `${base}/pull/${item.pull}` : `${base}/issues/${item.number}`;
  return (
    <Link
      to={to}
      prefetch="intent"
      data-node={item.number}
      className={`group relative block rounded-2xl border border-transparent bg-surface p-4 ring-1 transition-all hover:-translate-y-0.5 hover:bg-raised ${style.ring}`}
    >
      {style.live && (
        <span aria-hidden="true" className={`absolute top-3 right-3 size-2 animate-pulse rounded-full ${style.bar}`} />
      )}
      <p className={`flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
        {style.icon}
        {style.label}
      </p>
      <p className={`mt-2 text-sm leading-snug font-medium ${item.state === "closed" ? "text-faint line-through" : ""}`}>
        {item.title} <span className="font-normal text-faint">#{item.number}</span>
      </p>
      {item.detail && <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted">{item.detail}</p>}
      {item.agent && (
        <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[0.6875rem] text-faint">
          <Avatar name={item.agent} size={14} />
          {item.agent}
          {item.pull != null && <span>· #{item.pull}</span>}
        </p>
      )}
    </Link>
  );
}

/** Lines from each issue to the ones that depend on it, measured from the page. */
function Edges({ plan, container }: { plan: Plan; container: React.RefObject<HTMLDivElement | null> }) {
  const [paths, setPaths] = useState<{ d: string; done: boolean }[]>([]);
  // After commit, when the graph's own ref is attached: a child's layout
  // effect runs before its parent's ref is set.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const draw = () => {
      const box = element.getBoundingClientRect();
      const at = (number: number) =>
        element.querySelector<HTMLElement>(`[data-node="${number}"]`)?.getBoundingClientRect();
      const next: { d: string; done: boolean }[] = [];
      plan.issues.forEach((issue) => {
        if (issue.number == null) return;
        const to = at(issue.number);
        for (const dep of issue.dependsOn) {
          const fromNumber = plan.issues[dep - 1]?.number;
          if (fromNumber == null) continue;
          const from = at(fromNumber);
          if (!from || !to) continue;
          const x1 = from.right - box.left;
          const y1 = from.top + from.height / 2 - box.top;
          const x2 = to.left - box.left;
          const y2 = to.top + to.height / 2 - box.top;
          const mid = (x1 + x2) / 2;
          const done = plan.progress.find((item) => item.number === fromNumber)?.state === "landed";
          next.push({ d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, done });
        }
      });
      setPaths(next);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [plan, container]);
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
      {paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill="none"
          stroke={path.done ? "var(--color-accent)" : "var(--color-line-strong)"}
          strokeOpacity={path.done ? 0.7 : 1}
          strokeWidth={1.5}
          strokeDasharray={path.done ? undefined : "4 5"}
          className={path.done ? undefined : "art-flow"}
        />
      ))}
    </svg>
  );
}

/**
 * An outcome being converged: the plan's issues as a graph, each showing
 * where it stands now, and how far the whole has come.
 */
export function Outcome({ plan, base, costMicros }: { plan: Plan; base: string; costMicros: number | null }) {
  const graph = useRef<HTMLDivElement>(null);
  const total = plan.progress.length;
  const count = (states: string[]) => plan.progress.filter((item) => states.includes(item.state)).length;
  const landed = count(["landed"]);
  const live = plan.progress.filter((item) => look(item.state).live).length;
  const needsYou = count(["needs_you"]);
  const blocked = count(["blocked", "waiting", "open"]);
  const order = ["landed", "queued", "ready", "reviewing", "checking", "working", "revising", "catching_up", "answering", "needs_you", "waiting", "blocked", "open", "closed"];
  const sorted = [...plan.progress].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ["Landed", `${landed} of ${total}`, "text-accent"],
          ["Agents at work", String(live), "text-merged"],
          ["Needs you", String(needsYou), needsYou > 0 ? "text-warn" : "text-muted"],
          [
            "Agents have cost",
            costMicros == null ? "—" : `$${(costMicros / 1_000_000).toFixed(2)}`,
            "text-fg",
          ],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-2xl bg-surface px-4 py-3 ring-1 ring-line">
            <p className="text-xs text-muted">{label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
          </div>
        ))}
      </div>
      {/* Every issue, as one bar. */}
      <div className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${landed} of ${total} landed`}>
        {sorted.map((item) => (
          <span key={item.number} className={`grow transition-colors duration-700 ${look(item.state).bar}`} />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {landed === total
          ? "Everything in the plan has landed."
          : `${live} in flight, ${blocked} waiting their turn${needsYou ? `, ${needsYou} waiting on you` : ""}.`}
      </p>

      {columns(plan).length === 1 ? (
        // Nothing depends on anything: every issue starts at once, side by side.
        <div className="mt-10">
          <p className="font-mono text-[0.6875rem] tracking-[0.2em] text-faint uppercase">
            All start at once
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {columns(plan)[0]!.map(({ item }) => (
              <Node key={item.number} item={item} base={base} />
            ))}
          </div>
        </div>
      ) : (
      <div className="mt-10 overflow-x-auto pb-4">
        <div ref={graph} className="relative flex min-w-max gap-14">
          <Edges plan={plan} container={graph} />
          {columns(plan).map((column, index) => (
            <div key={index} className="flex w-64 flex-col justify-center gap-4">
              <p className="font-mono text-[0.6875rem] tracking-[0.2em] text-faint uppercase">
                {index === 0 ? "Starts at once" : `Then, step ${index + 1}`}
              </p>
              {column.map(({ item }) => (
                <Node key={item.number} item={item} base={base} />
              ))}
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}
