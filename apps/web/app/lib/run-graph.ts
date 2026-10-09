import type { Conclusion, Job } from "@g1t/contracts";

/**
 * A run's jobs as a graph: grouped (a matrix's jobs into one node, a called
 * workflow's jobs into a box under the job that calls it), placed in
 * columns by how deep their `needs` go, ordered within a column so fewer
 * connectors cross, and joined by connectors. Pure, so the run page draws
 * it again from each refresh of its data.
 */

/** What the graph reads of a job. */
export type GraphJob = Pick<Job, "id" | "key" | "name" | "needs" | "status" | "conclusion" | "startedAt" | "finishedAt"> &
  Partial<Pick<Job, "environment" | "environmentUrl" | "uses">>;

/** Where a node or a group stands, as the status icon shows it. */
export type Standing = { status: Job["status"]; conclusion: Conclusion | null };

/** One job; a matrix's jobs (one key, several jobs); or a job calling a workflow, with that workflow's jobs. */
export type Unit =
  | { kind: "job"; key: string; label: string; needs: string[]; job: GraphJob }
  | { kind: "matrix"; key: string; label: string; needs: string[]; jobs: GraphJob[] }
  | { kind: "call"; key: string; label: string; needs: string[]; uses: string | null; callers: GraphJob[]; units: Unit[] };

/** Sizes, in pixels. */
export const GRAPH = {
  nodeWidth: 220,
  nodeHeight: 44,
  /** The line a deployment's address takes. */
  urlHeight: 18,
  /** A matrix's job, listed in its expanded node. */
  rowHeight: 32,
  columnGap: 48,
  rowGap: 16,
  groupPad: 12,
  groupHead: 32,
  margin: 16,
} as const;

/** `test` from `test (ubuntu-latest, 20)`. */
export function baseName(name: string): string {
  return name.replace(/\s*\([^()]*\)$/, "") || name;
}

/** A called workflow's job by its own name: `test`, not `build / test`. */
function within(name: string, parent: string | null): string {
  return parent && name.startsWith(`${parent} / `) ? name.slice(parent.length + 3) : name;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The run's jobs as units, in the order they were listed. A called
 * workflow's jobs have keys under their caller's (`build/test`), and a
 * matrix's jobs share their key.
 */
export function groupJobs(jobs: GraphJob[], prefix = "", parent: string | null = null): Unit[] {
  const order: string[] = [];
  const direct = new Map<string, GraphJob[]>();
  const nested = new Map<string, GraphJob[]>();
  for (const job of jobs) {
    if (!job.key.startsWith(prefix)) continue;
    const rest = job.key.slice(prefix.length);
    if (!rest) continue;
    const segment = rest.split("/")[0]!;
    const key = prefix + segment;
    if (!direct.has(key)) {
      order.push(key);
      direct.set(key, []);
      nested.set(key, []);
    }
    (rest === segment ? direct : nested).get(key)!.push(job);
  }
  return order.map((key): Unit => {
    const own = direct.get(key)!;
    const inner = nested.get(key)!;
    const needs = unique(own.flatMap((job) => job.needs));
    const label = own.length > 0 ? within(own.length > 1 ? baseName(own[0]!.name) : own[0]!.name, parent) : key.slice(prefix.length);
    if (inner.length > 0 || own.some((job) => job.uses)) {
      const callerName = own.length > 0 ? (own.length > 1 ? baseName(own[0]!.name) : own[0]!.name) : label;
      return {
        kind: "call",
        key,
        label,
        needs,
        uses: own.find((job) => job.uses)?.uses ?? null,
        callers: own,
        units: groupJobs(inner, `${key}/`, callerName),
      };
    }
    if (own.length > 1) return { kind: "matrix", key, label, needs, jobs: own };
    return { kind: "job", key, label, needs, job: own[0]! };
  });
}

/** Every job of a unit, its called workflow's included. */
export function jobsOf(unit: Unit): GraphJob[] {
  if (unit.kind === "job") return [unit.job];
  if (unit.kind === "matrix") return unit.jobs;
  return [...unit.callers, ...unit.units.flatMap(jobsOf)];
}

/** Where several jobs stand together: running while any runs, else the worst way any ended. */
export function standingOf(jobs: GraphJob[]): Standing {
  if (jobs.length === 0) return { status: "waiting", conclusion: null };
  if (jobs.every((job) => job.status === "completed")) {
    const ended = jobs.map((job) => job.conclusion);
    const conclusion: Conclusion = ended.includes("failure")
      ? "failure"
      : ended.includes("cancelled")
        ? "cancelled"
        : ended.includes("success")
          ? "success"
          : "skipped";
    return { status: "completed", conclusion };
  }
  const has = (status: Job["status"]) => jobs.some((job) => job.status === status);
  if (has("in_progress") || has("calling")) return { status: "in_progress", conclusion: null };
  if (has("pending")) return { status: "pending", conclusion: null };
  if (has("queued")) return { status: "queued", conclusion: null };
  return { status: "waiting", conclusion: null };
}

/** A unit's standing; a called workflow's is its caller's while it has one. */
export function unitStanding(unit: Unit): Standing {
  if (unit.kind === "call" && unit.callers.length > 0) return standingOf(unit.callers);
  return standingOf(jobsOf(unit));
}

/**
 * Each unit's column: the longest path of `needs` from a unit needing
 * nothing. Needs of keys not among `units` are left out, and so is a need
 * that would close a cycle (a workflow cannot have one, but the graph does
 * not trust that).
 */
export function columns(units: Unit[]): Map<string, number> {
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    let column = 0;
    for (const need of byKey.get(key)!.needs) {
      if (need === key || !byKey.has(need)) continue;
      const before = visit(need);
      if (before >= 0) column = Math.max(column, before + 1);
    }
    visiting.delete(key);
    depth.set(key, column);
    return column;
  };
  for (const unit of units) visit(unit.key);
  return depth;
}

/** The connectors of one level: from a need to what needs it, never backwards. */
function links(units: Unit[], column: Map<string, number>): [string, string][] {
  const out: [string, string][] = [];
  for (const unit of units)
    for (const need of unique(unit.needs))
      if (need !== unit.key && column.has(need) && column.get(need)! < column.get(unit.key)!) out.push([need, unit.key]);
  return out;
}

/**
 * How many pairs of connectors cross, counting pairs that run between the
 * same two columns.
 */
export function crossings(order: string[][], edges: [string, string][]): number {
  const at = new Map<string, [number, number]>();
  order.forEach((keys, column) => keys.forEach((key, row) => at.set(key, [column, row])));
  let count = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i]!.map((key) => at.get(key)!);
      const [c, d] = edges[j]!.map((key) => at.get(key)!);
      if (a![0] !== c![0] || b![0] !== d![0]) continue;
      if ((a![1] - c![1]) * (b![1] - d![1]) < 0) count++;
    }
  return count;
}

/**
 * Units per column, top to bottom: first as listed, then sorted by the
 * mean row of what they need (sweeping right) and of what needs them
 * (sweeping left), a few times, keeping the order with the fewest
 * crossings.
 */
export function orderColumns(units: Unit[], column: Map<string, number>, sweeps = 4): string[][] {
  const count = units.length === 0 ? 0 : Math.max(...column.values()) + 1;
  let order: string[][] = Array.from({ length: count }, () => []);
  for (const unit of units) order[column.get(unit.key)!]!.push(unit.key);
  const edges = links(units, column);
  const needsOf = new Map<string, string[]>();
  const neededBy = new Map<string, string[]>();
  for (const [from, to] of edges) {
    needsOf.set(to, [...(needsOf.get(to) ?? []), from]);
    neededBy.set(from, [...(neededBy.get(from) ?? []), to]);
  }
  let best = order.map((keys) => [...keys]);
  let fewest = crossings(best, edges);
  const rowOf = () => {
    const rows = new Map<string, number>();
    order.forEach((keys) => keys.forEach((key, row) => rows.set(key, row)));
    return rows;
  };
  const sortBy = (keys: string[], others: Map<string, string[]>, rows: Map<string, number>) => {
    const centre = (key: string, index: number) => {
      const near = others.get(key) ?? [];
      return near.length === 0 ? index : near.reduce((sum, other) => sum + rows.get(other)!, 0) / near.length;
    };
    return keys
      .map((key, index) => ({ key, index, at: centre(key, index) }))
      .sort((x, y) => x.at - y.at || x.index - y.index)
      .map(({ key }) => key);
  };
  for (let sweep = 0; sweep < sweeps && fewest > 0; sweep++) {
    const right = sweep % 2 === 0;
    const range = right ? [...order.keys()].slice(1) : [...order.keys()].reverse().slice(1);
    for (const index of range) order[index] = sortBy(order[index]!, right ? needsOf : neededBy, rowOf());
    const now = crossings(order, edges);
    if (now < fewest) {
      fewest = now;
      best = order.map((keys) => [...keys]);
    }
  }
  return best;
}

/** A placed node: a job, or a matrix's jobs. */
export type PlacedNode = {
  unit: Extract<Unit, { kind: "job" | "matrix" }>;
  x: number;
  y: number;
  w: number;
  h: number;
  expanded: boolean;
};

/** A placed box: a job calling a workflow, its jobs inside. */
export type PlacedGroup = { unit: Extract<Unit, { kind: "call" }>; x: number; y: number; w: number; h: number };

/**
 * `failed`: from a unit that failed. `active`: to a unit running now.
 * `idle`: the rest.
 */
export type EdgeState = "idle" | "active" | "failed";
export type PlacedEdge = { from: string; to: string; path: string; state: EdgeState };

export type GraphLayout = { width: number; height: number; nodes: PlacedNode[]; groups: PlacedGroup[]; edges: PlacedEdge[] };

type Level = { width: number; height: number; nodes: PlacedNode[]; groups: PlacedGroup[]; edges: PlacedEdge[] };

/** A job node's height: taller with a deployment's address. */
function jobHeight(job: GraphJob): number {
  return GRAPH.nodeHeight + (job.environmentUrl ? GRAPH.urlHeight : 0);
}

/** The address a matrix's jobs all deploy to, when they share one. */
export function sharedUrl(jobs: GraphJob[]): string | null {
  const url = jobs[0]?.environmentUrl ?? null;
  return url && jobs.every((job) => job.environmentUrl === url) ? url : null;
}

/** A rounded right-angled connector from a node's right edge to another's left. */
export function connector(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y1 - y2) < 0.5) return `M${x1} ${y1}H${x2}`;
  // Turn in the gap before the target, so the connector leaves at its source's row.
  const mx = Math.max(x1 + 8, x2 - GRAPH.columnGap / 2);
  const r = Math.min(8, Math.abs(y2 - y1) / 2, mx - x1, x2 - mx);
  const down = y2 > y1 ? 1 : -1;
  return [
    `M${x1} ${y1}`,
    `H${mx - r}`,
    `Q${mx} ${y1} ${mx} ${y1 + down * r}`,
    `V${y2 - down * r}`,
    `Q${mx} ${y2} ${mx + r} ${y2}`,
    `H${x2}`,
  ].join("");
}

function edgeState(from: Unit, to: Unit): EdgeState {
  const source = unitStanding(from);
  if (source.status === "completed" && source.conclusion === "failure") return "failed";
  const target = unitStanding(to);
  if (source.status === "completed" && target.status === "in_progress") return "active";
  return "idle";
}

function place(units: Unit[], expanded: ReadonlySet<string>, ox: number, oy: number): Level {
  const column = columns(units);
  const order = orderColumns(units, column);
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const level: Level = { width: 0, height: 0, nodes: [], groups: [], edges: [] };
  // Each unit's size; a called workflow's box holds its own level.
  const size = (unit: Unit): [number, number] => {
    if (unit.kind === "job") return [GRAPH.nodeWidth, jobHeight(unit.job)];
    if (unit.kind === "matrix")
      return [
        GRAPH.nodeWidth,
        GRAPH.nodeHeight + (sharedUrl(unit.jobs) ? GRAPH.urlHeight : 0) + (expanded.has(unit.key) ? unit.jobs.length * GRAPH.rowHeight + 6 : 0),
      ];
    const content = place(unit.units, expanded, 0, 0);
    return [Math.max(GRAPH.nodeWidth, content.width) + GRAPH.groupPad * 2, GRAPH.groupHead + content.height + GRAPH.groupPad];
  };
  const sizes = new Map(units.map((unit) => [unit.key, size(unit)]));
  const box = new Map<string, { x: number; y: number; w: number; h: number }>();
  let x = ox;
  for (const keys of order) {
    let y = oy;
    let widest = 0;
    for (const key of keys) {
      const [w, h] = sizes.get(key)!;
      box.set(key, { x, y, w, h });
      y += h + GRAPH.rowGap;
      widest = Math.max(widest, w);
    }
    level.height = Math.max(level.height, y - GRAPH.rowGap - oy);
    x += widest + GRAPH.columnGap;
  }
  level.width = Math.max(0, x - GRAPH.columnGap - ox);
  for (const unit of units) {
    const at = box.get(unit.key)!;
    if (unit.kind === "call") {
      level.groups.push({ unit, ...at });
      // Its jobs, moved into its box.
      const content = place(unit.units, expanded, at.x + GRAPH.groupPad, at.y + GRAPH.groupHead);
      level.nodes.push(...content.nodes);
      level.groups.push(...content.groups);
      level.edges.push(...content.edges);
    } else {
      level.nodes.push({ unit, ...at, expanded: unit.kind === "matrix" && expanded.has(unit.key) });
    }
  }
  for (const [from, to] of links(units, column)) {
    const a = box.get(from)!;
    const b = box.get(to)!;
    // Connectors meet a node at the middle of its first line.
    const anchor = GRAPH.nodeHeight / 2;
    level.edges.push({ from, to, path: connector(a.x + a.w, a.y + anchor, b.x, b.y + anchor), state: edgeState(byKey.get(from)!, byKey.get(to)!) });
  }
  return level;
}

/** The whole graph, placed: `expanded` names the matrices shown open. */
export function layoutRun(jobs: GraphJob[], expanded: ReadonlySet<string> = new Set()): GraphLayout {
  const level = place(groupJobs(jobs), expanded, GRAPH.margin, GRAPH.margin);
  return {
    width: level.width + GRAPH.margin * 2,
    height: level.height + GRAPH.margin * 2,
    nodes: level.nodes,
    groups: level.groups,
    edges: level.edges,
  };
}
