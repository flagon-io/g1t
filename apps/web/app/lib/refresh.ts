import { useEffect } from "react";
import { useNavigation, useRevalidator } from "react-router";

/** How often a page with something moving asks again. */
export const REFRESH_MS = 4000;

/**
 * Revalidates the page `everyMs` after it last loaded while `on` and the
 * tab is visible. Whatever refreshed it last (this, a live change, a form,
 * a navigation) starts the count again, so a page that also follows live
 * changes is not refreshed twice in a row. Out of view it waits, and asks
 * once when the tab comes back if the time has passed meanwhile.
 *
 * Never while a navigation is pending: a revalidation then restarts the
 * navigation, aborting its loaders, so a click to a page slower than the
 * interval would never arrive. Never on top of a revalidation still going.
 */
export function useRefreshWhile(on: boolean, everyMs = REFRESH_MS) {
  const revalidator = useRevalidator();
  const idle = useNavigation().state === "idle" && revalidator.state === "idle";
  useEffect(() => {
    if (!on || !idle) return;
    let due = false;
    const ask = () => {
      if (document.visibilityState === "visible") revalidator.revalidate();
      else due = true;
    };
    const timer = setTimeout(ask, everyMs);
    const back = () => {
      if (due && document.visibilityState === "visible") ask();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", back);
    };
    // `revalidator` is a new object whenever its state changes, which `idle` already follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, idle, everyMs]);
}
