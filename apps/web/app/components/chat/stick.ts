import { type RefObject, useEffect } from "react";

/**
 * Keeps a conversation's newest message in view while the reader is at
 * the bottom: when the list itself changes size (the keyboard opening on
 * a phone shrinks it, a window resized) and when what is in it does (a
 * card, an image or a code block laying out after it arrived). Without
 * this, a list that gets shorter keeps its distance from the top, and the
 * newest messages slide out of sight under the composer.
 *
 * `stick` says whether the reader is at the bottom (within 120px), as the
 * list's `onScroll` keeps it (`atBottom`); a reader scrolled up into the
 * history is left where they are.
 */
export function useKeepAtBottom(scroller: RefObject<HTMLElement | null>, stick: RefObject<boolean>) {
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const keep = () => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [scroller, stick]);
}

/** Whether a list is scrolled to (within 120px of) its bottom. */
export function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 120;
}
