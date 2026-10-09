/**
 * A person's last year on their profile: a square a day, a column a week,
 * shaded in the accent by how much they did (commits pushed to a default
 * branch, issues and pull requests opened, reviews given) on repositories
 * the viewer can see. The layout is
 * lib/contribution-calendar.ts; the counts come from the work service's
 * `contributions`, which never counts work the viewer could not open.
 *
 * One hint serves every square: it follows the pointer, so a year of days
 * costs one tooltip, not 365.
 */
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";

import { type Level, buildCalendar, dayLabel, totalLabel } from "../lib/contribution-calendar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** A square's side and the space between squares, in pixels. */
const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;

/** Each level's shade: the raised gray for nothing, then the accent, stronger with more. */
const SHADES: Record<Level, string> = {
  0: "bg-raised",
  1: "bg-accent/25",
  2: "bg-accent/45",
  3: "bg-accent/70",
  4: "bg-accent",
};

const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

type Hovered = { date: string; count: number; commits: number; left: number; top: number };

export function ContributionCalendar({
  days,
  total,
  today,
  from,
}: {
  days: readonly { date: string; count: number; commits?: number }[];
  total: number;
  /** `YYYY-MM-DD`, UTC: the last day shown. */
  today: string;
  /** The first day counted; a year before `today` when absent. */
  from?: string;
}) {
  const calendar = useMemo(() => buildCalendar(days, today, from), [days, today, from]);
  const scroller = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Hovered | null>(null);

  // On a narrow screen the calendar scrolls inside its card; start at today.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, []);

  const over = (event: PointerEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-date]");
    if (!cell) return setHovered(null);
    const date = cell.dataset.date!;
    if (hovered?.date === date) return;
    setHovered({ date, count: Number(cell.dataset.count ?? 0), commits: Number(cell.dataset.commits ?? 0), left: cell.offsetLeft, top: cell.offsetTop });
  };

  const heading = totalLabel(total);
  return (
    <section aria-label="Contributions" className="rounded-xl border border-line bg-surface/50 px-4 pt-3.5 pb-3">
      <h2 className="text-sm font-medium">{heading}</h2>
      <div ref={scroller} className="mt-3 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-width:thin]">
        <div className="flex w-max text-[0.625rem] leading-none text-faint">
          {/* The weekdays, under the months' row. */}
          <div aria-hidden="true" className="mr-1.5 flex shrink-0 flex-col" style={{ gap: GAP, paddingTop: 16 }}>
            {WEEKDAYS.map((label, index) => (
              <span key={index} className="flex items-center" style={{ height: CELL }}>
                {label}
              </span>
            ))}
          </div>
          <div
            role="img"
            aria-label={heading}
            className="relative"
            onPointerOver={over}
            // A tap's pointer leaves as the finger lifts: its hint stays until the next tap elsewhere.
            onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(null)}
          >
            <div aria-hidden="true" className="relative h-4" style={{ width: calendar.weeks.length * STEP - GAP }}>
              {calendar.months.map((month) => (
                <span key={`${month.week}:${month.label}`} className="absolute top-0" style={{ left: month.week * STEP }}>
                  {month.label}
                </span>
              ))}
            </div>
            <div className="flex" style={{ gap: GAP }}>
              {calendar.weeks.map((week, column) => (
                <div key={column} className="flex flex-col" style={{ gap: GAP }}>
                  {week.map((day, row) =>
                    day ? (
                      <span
                        key={row}
                        data-date={day.date}
                        data-count={day.count}
                        data-commits={day.commits}
                        className={`block rounded-[2px] ${SHADES[day.level]} ${hovered?.date === day.date ? "ring-1 ring-fg/60" : ""}`}
                        style={{ width: CELL, height: CELL }}
                      />
                    ) : (
                      <span key={row} className="block" style={{ width: CELL, height: CELL }} />
                    ),
                  )}
                </div>
              ))}
            </div>
            {/* The one hint, over whichever square the pointer is on. */}
            <Tooltip open={hovered != null} onOpenChange={(open) => !open && setHovered(null)}>
              <TooltipTrigger asChild>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute"
                  style={{ left: hovered?.left ?? 0, top: hovered?.top ?? 0, width: CELL, height: CELL }}
                />
              </TooltipTrigger>
              <TooltipContent side="top">{hovered ? dayLabel(hovered.count, hovered.date, hovered.commits) : null}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="mt-2 flex items-center justify-end gap-1 text-[0.6875rem] text-faint">
        <span className="mr-1">Less</span>
        {([0, 1, 2, 3, 4] as Level[]).map((level) => (
          <span key={level} className={`block rounded-[2px] ${SHADES[level]}`} style={{ width: CELL, height: CELL }} />
        ))}
        <span className="ml-1">More</span>
      </div>
    </section>
  );
}
