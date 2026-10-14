/**
 * Forking a repository: a button in the project's header beside Star, with
 * how many forks it has, which leads to them. The button opens the fork
 * page (routes/repo/fork.tsx); someone signed out is sent to sign in first.
 * A private repository whose admins have not allowed forking shows it to
 * its admins only, turned off, saying where to allow it.
 */
import { GitFork } from "lucide-react";
import { Link } from "react-router";

import { cn } from "../lib/cn";
import { Hint } from "./ui/hint";

const BOX = "inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-line text-[0.8125rem]";
const FACE = "inline-flex h-full items-center gap-1.5 px-2.5 text-fg/80 outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

/** What the header knows about its forks: how many (at most 100 counted) and whether it can be forked. */
export type Forking = {
  /** Forks the viewer can see, up to 100. */
  count: number;
  /** Whether there are more than `count`. */
  more: boolean;
  /** Whether it may be forked: public, or private with forking allowed. */
  allowed: boolean;
};

export function ForkButton({ base, name, forking, signedIn }: { base: string; name: string; forking: Forking; signedIn: boolean }) {
  const shown = forking.more ? `${forking.count}+` : String(forking.count);
  const words = `${shown} ${forking.count === 1 && !forking.more ? "fork" : "forks"}`;
  const face = (
    <>
      <GitFork size={14} />
      <span className="hidden sm:inline">Fork</span>
    </>
  );
  const counter = (
    <Hint label={words}>
      <Link
        to={`${base}/forks`}
        aria-label={`${words}: who forked it`}
        className="inline-flex h-full items-center border-l border-line px-2 font-medium tabular-nums text-fg/80 outline-none hover:bg-surface hover:text-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {shown}
      </Link>
    </Hint>
  );
  if (!forking.allowed) {
    return (
      <span className={BOX}>
        <Hint label="Forking is off for this private repository. Allow it under Settings, Repository.">
          <Link
            to={`${base}/settings/repository#forking`}
            aria-label={`Forking ${name} is off: allow it in Settings`}
            className={cn(FACE, "text-faint hover:text-muted")}
          >
            {face}
          </Link>
        </Hint>
        {counter}
      </span>
    );
  }
  const to = signedIn ? `${base}/fork` : `/login?next=${encodeURIComponent(`${base}/fork`)}`;
  return (
    <span className={BOX}>
      <Hint label={`Fork ${name} into a workspace of yours`}>
        <Link to={to} aria-label={signedIn ? `Fork ${name}` : `Sign in to fork ${name}`} className={FACE}>
          {face}
        </Link>
      </Hint>
      {counter}
    </span>
  );
}
