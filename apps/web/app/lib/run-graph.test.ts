import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GRAPH,
  type GraphJob,
  baseName,
  columns,
  connector,
  crossings,
  groupJobs,
  layoutRun,
  orderColumns,
  standingOf,
} from "./run-graph.ts";

let next = 0;
function job(key: string, needs: string[] = [], more: Partial<GraphJob> = {}): GraphJob {
  return {
    id: `job_${next++}`,
    key,
    name: key,
    needs,
    status: "completed",
    conclusion: "success",
    startedAt: null,
    finishedAt: null,
    ...more,
  };
}

test("columns go by the longest path of needs", () => {
  const units = groupJobs([job("lint"), job("build"), job("test", ["build"]), job("deploy", ["build", "test"])]);
  const column = columns(units);
  assert.deepEqual(Object.fromEntries(column), { lint: 0, build: 0, test: 1, deploy: 2 });
});

test("a need of a job not in the run is left out", () => {
  const column = columns(groupJobs([job("a", ["gone"]), job("b", ["a"])]));
  assert.deepEqual(Object.fromEntries(column), { a: 0, b: 1 });
});

test("a cycle cannot loop the layout", () => {
  const jobs = [job("a", ["b"]), job("b", ["a"]), job("c", ["c"])];
  const column = columns(groupJobs(jobs));
  for (const value of column.values()) assert.ok(Number.isFinite(value) && value >= 0);
  const layout = layoutRun(jobs);
  // Never a connector going back a column.
  assert.ok(layout.edges.length <= 1);
  for (const edge of layout.edges) assert.ok(column.get(edge.from)! < column.get(edge.to)!);
});

test("ordering a column by its needs takes out a crossing", () => {
  // As listed: a, b over x, y, with x needing b and y needing a: they cross.
  const units = groupJobs([job("a"), job("b"), job("x", ["b"]), job("y", ["a"])]);
  const column = columns(units);
  const edges: [string, string][] = [
    ["b", "x"],
    ["a", "y"],
  ];
  assert.equal(crossings([["a", "b"], ["x", "y"]], edges), 1);
  const order = orderColumns(units, column);
  assert.deepEqual(order, [
    ["a", "b"],
    ["y", "x"],
  ]);
  assert.equal(crossings(order, edges), 0);
});

test("ordering keeps the order as listed when nothing crosses", () => {
  const units = groupJobs([job("a"), job("b"), job("x", ["a"]), job("y", ["b"])]);
  assert.deepEqual(orderColumns(units, columns(units)), [
    ["a", "b"],
    ["x", "y"],
  ]);
});

test("a matrix's jobs are one node, named without their combination", () => {
  const units = groupJobs([
    job("build"),
    job("test", ["build"], { name: "test (ubuntu-latest, 20)" }),
    job("test", ["build"], { name: "test (ubuntu-latest, 22)" }),
    job("test", ["build"], { name: "test (macos-latest, 22)" }),
  ]);
  assert.equal(units.length, 2);
  const matrix = units[1]!;
  assert.equal(matrix.kind, "matrix");
  assert.equal(matrix.label, "test");
  assert.equal(matrix.kind === "matrix" && matrix.jobs.length, 3);
  assert.equal(baseName("test (a, b)"), "test");
  assert.equal(baseName("plain"), "plain");
});

test("an expanded matrix is taller, and its connectors still meet its first line", () => {
  const jobs = [job("build"), job("test", ["build"], { name: "test (1)" }), job("test", ["build"], { name: "test (2)" })];
  const closed = layoutRun(jobs);
  const open = layoutRun(jobs, new Set(["test"]));
  const node = (layout: typeof closed) => layout.nodes.find((n) => n.unit.key === "test")!;
  assert.equal(node(closed).h, GRAPH.nodeHeight);
  assert.equal(node(open).h, GRAPH.nodeHeight + 2 * GRAPH.rowHeight + 6);
  assert.ok(node(open).expanded);
  assert.equal(open.edges.length, 1);
  assert.equal(open.edges[0]!.path, closed.edges[0]!.path);
});

test("a called workflow's jobs sit in a box under the job calling it", () => {
  const jobs = [
    job("build", [], { name: "Build", uses: "./.g1t/workflows/build.yml" }),
    job("build/compile", [], { name: "Build / compile" }),
    job("build/package", ["build/compile"], { name: "Build / package" }),
    job("deploy", ["build"]),
  ];
  const units = groupJobs(jobs);
  assert.deepEqual(
    units.map((unit) => [unit.kind, unit.key]),
    [
      ["call", "build"],
      ["job", "deploy"],
    ],
  );
  const call = units[0]!;
  assert.ok(call.kind === "call");
  assert.equal(call.uses, "./.g1t/workflows/build.yml");
  assert.deepEqual(
    call.units.map((unit) => unit.label),
    ["compile", "package"],
  );

  const layout = layoutRun(jobs);
  const box = layout.groups[0]!;
  const compile = layout.nodes.find((n) => n.unit.key === "build/compile")!;
  const pack = layout.nodes.find((n) => n.unit.key === "build/package")!;
  const deploy = layout.nodes.find((n) => n.unit.key === "deploy")!;
  // Inside the box, one after the other; the job needing the caller after the box.
  assert.ok(compile.x >= box.x && compile.x + compile.w <= box.x + box.w);
  assert.ok(pack.x > compile.x && pack.x + pack.w <= box.x + box.w);
  assert.ok(compile.y >= box.y + GRAPH.groupHead);
  assert.ok(deploy.x >= box.x + box.w + GRAPH.columnGap);
  assert.deepEqual(
    layout.edges.map((edge) => [edge.from, edge.to]).sort(),
    [
      ["build", "deploy"],
      ["build/compile", "build/package"],
    ],
  );
  assert.equal(layout.width, deploy.x + deploy.w + GRAPH.margin);
});

test("a connector's colour follows the run: red from a failure, moving into a running job", () => {
  const layout = layoutRun([
    job("a", [], { conclusion: "failure" }),
    job("b", ["a"], { conclusion: "skipped" }),
    job("c"),
    job("d", ["c"], { status: "in_progress", conclusion: null }),
    job("e", ["c"], { status: "waiting", conclusion: null }),
  ]);
  const state = Object.fromEntries(layout.edges.map((edge) => [`${edge.from}>${edge.to}`, edge.state]));
  assert.deepEqual(state, { "a>b": "failed", "c>d": "active", "c>e": "idle" });
});

test("a deployment's address makes its node taller", () => {
  const layout = layoutRun([job("deploy", [], { environment: "production", environmentUrl: "https://g1t.page" })]);
  assert.equal(layout.nodes[0]!.h, GRAPH.nodeHeight + GRAPH.urlHeight);
});

test("several jobs stand together as running, then as the worst ending", () => {
  assert.deepEqual(standingOf([job("a"), job("b", [], { status: "calling", conclusion: null })]), { status: "in_progress", conclusion: null });
  assert.deepEqual(standingOf([job("a"), job("b", [], { conclusion: "failure" }), job("c", [], { conclusion: "cancelled" })]), {
    status: "completed",
    conclusion: "failure",
  });
  assert.deepEqual(standingOf([job("a", [], { conclusion: "skipped" })]), { status: "completed", conclusion: "skipped" });
});

test("connectors run straight on one row, and turn with rounded corners between rows", () => {
  assert.equal(connector(0, 10, 50, 10), "M0 10H50");
  const turn = connector(0, 10, 100, 70);
  assert.match(turn, /^M0 10H\d+Q/);
  assert.ok(turn.endsWith("H100"));
});

test("an empty run lays out as nothing", () => {
  const layout = layoutRun([]);
  assert.equal(layout.nodes.length, 0);
  assert.equal(layout.edges.length, 0);
});

test("a matrix whose jobs deploy to one address shows it once", () => {
  const url = "https://g1t.sh";
  const shared = layoutRun([
    job("core", [], { name: "core (a)", environmentUrl: url }),
    job("core", [], { name: "core (b)", environmentUrl: url }),
  ]);
  assert.equal(shared.nodes[0]!.h, GRAPH.nodeHeight + GRAPH.urlHeight);
  const mixed = layoutRun([
    job("core", [], { name: "core (a)", environmentUrl: url }),
    job("core", [], { name: "core (b)", environmentUrl: null }),
  ]);
  assert.equal(mixed.nodes[0]!.h, GRAPH.nodeHeight);
});
