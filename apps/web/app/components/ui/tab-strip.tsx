import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { cn } from "../../lib/cn";

/** How far the fade reaches in from an edge with more tabs past it. */
const FADE = "1.5rem";

/** The fade at either end that has more tabs beyond it. */
function fade(start: boolean, end: boolean): CSSProperties | undefined {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to right, ${start ? "transparent" : "#000"}, #000 ${start ? FADE : "0px"}, #000 calc(100% - ${end ? FADE : "0px"}), ${end ? "transparent" : "#000"})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** The current tab (`aria-current="page"` or `data-active`) scrolled into view, without scrolling the page. */
function reveal(strip: HTMLElement) {
  // A tab that says it is current wins over a link that only contains the address.
  const current = strip.querySelector<HTMLElement>('[data-active="true"]') ?? strip.querySelector<HTMLElement>('[aria-current="page"]');
  if (!current) return;
  const left = current.offsetLeft;
  const right = left + current.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 24);
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 24;
}

/**
 * A row of tabs that never wraps: on a narrow screen it scrolls sideways,
 * with no scrollbar, faded at an edge that has more beyond it, and the
 * current tab (`aria-current="page"` or `data-active`) kept in view.
 */
export function TabStrip({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const { pathname, search } = useLocation();

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const measure = () => {
      const start = strip.scrollLeft > 1;
      const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      setEdges((now) => (now.start === start && now.end === end ? now : { start, end }));
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    // A new width (the first layout, a rotated phone) can hide the current tab.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            reveal(strip);
            measure();
          });
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (ref.current) reveal(ref.current);
  }, [pathname, search]);

  return (
    <nav
      ref={ref}
      aria-label={label}
      style={fade(edges.start, edges.end)}
      className={cn(
        "relative flex overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0",
        className,
      )}
    >
      {children}
    </nav>
  );
}
