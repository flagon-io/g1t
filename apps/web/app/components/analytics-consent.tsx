/**
 * Asking a visitor from the EU, EEA, UK or Switzerland before site
 * analytics runs (lib/analytics-consent.ts): both answers are one click,
 * and nothing is fetched or stored for analytics until they agree. The
 * footer's "Cookie choices" asks again (components/footer.tsx).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import { analyticsHere, choice, choose, consentRequired, onChoice } from "../lib/analytics-consent";
import { Button } from "./ui/button";

/** Whether this visitor is asked at all, known only once the page is in the browser. */
export function useAsksFirst(): boolean {
  const [asks, setAsks] = useState(false);
  useEffect(() => setAsks(analyticsHere() && consentRequired()), []);
  return asks;
}

export function AnalyticsConsent() {
  const asks = useAsksFirst();
  const chosen = useSyncExternalStore(onChoice, choice, () => null);
  if (!asks || chosen) return null;
  return (
    <section
      aria-label="Analytics cookie"
      className="fixed inset-x-3 bottom-3 z-[60] max-md:bottom-[calc(var(--tabbar-h)+0.75rem)] max-md:in-data-[keyboard=open]:bottom-3 mx-auto max-w-lg rounded-2xl bg-surface p-4 text-sm shadow-2xl shadow-black/50 ring-1 ring-line-strong sm:inset-x-auto sm:right-4 sm:bottom-4"
    >
      <p className="leading-6 text-fg-soft">
        May g1t count how its pages are used? It sets one analytics cookie, and names inside your workspaces are
        removed before anything is sent.{" "}
        <Link to="/policies/privacy#how-the-site-is-used" className="text-accent hover:underline">
          What is sent
        </Link>
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          onClick={() => choose("yes")}
          size="inline"
          className="flex-1 rounded-lg px-3 py-2"
        >
          Allow
        </Button>
        <Button
          type="button"
          onClick={() => choose("no")}
          variant="ghost"
          size="inline"
          className="flex-1 rounded-lg px-3 py-2 text-fg ring-1 ring-line-strong"
        >
          No thanks
        </Button>
      </div>
    </section>
  );
}
