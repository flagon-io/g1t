import type { ReactNode } from "react";
import { Link } from "react-router";

import { Logo } from "./logo";
import { Progress, useLeaving } from "./shell";
import { POLICIES } from "../lib/legal";
import { STATUS_URL } from "../lib/status";

const FOOT_LINK = "rounded px-1.5 py-1 text-xs text-faint transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent outline-none";

/**
 * The frame for signing in, signing up and choosing a workspace
 * (lib/chrome.ts, `standalone`): no header, no sidebar, no rail. The
 * logo, then the page in a narrow column at the centre, and a quiet row
 * of links at the foot of the window.
 */
export function StandaloneFrame({ children }: { children: ReactNode }) {
  const leaving = useLeaving();
  const terms = POLICIES.find((policy) => policy.slug === "terms");
  const privacy = POLICIES.find((policy) => policy.slug === "privacy");
  return (
    <div className="flex min-h-dvh flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <Progress />
      <div id="content" tabIndex={-1} {...leaving} className={`flex grow flex-col items-center px-4 pt-[max(2.5rem,9vh)] pb-10 outline-none ${leaving.className}`}>
        <Link to="/" aria-label="g1t" className="flex rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <Logo className="text-[1.75rem]" />
        </Link>
        <div className="w-full">{children}</div>
      </div>
      <nav aria-label="About g1t" className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1 px-4 pb-5">
        {terms && (
          <Link to={`/policies/${terms.slug}`} className={FOOT_LINK}>
            Terms
          </Link>
        )}
        {privacy && (
          <Link to={`/policies/${privacy.slug}`} className={FOOT_LINK}>
            Privacy
          </Link>
        )}
        <a href="https://docs.g1t.sh/" className={FOOT_LINK}>
          Docs
        </a>
        <a href={STATUS_URL} className={FOOT_LINK}>
          Status
        </a>
        <Link to="/support" className={FOOT_LINK}>
          Support
        </Link>
      </nav>
    </div>
  );
}
