import { type MouseEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";

import { type LineRange, formatLineHash, inRange, parseLineHash, pickLine } from "../lib/line-anchor";

/**
 * A file's lines, each with a number that links to it. `#L12` and
 * `#L10-L20` in the address scroll to and light up those lines, on arrival
 * and on every navigation after. Picking a number puts it in the address;
 * a shift-pick extends the run. Every row is rendered with `id="L<n>"` on
 * the server, so a link lands on its line before the page's script runs.
 */
export function CodeLines({
  lines,
  html,
  marked,
}: {
  lines: string[];
  /** Highlighted HTML per line, when the language is known. */
  html: string[] | null;
  /** Lines to mark as having a problem, 1-based. */
  marked?: readonly number[];
}) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [picked, setPicked] = useState<LineRange | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const arrived = useRef(false);

  // The address names the lines. Runs after the router's own scroll
  // restoration (a layout effect higher up), so it has the last word.
  useEffect(() => {
    const range = parseLineHash(location.hash, lines.length);
    setPicked(range);
    // Back and forward restore where the reader was; anything else goes to
    // the lines.
    const first = !arrived.current;
    arrived.current = true;
    if (range && (first || navigationType !== "POP")) {
      document.getElementById(`L${range.start}`)?.scrollIntoView({ block: "start" });
    }
  }, [location.key, location.hash, location.pathname, lines.length, navigationType]);

  const pick = useCallback((event: MouseEvent<HTMLAnchorElement>, line: number) => {
    // A new tab or window is the browser's to open.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (event.shiftKey) window.getSelection()?.removeAllRanges();
    const next = pickLine(pickedRef.current, line, event.shiftKey);
    setPicked(next);
    // The router's entry is kept, so back and forward still work; the page
    // stays where it is.
    window.history.replaceState(window.history.state, "", formatLineHash(next));
  }, []);

  return (
    <div className="overflow-x-auto py-3">
      <table className="w-full border-collapse font-mono text-[0.8125rem] leading-6 sm:text-sm">
        <tbody>
          {lines.map((text, i) => (
            <Line
              key={i}
              n={i + 1}
              text={text}
              html={html?.[i] ?? null}
              selected={inRange(picked, i + 1)}
              marked={marked?.includes(i + 1) ?? false}
              onPick={pick}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Line = memo(function Line({
  n,
  text,
  html,
  selected,
  marked,
  onPick,
}: {
  n: number;
  text: string;
  html: string | null;
  selected: boolean;
  marked?: boolean;
  onPick: (event: MouseEvent<HTMLAnchorElement>, line: number) => void;
}) {
  return (
    <tr id={`L${n}`} data-selected={selected || undefined} className={`scroll-mt-24 ${selected ? "bg-accent/10" : marked ? "bg-danger/10" : ""}`}>
      <td className="w-px p-0 text-right align-top select-none">
        <a
          href={`#L${n}`}
          tabIndex={-1}
          onClick={(event) => onPick(event, n)}
          className={`block min-w-10 pr-3 pl-2 transition-colors sm:min-w-14 sm:pr-5 sm:pl-4 ${
            selected ? "text-accent" : marked ? "text-danger" : "text-faint hover:text-fg"
          }`}
        >
          {n}
        </a>
      </td>
      <td className="pr-4 whitespace-pre">
        {html != null ? <span dangerouslySetInnerHTML={{ __html: html || " " }} /> : text || " "}
      </td>
    </tr>
  );
});
