import { ShieldAlert } from "lucide-react";
import { Link } from "react-router";

import type { PolicyHold } from "@g1t/contracts";

/**
 * The notice across the top for someone a workspace holds out until they
 * meet its policy, such as one that requires two-factor authentication:
 * they keep their place and cannot use it until they turn it on.
 */
export function PolicyNotice({ held }: { held: PolicyHold[] }) {
  if (held.length === 0) return null;
  const twoFactor = held.some((hold) => hold.gap === "two_factor");
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-sm"
    >
      <ShieldAlert size={15} aria-hidden="true" className="hidden shrink-0 text-warn sm:block" />
      <span>
        {held.length === 1
          ? held[0].reason
          : `${held.map((hold) => hold.slug).join(", ")} require two-factor authentication. Turn it on to use them again.`}
      </span>
      {twoFactor && (
        <Link to="/settings/two-factor" className="font-medium underline underline-offset-4">
          Turn on two-factor authentication
        </Link>
      )}
    </div>
  );
}
