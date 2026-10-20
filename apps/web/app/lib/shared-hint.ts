/**
 * One hover hint for the whole page, for marks that are on it by the
 * hundred: every timestamp (`TimeAgo`). A `Hint` mounts a Radix tooltip
 * (its provider, root, popper and trigger) per mark, and a long list (a
 * tree of 200 files, a busy timeline) spent most of its first draw on
 * them: 222–471 ms long tasks on tree/main at 4× CPU. These marks (and a
 * file list's last-commit messages) carry `data-shared-hint` instead, and a single bubble, made once and moved to
 * whichever mark the pointer rests on, says what the mark's `hint` says.
 *
 * It looks and waits as `Hint` does (components/ui/tooltip.tsx): the
 * inverted bubble above the mark, after 200 ms; a tap shows it on a touch
 * screen; it goes when the pointer leaves, on scroll, and on Escape.
 */

/** Marks that share the hint; the attribute names how to word it. */
export const SHARED_HINT = "data-shared-hint";

/** As long as the site's tooltips wait before they open. */
export const SHARED_HINT_DELAY_MS = 200;

/** Room between the mark and the bubble, as `TooltipContent`'s `sideOffset`. */
const OFFSET = 6;
/** The bubble keeps this far from the window's edges. */
const MARGIN = 8;

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the bubble goes: centred above the mark, or below when there is no
 * room above, and kept inside the window. `arrow` is the arrow's left,
 * inside the bubble, so it still points at the mark when the bubble is
 * pushed in from an edge.
 */
export function placeHint(mark: Box, bubble: { width: number; height: number }, view: { width: number; height: number }) {
  const centre = mark.left + mark.width / 2;
  const left = Math.min(Math.max(MARGIN, centre - bubble.width / 2), Math.max(MARGIN, view.width - MARGIN - bubble.width));
  const above = mark.top - OFFSET - bubble.height;
  const side: "top" | "bottom" = above >= MARGIN || mark.top + mark.height + OFFSET + bubble.height > view.height ? "top" : "bottom";
  const top = side === "top" ? above : mark.top + mark.height + OFFSET;
  const arrow = Math.min(Math.max(6, centre - left), bubble.width - 6);
  return { left, top, side, arrow };
}

type Wording = (mark: Element) => string | null;

/** Plain words, as the mark's `data-hint` has them (`data-shared-hint="text"`). */
const wordings = new Map<string, Wording>([["text", (mark) => mark.getAttribute("data-hint")]]);

/** How marks of `kind` are worded, read from the mark when the hint opens (so in the reader's time zone). */
export function sharedHintWording(kind: string, wording: Wording): void {
  wordings.set(kind, wording);
}

let installed = false;
let bubble: HTMLDivElement | null = null;
let text: HTMLSpanElement | null = null;
let arrow: SVGSVGElement | null = null;
let shown: Element | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function markOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(`[${SHARED_HINT}]`) : null;
}

function build(): HTMLDivElement {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.setAttribute("role", "tooltip");
  bubble.id = "shared-hint";
  // TooltipContent's classes, so it is the same bubble.
  bubble.className =
    "pointer-events-none fixed z-50 max-w-xs rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg shadow-md text-balance animate-pop-in motion-reduce:animate-none";
  bubble.hidden = true;
  text = document.createElement("span");
  arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("width", "10");
  arrow.setAttribute("height", "5");
  arrow.setAttribute("viewBox", "0 0 30 10");
  arrow.setAttribute("aria-hidden", "true");
  arrow.setAttribute("class", "absolute fill-fg");
  arrow.innerHTML = '<polygon points="0,0 30,0 15,10"></polygon>';
  bubble.appendChild(text);
  bubble.appendChild(arrow);
  document.body.appendChild(bubble);
  return bubble;
}

function show(mark: Element): void {
  const kind = mark.getAttribute(SHARED_HINT) ?? "";
  const label = mark.isConnected ? wordings.get(kind)?.(mark) : null;
  if (!label) return;
  const el = build();
  text!.textContent = label;
  el.hidden = false;
  // Played again for each mark, as each tooltip pops in.
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  const place = placeHint(mark.getBoundingClientRect(), el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  el.style.left = `${place.left}px`;
  el.style.top = `${place.top}px`;
  arrow!.style.left = `${place.arrow - 5}px`;
  arrow!.style.top = place.side === "top" ? "100%" : "";
  arrow!.style.bottom = place.side === "bottom" ? "100%" : "";
  arrow!.style.transform = place.side === "bottom" ? "rotate(180deg)" : "";
  mark.setAttribute("aria-describedby", el.id);
  shown = mark;
}

function hide(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  shown?.removeAttribute("aria-describedby");
  shown = null;
  if (bubble) bubble.hidden = true;
}

/** Listens for the page's marks, once: every `TimeAgo` asks, the first one sets it up. */
export function installSharedHint(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const mark = markOf(event.target);
    if (mark === shown) return;
    hide();
    if (mark) timer = setTimeout(() => show(mark), SHARED_HINT_DELAY_MS);
  });
  document.addEventListener("pointerout", (event) => {
    const mark = markOf(event.target);
    if (mark && !mark.contains(event.relatedTarget as Node | null)) hide();
  });
  // No hover on a touch screen: a tap on a mark shows it, a tap elsewhere puts it away.
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return hide();
    const mark = markOf(event.target);
    if (mark && mark !== shown && !(event.target as Element).closest("a, button")) {
      hide();
      show(mark);
    } else hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, { capture: true, passive: true });
}
