import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ServiceBinding } from "./clients.ts";
import { datasetQueryError } from "./datasets.ts";
import { dashboardGridError, dashboardOpError } from "./folios-dashboard.ts";
import { DESIGN_MAX_NODES, countDesignSpecs, designOpError } from "./folios-design.ts";
import { SLIDE_LAYOUTS, SLIDE_LAYOUT_REGIONS, slideFragment, slidesOpError } from "./folios-slides.ts";
import {
  FOLIO_KINDS,
  FOLIO_RPC_METHODS,
  FOLIO_ROUTE_SEGMENTS,
  folioAccessChangeError,
  folioAgentEditError,
  folioCanHaveChildren,
  folioIdFrom,
  folioListQueryError,
  folioPath,
  folioSlug,
  foliosClient,
  linkedFolioIds,
  newFolioError,
  type FolioAccessChange,
  type NewFolio,
} from "./folios.ts";
import type { User } from "./identity.ts";

const fixtures = JSON.parse(readFileSync(new URL("./folios.fixtures.json", import.meta.url), "utf8")) as {
  new_folio: { input: unknown; error: string | null }[];
  access_change: { change: unknown; error: string | null }[];
  agent_edit: { edit: unknown; error: string | null }[];
  folio_ids: { segment: string; id: string | null }[];
};

function expect(label: string, actual: string | null, error: string | null) {
  if (error === null) assert.equal(actual, null, label);
  else if (error === "*") assert.notEqual(actual, null, `${label} should be refused`);
  else assert.equal(actual, error, label);
}

test("agrees with the Rust validators on every shared case", () => {
  for (const { input, error } of fixtures.new_folio) expect(JSON.stringify(input), newFolioError(input as NewFolio), error);
  for (const { change, error } of fixtures.access_change) expect(JSON.stringify(change), folioAccessChangeError(change as FolioAccessChange), error);
  for (const { edit, error } of fixtures.agent_edit) expect(JSON.stringify(edit), folioAgentEditError(edit), error);
  for (const { segment, id } of fixtures.folio_ids) assert.equal(folioIdFrom(segment), id, segment);
});

test("addresses are flat, end in the id and survive renames", () => {
  const id = "fol_01jb2k7x9hfq0b3zj0f5s2m8ra";
  assert.equal(folioPath("acme", "Q4 roadmap: pricing", id), `/acme/-/artifacts/q4-roadmap-pricing-${id}`);
  assert.equal(folioSlug("", id), id);
  assert.equal(folioSlug("Café ✨ notes", id), `cafe-notes-${id}`);
  assert.equal(folioIdFrom(folioSlug("Anything at all", id)), id);
  assert.deepEqual(linkedFolioIds(`see /acme/-/artifacts/x-${id} and ${id}`), [id]);
  for (const segment of FOLIO_ROUTE_SEGMENTS) assert.equal(folioIdFrom(segment), null, segment);
});

test("only a doc holds other folios", () => {
  assert.deepEqual(FOLIO_KINDS.filter(folioCanHaveChildren), ["doc"]);
});

test("list queries are checked", () => {
  assert.equal(folioListQueryError({ tab: "shared", kinds: ["slides"], limit: 50 }), null);
  assert.equal(folioListQueryError({ tab: "everything" as "all" }), "tab is all, yours or shared.");
  assert.equal(folioListQueryError({ tab: "all", limit: 500 }), "limit is between 1 and 100.");
  assert.equal(folioListQueryError({ tab: "all", kinds: ["sheet" as "doc"] }), "There is no kind of artifact called sheet.");
});

test("the client calls exactly the docs service's folio methods", async () => {
  const called: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const binding: ServiceBinding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      called.push(String(input).replace("https://service/rpc/", ""));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, value: null }), { headers: { "content-type": "application/json" } });
    },
  } as ServiceBinding;
  const client = foliosClient(binding);
  const viewer = { id: "usr_1" } as User;
  const ws = "acme";
  const f = "fol_1";
  await Promise.all([
    client.list(ws, viewer, { tab: "all" }),
    client.sidebar(ws, viewer),
    client.folio(ws, viewer, f),
    client.create(ws, viewer, { kind: "doc" }),
    client.update(ws, viewer, f, { title: "x" }),
    client.move(ws, viewer, f, { space_id: null, parent_id: null }),
    client.duplicate(ws, viewer, f),
    client.trash(ws, viewer, f),
    client.restore(ws, viewer, f),
    client.delete(ws, viewer, f),
    client.trashed(ws, viewer),
    client.favorite(ws, viewer, f, true),
    client.content(ws, viewer, f),
    client.edit(ws, viewer, f, { kind: "doc", target: { kind: "append" }, markdown: "x" }),
    client.access(ws, viewer, f),
    client.changeAccess(ws, viewer, f, { op: "grant", principal: "user:usr_2", role: "view" }),
    client.changeAccess(ws, viewer, f, { op: "general", access: "workspace", role: "view" }),
    client.requestAccess(ws, viewer, f),
    client.joinSpace(ws, viewer, "spc_1"),
    client.leaveSpace(ws, viewer, "spc_1"),
    client.search(ws, viewer, { q: "roadmap" }),
    client.versions(ws, viewer, f),
    client.version(ws, viewer, f, "ver_1"),
    client.restoreVersion(ws, viewer, f, "ver_1"),
    client.templates(ws, viewer),
    client.saveTemplate(ws, viewer, { folio_id: f, name: "T" }),
    client.deleteTemplate(ws, viewer, "tpl_1"),
    client.export(ws, viewer, f),
    client.suggestions(ws, viewer, f),
    client.decideSuggestion(ws, viewer, "sug_1", "accept"),
    client.proposals(ws, viewer, f),
    client.decideProposal(ws, viewer, "prp_1", "reject"),
    client.thread(ws, viewer, f, { op: "resolve", thread_id: "thr_1" }),
    client.threads(ws, viewer, f),
    client.queryTile(ws, viewer, f, "t1"),
    client.queryDataset(ws, viewer, { dataset: "issues", measure: { op: "count" } }),
    client.queryDatasetForAgent(ws, "agt_1", viewer, { folio_id: f, tile_id: "t1" }),
    client.foliosForAgent(ws, "agt_1", viewer, { tab: "all" }),
    client.readForAgent(ws, "agt_1", viewer, f),
    client.createAsAgent(ws, "agt_1", viewer, { kind: "doc", title: "Notes", where: "private" }),
    client.editAsAgent(ws, "agt_1", viewer, f, { kind: "slides", ops: [{ op: "delete_slides", slide_ids: ["s1"] }] }),
    client.shareAsAgent(ws, "agt_1", viewer, f, { user_ids: ["usr_2"], role: "view" }, { kind: "people", user_ids: ["usr_1", "usr_2"] }),
    client.recallForAgent(ws, "agt_1", viewer, { query: "pricing" }),
    client.staleForAgent(ws, "agt_1", viewer),
    client.markCurrent(ws, viewer, f),
    client.reindex(ws, viewer),
  ]);
  assert.deepEqual([...new Set(called)].sort(), [...FOLIO_RPC_METHODS].sort());
  // Every body names the workspace and the viewer, and keys are snake_case.
  for (const body of bodies) {
    assert.equal(body.workspace, ws);
    assert.ok(body.viewer);
    for (const key of Object.keys(body)) assert.match(key, /^[a-z_]+$/, key);
  }
});

test("slides ops are checked by shape", () => {
  assert.equal(slidesOpError({ op: "insert_slides", after_slide_id: null, markdown: "---" }), null);
  assert.equal(slidesOpError({ op: "move_slide", slide_id: "s1", after_slide_id: "s2" }), null);
  assert.equal(slidesOpError({ op: "set_theme", theme: "night", accent: "#8b7cf6" }), null);
  assert.equal(slidesOpError({ op: "set_theme", theme: "night", accent: "lavender" }), "accent is a colour like #8b7cf6, or null.");
  assert.equal(slidesOpError({ op: "replace_slide", markdown: "# x" }), "replace_slide needs slide_id.");
  assert.equal(slidesOpError({ op: "delete_slides", slide_ids: [] }), "delete_slides needs slide_ids.");
  assert.equal(slidesOpError({ op: "shuffle" }), "There is no slides op called shuffle.");
  for (const layout of SLIDE_LAYOUTS) assert.ok(SLIDE_LAYOUT_REGIONS[layout].includes("notes"), layout);
  assert.equal(slideFragment("s1", "left"), "slide:s1:left");
});

test("design ops are checked by shape and size", () => {
  const frame = { type: "frame", name: "Home", layout: "column", gap: 16, children: [{ type: "text", text: "Hello" }, { type: "html", html: "<b>hi</b>" }] };
  assert.equal(designOpError({ op: "upsert_nodes", nodes: [frame] }), null);
  assert.deepEqual(countDesignSpecs([frame as never]), { nodes: 3, depth: 2 });
  assert.equal(designOpError({ op: "upsert_nodes", nodes: [{ type: "rect", children: [{ type: "text" }] }] }), "Only frames and components have children.");
  assert.equal(designOpError({ op: "upsert_nodes", nodes: [{ type: "text", html: "<b>" }] }), "Only an html node has html.");
  assert.equal(designOpError({ op: "upsert_nodes", nodes: [{ type: "blob" }] }), "There is no node type called blob.");
  assert.equal(designOpError({ op: "set_html", node_id: "n1", html: "x".repeat(200 * 1024 + 1) }), "An html node holds at most 200 KB.");
  assert.equal(designOpError({ op: "set_html", node_id: "n1", html: "é".repeat(100 * 1024) }), null);
  assert.equal(designOpError({ op: "set_html", node_id: "n1", html: "é".repeat(100 * 1024 + 1) }), "An html node holds at most 200 KB.");
  const many = Array.from({ length: DESIGN_MAX_NODES + 1 }, () => ({ type: "rect" }));
  assert.equal(designOpError({ op: "upsert_nodes", nodes: many }), `A design holds at most ${DESIGN_MAX_NODES} nodes.`);
  assert.equal(designOpError({ op: "move", ids: ["a"], dx: 1, dy: Number.NaN }), "move needs dx and dy.");
  assert.equal(designOpError({ op: "instance" }), "There is no design op called instance.");
});

test("dashboard ops check tiles, their queries and the grid", () => {
  const tile = {
    id: "t1",
    type: "line",
    title: "Merged per week",
    description: "",
    query: { dataset: "pull_requests", measure: { op: "count" }, interval: "week", time: "merged_at" },
    viz: {},
    grid: { x: 0, y: 0, w: 6, h: 4 },
  };
  assert.equal(dashboardOpError({ op: "upsert_tile", tile }, datasetQueryError), null);
  assert.equal(dashboardOpError({ op: "upsert_tile", tile: { ...tile, query: { ...tile.query, group_by: "secret" } } }, datasetQueryError), "pull_requests can't be grouped by secret.");
  assert.equal(dashboardOpError({ op: "upsert_tile", tile: { ...tile, type: "markdown", query: null, markdown: "Notes" } }, datasetQueryError), null);
  assert.equal(dashboardOpError({ op: "upsert_tile", tile: { ...tile, type: "markdown" } }, datasetQueryError), "A text tile has no query.");
  assert.equal(dashboardOpError({ op: "upsert_tile", tile: { ...tile, grid: { x: 8, y: 0, w: 6, h: 4 } } }, datasetQueryError), "A tile fits in 12 columns.");
  assert.equal(dashboardOpError({ op: "set_filters", filters: { range: "30d", repos: ["acme/web"] } }, datasetQueryError), null);
  assert.equal(dashboardOpError({ op: "set_filters", filters: { range: { from: "2026-02-30", to: "2026-03-01" } } }, datasetQueryError), "A range's from and to are dates or RFC 3339 UTC times.");
  assert.equal(dashboardOpError({ op: "set_layout", tiles: [{ id: "t1", grid: { x: 0, y: 0, w: 0, h: 1 } }] }, datasetQueryError), "grid starts at 0, 0 and is at least 1 by 1.");
  assert.equal(dashboardGridError({ x: 0, y: 0, w: 12, h: 1 }), null);
});
