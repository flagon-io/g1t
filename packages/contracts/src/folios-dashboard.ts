/**
 * Dashboards (`kind: "dashboard"`, beta): a dashboard's definition and the
 * changes agents make to it. Artifacts mode, docs/ARTIFACTS_MODE.md
 * section 3.4. Wire shapes are snake_case.
 *
 * In the Yjs document: `Y.Map("dashboard")` holds `DashboardSettings`;
 * `Y.Array("tiles")` holds one `Y.Map` per tile (`DashboardTile`). Only the
 * definition is stored. Numbers are computed per viewer when the page asks
 * (`query_tile`), and never saved in the folio, its versions, text, preview,
 * index or templates.
 *
 * A tile's query is a `DatasetQuery` (datasets.ts). Ops are checked here
 * with the query validator passed in (`datasetQueryError`), so this file
 * stays free of imports Node can't run as is in tests.
 */
import type { DatasetQuery, DatasetRange } from "./datasets";

export type DashboardTileType = "stat" | "line" | "area" | "bar" | "stacked_bar" | "table" | "list" | "markdown";
export const DASHBOARD_TILE_TYPES: readonly DashboardTileType[] = ["stat", "line", "area", "bar", "stacked_bar", "table", "list", "markdown"];

export const DASHBOARD_TILE_TYPE_LABELS: Record<DashboardTileType, string> = {
  stat: "Number",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  stacked_bar: "Stacked bars",
  table: "Table",
  list: "List",
  markdown: "Text",
};

/** Where a tile sits on the 12-column grid: column, row, width and height in cells. */
export type DashboardGrid = { x: number; y: number; w: number; h: number };
export const DASHBOARD_COLUMNS = 12;
export const DASHBOARD_MAX_ROWS = 200;
export const DASHBOARD_MAX_TILES = 60;

export type DashboardRefresh = "manual" | "5m" | "1h";
export const DASHBOARD_REFRESHES: readonly DashboardRefresh[] = ["manual", "5m", "1h"];

/** Filters every tile starts from; a tile's own `range` wins over the dashboard's. */
export type DashboardFilters = { range: DatasetRange; project?: string | null; repos?: string[] | null; team?: string | null };

export type DashboardSettings = { filters: DashboardFilters; refresh: DashboardRefresh };

/** How a tile draws its rows. Every field is optional and defaults by tile type. */
export type DashboardViz = {
  /** Show a number as money, a percentage, a duration or plain. */
  format?: "number" | "money" | "percent" | "duration" | null;
  /** Lines and bars: show the legend. */
  legend?: boolean;
  /** stat: draw the sparkline when the query has an interval. */
  sparkline?: boolean;
  /** Colours by series name; else the theme's order. */
  colors?: Record<string, string> | null;
};

export type DashboardTile = {
  id: string;
  type: DashboardTileType;
  title: string;
  description: string;
  /** Null on a `markdown` tile, which has `markdown` instead. */
  query: DatasetQuery | null;
  markdown?: string | null;
  viz: DashboardViz;
  grid: DashboardGrid;
};

/** The Yjs names a dashboard uses. */
export const DASHBOARD_MAP = "dashboard";
export const DASHBOARD_TILES = "tiles";

/** What a card shows of a dashboard: tile boxes and titles, never numbers. */
export type DashboardPreview = { kind: "dashboard"; tiles: { type: DashboardTileType; title: string; grid: DashboardGrid }[] };

/** A change an agent makes to a dashboard. */
export type DashboardOp =
  /** Add a tile, or replace the one with its id. */
  | { op: "upsert_tile"; tile: DashboardTile }
  | { op: "delete_tiles"; ids: string[] }
  | { op: "set_filters"; filters: DashboardFilters }
  | { op: "set_layout"; tiles: { id: string; grid: DashboardGrid }[] };

export const DASHBOARD_OPS: readonly DashboardOp["op"][] = ["upsert_tile", "delete_tiles", "set_filters", "set_layout"];

/** What is wrong with a tile's place on the grid, or null. */
export function dashboardGridError(grid: unknown): string | null {
  if (!isObject(grid)) return "grid is { x, y, w, h }.";
  const { x, y, w, h } = grid;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isInteger(n))) return "grid's x, y, w and h are whole numbers.";
  const [gx, gy, gw, gh] = [x, y, w, h] as number[];
  if (gx < 0 || gy < 0 || gw < 1 || gh < 1) return "grid starts at 0, 0 and is at least 1 by 1.";
  if (gx + gw > DASHBOARD_COLUMNS) return `A tile fits in ${DASHBOARD_COLUMNS} columns.`;
  if (gy + gh > DASHBOARD_MAX_ROWS) return `A dashboard is at most ${DASHBOARD_MAX_ROWS} rows tall.`;
  return null;
}

/**
 * What is wrong with a dashboard op, or null. `queryError` checks a tile's
 * query: pass `datasetQueryError` from datasets.ts. Whether ids exist is the
 * room's to say.
 */
export function dashboardOpError(op: unknown, queryError: (query: DatasetQuery) => string | null): string | null {
  if (!isObject(op) || typeof op.op !== "string") return "A dashboard change has an op.";
  switch (op.op) {
    case "upsert_tile": {
      const tile = op.tile;
      if (!isObject(tile)) return "upsert_tile needs a tile.";
      if (typeof tile.id !== "string" || tile.id.length === 0) return "A tile has an id.";
      if (typeof tile.type !== "string" || !(DASHBOARD_TILE_TYPES as readonly string[]).includes(tile.type)) return `There is no tile type called ${String(tile.type)}.`;
      if (typeof tile.title !== "string" || tile.title.length > 200) return "A tile's title is text of at most 200 characters.";
      if (tile.description !== undefined && typeof tile.description !== "string") return "A tile's description is text.";
      if (tile.type === "markdown") {
        if (tile.query != null) return "A text tile has no query.";
        if (typeof tile.markdown !== "string") return "A text tile has markdown.";
      } else {
        if (!isObject(tile.query)) return "A chart tile has a query.";
        const error = queryError(tile.query as DatasetQuery);
        if (error) return error;
      }
      return dashboardGridError(tile.grid);
    }
    case "delete_tiles":
      return Array.isArray(op.ids) && op.ids.length > 0 && op.ids.every((id) => typeof id === "string" && id.length > 0) ? null : "delete_tiles needs ids.";
    case "set_filters": {
      const filters = op.filters;
      if (!isObject(filters)) return "set_filters needs filters.";
      const range = filters.range;
      const preset = typeof range === "string" && ["7d", "30d", "90d"].includes(range);
      if (!preset && !(isObject(range) && typeof range.from === "string" && typeof range.to === "string")) return "range is 7d, 30d, 90d or { from, to }.";
      if (isObject(range)) {
        const error = queryError({ dataset: "issues", measure: { op: "count" }, range: { from: range.from as string, to: range.to as string } });
        if (error) return error;
      }
      if (filters.repos != null && !(Array.isArray(filters.repos) && filters.repos.every((repo) => typeof repo === "string"))) return "repos is a list of owner/name.";
      return null;
    }
    case "set_layout": {
      if (!Array.isArray(op.tiles) || op.tiles.length === 0) return "set_layout needs tiles.";
      for (const tile of op.tiles) {
        if (!isObject(tile) || typeof tile.id !== "string") return "set_layout's tiles are { id, grid }.";
        const error = dashboardGridError(tile.grid);
        if (error) return error;
      }
      return null;
    }
    default:
      return `There is no dashboard op called ${op.op}.`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
