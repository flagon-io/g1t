/**
 * Starring a repository: a button in the project's header beside Watch,
 * with how many have starred it, which leads to who did. Posts to the
 * repository's star route (routes/repo/star.ts); while it is on its way it
 * shows as done. Someone signed out is sent to sign in.
 */
import { Star } from "lucide-react";
import { Link, useFetcher, useLocation } from "react-router";

import type { Stars } from "@g1t/contracts";

import { compact } from "../lib/about";
import { cn } from "../lib/cn";
import { Hint } from "./ui/hint";

const BOX = "inline-flex h-8 shrink-0 items-center text-[0.8125rem] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function StarButton({ base, name, stars, signedIn }: { base: string; name: string; stars: Stars; signedIn: boolean }) {
  const fetcher = useFetcher<{ error: string | null; stars: Stars | null }>({ key: `star:${base}` });
  const { pathname, search } = useLocation();
  const asked = fetcher.formData?.get("intent");
  const done = fetcher.state === "idle" ? fetcher.data?.stars : null;
  const starred = asked === "star" ? true : asked === "unstar" ? false : (done?.starred ?? stars.starred);
  const shownCount = asked
    ? stars.stars + (asked === "star" && !stars.starred ? 1 : asked === "unstar" && stars.starred ? -1 : 0)
    : (done?.stars ?? stars.stars);
  const error = fetcher.state === "idle" ? fetcher.data?.error : null;
  const label = starred ? `Unstar ${name}` : `Star ${name}`;
  const face = (
    <>
      <Star size={14} className={starred ? "fill-current text-warn" : undefined} />
      <span className="hidden sm:inline">{starred ? "Starred" : "Star"}</span>
    </>
  );
  const counter = (
    <Hint label={`${shownCount.toLocaleString("en-US")} ${shownCount === 1 ? "star" : "stars"}`}>
      <Link
        to={`${base}/stargazers`}
        aria-label={`${shownCount.toLocaleString("en-US")} ${shownCount === 1 ? "star" : "stars"}: who starred it`}
        className="inline-flex h-full items-center border-l border-line px-2 font-medium tabular-nums text-fg/80 hover:bg-surface hover:text-accent"
      >
        {compact(shownCount)}
      </Link>
    </Hint>
  );
  if (!signedIn) {
    return (
      <span className={cn(BOX, "overflow-hidden rounded-md border border-line")}>
        <Link
          to={`/login?next=${encodeURIComponent(pathname + search)}`}
          aria-label={`Sign in to star ${name}`}
          className="inline-flex h-full items-center gap-1.5 px-2.5 text-fg/80 hover:bg-surface hover:text-fg"
        >
          {face}
        </Link>
        {counter}
      </span>
    );
  }
  return (
    <fetcher.Form method="post" action={`${base}/star`} className={cn(BOX, "overflow-hidden rounded-md border border-line", error && "border-danger/60")}>
      <input type="hidden" name="intent" value={starred ? "unstar" : "star"} />
      <Hint label={error ?? null}>
        <button
          type="submit"
          aria-label={label}
          aria-pressed={starred}
          className="inline-flex h-full items-center gap-1.5 px-2.5 text-fg/80 hover:bg-surface hover:text-fg"
        >
          {face}
        </button>
      </Hint>
      {counter}
    </fetcher.Form>
  );
}
