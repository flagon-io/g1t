import { useEffect } from "react";
import { useNavigation, useRevalidator } from "react-router";

/** How often a page with something moving asks again. */
export const REFRESH_MS = 4000;

/**
 * Revalidates the page every `everyMs` while `on` and the tab is visible.
 * Never while a navigation is pending: a revalidation then restarts the
 * navigation, aborting its loaders, so a click to a page slower than the
 * interval would never arrive. Never on top of a revalidation still going.
 */
export function useRefreshWhile(on: boolean, everyMs = REFRESH_MS) {
  const revalidator = useRevalidator();
  const navigating = useNavigation().state !== "idle";
  useEffect(() => {
    if (!on || navigating) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, everyMs);
    return () => clearInterval(timer);
  }, [on, navigating, everyMs, revalidator]);
}
