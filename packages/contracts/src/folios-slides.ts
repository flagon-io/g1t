/**
 * Slides (`kind: "slides"`): a deck's model and the changes agents make to
 * it. Wire shapes are snake_case.
 *
 * In the Yjs document: `Y.Map("deck")` holds `SlidesDeck`; `Y.Array("slides")`
 * holds one `Y.Map` per slide (`SlideMeta`); each slide region is a root
 * `XmlFragment` named by `slideFragment(id, region)`, a BlockNote editor of
 * its own.
 *
 * Agents, templates, export and the text rendition use the Markdown form:
 * slides separated by `---` lines, each starting `<!-- slide: <layout> -->`,
 * `::: left` / `::: right` for columns, and `Note:` for speaker notes.
 */

export type SlideLayout = "title" | "title-body" | "two-column" | "section" | "image" | "quote" | "big-number" | "blank";
export const SLIDE_LAYOUTS: readonly SlideLayout[] = ["title", "title-body", "two-column", "section", "image", "quote", "big-number", "blank"];

export const SLIDE_LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: "Title",
  "title-body": "Title and body",
  "two-column": "Two columns",
  section: "Section",
  image: "Image",
  quote: "Quote",
  "big-number": "Big number",
  blank: "Blank",
};

export type SlideRegion = "title" | "body" | "left" | "right" | "notes";

/** The regions each layout has; every slide also has `notes`. */
export const SLIDE_LAYOUT_REGIONS: Record<SlideLayout, readonly SlideRegion[]> = {
  title: ["title", "body", "notes"],
  "title-body": ["title", "body", "notes"],
  "two-column": ["title", "left", "right", "notes"],
  section: ["title", "notes"],
  image: ["title", "body", "notes"],
  quote: ["body", "notes"],
  "big-number": ["title", "body", "notes"],
  blank: ["body", "notes"],
};

export type SlidesAspect = "16:9" | "4:3";
export const SLIDES_ASPECTS: readonly SlidesAspect[] = ["16:9", "4:3"];

/** The deck's settings: `Y.Map("deck")`. `theme` names one of the editor's themes. */
export type SlidesDeck = { theme: string; aspect: SlidesAspect; accent: string | null };

/** One slide's own fields: an entry of `Y.Array("slides")`. */
export type SlideMeta = { id: string; layout: SlideLayout; background: string | null; hidden: boolean; transition: "none" };

/** The Yjs names the deck uses. */
export const SLIDES_DECK_MAP = "deck";
export const SLIDES_ARRAY = "slides";

/** The root fragment that holds one region of one slide. */
export function slideFragment(slideId: string, region: SlideRegion): string {
  return `slide:${slideId}:${region}`;
}

/** The most slides in a deck. */
export const SLIDES_MAX = 300;

/** What a card shows of a deck: its first slide, never more. */
export type SlidesPreview = { kind: "slides"; aspect: SlidesAspect; count: number; layout: SlideLayout; title: string };

/** A change an agent makes to a deck. Markdown is in the deck's Markdown form. */
export type SlidesOp =
  /** Replace every slide. */
  | { op: "replace_deck"; markdown: string }
  /** Add slides after one (null: at the start). */
  | { op: "insert_slides"; after_slide_id: string | null; markdown: string }
  /** Replace one slide with what the Markdown holds (one slide or more). */
  | { op: "replace_slide"; slide_id: string; markdown: string }
  | { op: "delete_slides"; slide_ids: string[] }
  /** Move a slide after another (null: to the start). */
  | { op: "move_slide"; slide_id: string; after_slide_id: string | null }
  | { op: "set_notes"; slide_id: string; markdown: string }
  | { op: "set_theme"; theme: string; accent: string | null };

export const SLIDES_OPS: readonly SlidesOp["op"][] = ["replace_deck", "insert_slides", "replace_slide", "delete_slides", "move_slide", "set_notes", "set_theme"];

/** The largest Markdown one op carries, in characters. */
export const SLIDES_MAX_MARKDOWN = 200_000;

const THEME = /^[a-z0-9-]{1,40}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** What is wrong with a slides op, or null. Checks its shape; whether its ids exist is the room's to say. */
export function slidesOpError(op: unknown): string | null {
  if (!isObject(op) || typeof op.op !== "string") return "A slides change has an op.";
  const markdown = () => {
    if (typeof op.markdown !== "string") return `${op.op} needs markdown.`;
    if (op.markdown.length > SLIDES_MAX_MARKDOWN) return `${op.op}'s markdown is too long.`;
    return null;
  };
  const id = (key: string, nullable = false) =>
    (nullable && op[key] === null) || (typeof op[key] === "string" && (op[key] as string).length > 0) ? null : `${op.op} needs ${key}.`;
  switch (op.op) {
    case "replace_deck":
      return markdown();
    case "insert_slides":
      return id("after_slide_id", true) ?? markdown();
    case "replace_slide":
    case "set_notes":
      return id("slide_id") ?? markdown();
    case "delete_slides":
      return Array.isArray(op.slide_ids) && op.slide_ids.length > 0 && op.slide_ids.every((item) => typeof item === "string" && item.length > 0)
        ? null
        : "delete_slides needs slide_ids.";
    case "move_slide":
      return id("slide_id") ?? id("after_slide_id", true);
    case "set_theme":
      if (typeof op.theme !== "string" || !THEME.test(op.theme)) return "set_theme needs a theme name.";
      return op.accent === null || (typeof op.accent === "string" && COLOR.test(op.accent)) ? null : "accent is a colour like #8b7cf6, or null.";
    default:
      return `There is no slides op called ${op.op}.`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
