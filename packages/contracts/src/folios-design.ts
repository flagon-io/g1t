/**
 * Design (`kind: "design"`): a frame-based layout canvas and the changes
 * agents make to it. Artifacts mode, docs/ARTIFACTS_MODE.md section 3.3.
 * Wire shapes are snake_case.
 *
 * In the Yjs document: `Y.Map("canvas")` holds `DesignCanvas`; `Y.Map("nodes")`
 * maps each node's id to a `Y.Map` of `DesignNode` (a `text` node's content
 * and an `html` node's source are `Y.Text`). Frames lay their children out
 * themselves (`row`, `column`), so agents describe structure, not
 * coordinates.
 */

export type DesignNodeType = "frame" | "rect" | "ellipse" | "line" | "arrow" | "text" | "image" | "html" | "component" | "instance";
export const DESIGN_NODE_TYPES: readonly DesignNodeType[] = ["frame", "rect", "ellipse", "line", "arrow", "text", "image", "html", "component", "instance"];

export type DesignFrameLayout = "free" | "row" | "column";
export type DesignAlign = "start" | "center" | "end" | "stretch";

export type DesignCanvas = { background: string | null; grid: number | null };

/** A node as stored: every field but `id` and `type` may be absent. */
export type DesignNode = {
  id: string;
  type: DesignNodeType;
  /** The frame or component it sits in; null at the top. */
  parent: string | null;
  /** Its order among its siblings: a fractional index. */
  index: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  fill?: string | null;
  stroke?: string | null;
  stroke_width?: number;
  radius?: number;
  opacity?: number;
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  /** Frames and components. */
  layout?: DesignFrameLayout;
  gap?: number;
  padding?: number;
  align?: DesignAlign;
  /** `line` and `arrow`: the nodes their ends are bound to. */
  from_node?: string | null;
  to_node?: string | null;
  /** `image`: a file of the folio, never bytes. */
  file?: string;
  /** `instance`: the component it is an instance of, and what it changes. */
  component_id?: string;
  overrides?: Record<string, unknown>;
};

/**
 * A node as an agent writes it: nested, so `children` imply `parent` and
 * `index`. Sizes and positions are optional inside `row` and `column`
 * frames. `text` is a text node's content; `html` an html node's source.
 */
export type DesignNodeSpec = Partial<Omit<DesignNode, "parent" | "index" | "type">> & {
  type: DesignNodeType;
  text?: string;
  html?: string;
  children?: DesignNodeSpec[];
};

/** Limits the room enforces when it saves. */
export const DESIGN_MAX_NODES = 5_000;
export const DESIGN_MAX_HTML_BYTES = 200 * 1024;
export const DESIGN_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The deepest a node spec nests. */
export const DESIGN_MAX_DEPTH = 32;

/** The Yjs names the canvas uses. */
export const DESIGN_CANVAS_MAP = "canvas";
export const DESIGN_NODES_MAP = "nodes";

/** What a card shows of a design: its first frame's top nodes, simplified, at most `DESIGN_PREVIEW_NODES`. */
export type DesignPreview = {
  kind: "design";
  frame: { name: string; w: number; h: number } | null;
  nodes: { type: DesignNodeType; x: number; y: number; w: number; h: number; fill: string | null }[];
};
export const DESIGN_PREVIEW_NODES = 50;

/** A change an agent makes to a design. */
export type DesignOp =
  /** Add nodes, or change the ones whose `id` exists. Nested specs are placed in their parents. */
  | { op: "upsert_nodes"; parent?: string | null; nodes: DesignNodeSpec[] }
  | { op: "delete_nodes"; ids: string[] }
  /** Replace a frame's children (and its own fields) with a spec. */
  | { op: "replace_frame"; frame_id: string; spec: DesignNodeSpec }
  | { op: "set_html"; node_id: string; html: string }
  | { op: "move"; ids: string[]; dx: number; dy: number };

export const DESIGN_OPS: readonly DesignOp["op"][] = ["upsert_nodes", "delete_nodes", "replace_frame", "set_html", "move"];

/** How many nodes a spec list makes, its children included, and how deep it goes. */
export function countDesignSpecs(specs: readonly DesignNodeSpec[], depth = 1): { nodes: number; depth: number } {
  let nodes = 0;
  let deepest = specs.length > 0 ? depth : depth - 1;
  for (const spec of specs) {
    nodes += 1;
    if (spec.children && spec.children.length > 0) {
      const inner = countDesignSpecs(spec.children, depth + 1);
      nodes += inner.nodes;
      deepest = Math.max(deepest, inner.depth);
    }
  }
  return { nodes, depth: deepest };
}

/** What is wrong with a node spec, or null. */
export function designSpecError(spec: unknown, depth = 1): string | null {
  if (depth > DESIGN_MAX_DEPTH) return `Node specs nest at most ${DESIGN_MAX_DEPTH} deep.`;
  if (!isObject(spec)) return "A node spec is an object.";
  if (typeof spec.type !== "string" || !(DESIGN_NODE_TYPES as readonly string[]).includes(spec.type)) return `There is no node type called ${String(spec.type)}.`;
  for (const key of ["x", "y", "w", "h", "rotation", "stroke_width", "radius", "opacity", "gap", "padding"]) {
    if (spec[key] !== undefined && (typeof spec[key] !== "number" || !Number.isFinite(spec[key]))) return `${key} is a number.`;
  }
  if (spec.opacity !== undefined && ((spec.opacity as number) < 0 || (spec.opacity as number) > 1)) return "opacity is between 0 and 1.";
  if (spec.layout !== undefined && !["free", "row", "column"].includes(spec.layout as string)) return "layout is free, row or column.";
  if (typeof spec.html === "string" && utf8Bytes(spec.html) > DESIGN_MAX_HTML_BYTES) return "An html node holds at most 200 KB.";
  if (spec.html !== undefined && spec.type !== "html") return "Only an html node has html.";
  if (spec.type === "instance" && typeof spec.component_id !== "string") return "An instance names its component_id.";
  if (spec.children !== undefined) {
    if (!Array.isArray(spec.children)) return "children is a list.";
    if (spec.children.length > 0 && spec.type !== "frame" && spec.type !== "component") return "Only frames and components have children.";
    for (const child of spec.children) {
      const error = designSpecError(child, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

/** What is wrong with a design op, or null. Checks its shape; whether its ids exist is the room's to say. */
export function designOpError(op: unknown): string | null {
  if (!isObject(op) || typeof op.op !== "string") return "A design change has an op.";
  const ids = (key: string) =>
    Array.isArray(op[key]) && (op[key] as unknown[]).length > 0 && (op[key] as unknown[]).every((item) => typeof item === "string" && item.length > 0) ? null : `${op.op} needs ${key}.`;
  const id = (key: string) => (typeof op[key] === "string" && (op[key] as string).length > 0 ? null : `${op.op} needs ${key}.`);
  switch (op.op) {
    case "upsert_nodes": {
      if (!Array.isArray(op.nodes) || op.nodes.length === 0) return "upsert_nodes needs nodes.";
      for (const spec of op.nodes) {
        const error = designSpecError(spec);
        if (error) return error;
      }
      if (countDesignSpecs(op.nodes as DesignNodeSpec[]).nodes > DESIGN_MAX_NODES) return `A design holds at most ${DESIGN_MAX_NODES} nodes.`;
      return null;
    }
    case "delete_nodes":
      return ids("ids");
    case "replace_frame": {
      const error = id("frame_id") ?? designSpecError(op.spec);
      if (error) return error;
      return countDesignSpecs([op.spec as DesignNodeSpec]).nodes > DESIGN_MAX_NODES ? `A design holds at most ${DESIGN_MAX_NODES} nodes.` : null;
    }
    case "set_html":
      if (id("node_id")) return id("node_id");
      if (typeof op.html !== "string") return "set_html needs html.";
      return utf8Bytes(op.html) > DESIGN_MAX_HTML_BYTES ? "An html node holds at most 200 KB." : null;
    case "move":
      if (ids("ids")) return ids("ids");
      return typeof op.dx === "number" && typeof op.dy === "number" && Number.isFinite(op.dx) && Number.isFinite(op.dy) ? null : "move needs dx and dy.";
    default:
      return `There is no design op called ${op.op}.`;
  }
}

/** The length of `text` in UTF-8, in bytes. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
