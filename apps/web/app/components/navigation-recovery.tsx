import { useEffect, useState } from "react";
import { useNavigation } from "react-router";

import { stuckTarget } from "../lib/stuck";
import { Button } from "./ui/button";

/** A document load of the destination, while the router still shows the old page. */
export function NavigationRecovery() {
  const navigation = useNavigation();
  const target = stuckTarget(navigation);
  const key = navigation.location?.key;
  const [slow, setSlow] = useState<string | null>(null);
  useEffect(() => {
    setSlow(null);
    if (!target || !key) return;
    const timer = window.setTimeout(() => setSlow(key), 5_000);
    return () => window.clearTimeout(timer);
  }, [target, key]);
  if (!target || !key || slow !== key) return null;
  return (
    <div className="fixed inset-x-0 bottom-20 z-65 flex justify-center px-4">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-xl bg-surface px-4 py-3 text-sm shadow-xl ring-1 ring-line-strong">
        <span role="status">This page is taking a while.</span>
        <Button asChild variant="outline" size="sm">
          <a href={target}>Reload destination</a>
        </Button>
      </div>
    </div>
  );
}
