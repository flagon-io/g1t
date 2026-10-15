import { WifiOff } from "lucide-react";

import { useReconnecting } from "../lib/resilient-fetch";

/**
 * Says so while the page cannot reach g1t (lib/resilient-fetch.ts): the
 * page stays as it is and catches up once the network is back, so this
 * only says why nothing is moving. Gone by itself when a read arrives.
 */
export function ConnectionToast() {
  const reconnecting = useReconnecting();
  if (!reconnecting) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-65 flex justify-center px-4 max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)] max-sm:bottom-auto">
      <p
        role="status"
        className="pointer-events-auto flex items-center gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-sm shadow-[0_0_0_6px_var(--color-bg),0_20px_48px_-12px_rgba(0,0,0,0.9)] ring-1 ring-line-strong"
      >
        <WifiOff size={15} className="shrink-0 text-warn" aria-hidden />
        <span>Can't reach g1t. Trying again…</span>
      </p>
    </div>
  );
}
