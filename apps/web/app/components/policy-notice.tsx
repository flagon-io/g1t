import { ShieldAlert } from "lucide-react";
import { Link } from "react-router";

import type { PolicyHold } from "@g1t/contracts";

/**
 * The notice across the top for someone a workspace holds out until they
 * meet its policy, such as one that requires two-factor authentication or
 * single sign-on: they keep their place and cannot use it until they do.
 */
export function PolicyNotice({ held }: { held: PolicyHold[] }) {
  if (held.length === 0) return null;
  const twoFactor = held.some((hold) => hold.gap === "two_factor");
  // Single sign-on is one workspace's at a time: the first that asks for it.
  const sso = held.find((hold) => hold.gap === "sso");
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-sm"
    >
      <ShieldAlert size={15} aria-hidden="true" className="hidden shrink-0 text-warn sm:block" />
      <span>
        {held.map((hold) => hold.reason).join(" ")}
      </span>
      {twoFactor && (
        <Link to="/settings/two-factor" className="font-medium underline underline-offset-4">
          Turn on two-factor authentication
        </Link>
      )}
      {sso && (
        <Link to={`/auth/sso/${sso.slug}?next=${encodeURIComponent(`/${sso.slug}`)}`} className="font-medium underline underline-offset-4">
          Sign in with {sso.slug}&apos;s single sign-on
        </Link>
      )}
    </div>
  );
}
