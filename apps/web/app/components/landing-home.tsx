/**
 * The landing page's pictures of Home (routes/workspace/home.tsx), drawn
 * from the same parts and words as the real cards in components/home.tsx
 * and components/home-ask.tsx: What changed and Landed, for coming back to
 * what happened; Settled for you, Where you're needed and Start here,
 * for what still needs you. They are pictures, so nothing in them takes
 * focus or a click (`inert`), and the page reads them as one image.
 */
import { ArrowRight, ArrowUp, CheckCheck, GitCommitHorizontal, GitMerge, GitPullRequest, RotateCcw, Rocket, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { MarkGlyph } from "./logo";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** One of Home's cards, as components/home.tsx draws it: a title, a few words under it, then its rows. */
function HomeCard({ title, hint, children }: { title: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <Card tone="bg" className="overflow-hidden rounded-2xl text-left shadow-sm">
      <header className="px-4 pt-3.5 pb-2.5">
        <p className="text-sm font-semibold text-fg">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </header>
      {children}
    </Card>
  );
}

const ROW = "flex items-center gap-3 border-t border-line px-4 py-2.5";

/** A picture, not a control: kept out of the tab order and read as one image. */
function Picture({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="img" aria-label={label} className="space-y-3">
      <div inert className="space-y-3">
        {children}
      </div>
    </div>
  );
}

/** Coming back: the Ask box, What changed in plain English, and Landed with whether each change is live. */
export function WhatChangedArt() {
  return (
    <Picture label="Home: What are we building today? over a box that asks g1t, What changed summarizing in plain English what landed, and Landed with whether each change is live">
      <div className="text-center">
        <p className="text-lg font-semibold tracking-tight text-fg">What are we building today?</p>
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-line bg-bg p-1.5 pl-3.5 text-left shadow-sm">
          <MarkGlyph className="h-3.5 shrink-0" />
          <span className="min-w-0 grow truncate text-[0.8125rem] text-faint">Ask g1t what changed, what&apos;s blocked, or what to do next</span>
          <Button type="button" variant="accent" size="icon-xs" tabIndex={-1} aria-hidden="true">
            <ArrowUp size={13} />
          </Button>
        </div>
        <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
          <Badge tone="accent" size="md" className="whitespace-normal">
            Summarize what changed since I was last here
          </Badge>
          <Badge size="md" className="hidden sm:inline-flex">
            What needs me first?
          </Badge>
        </div>
      </div>

      <HomeCard title="What changed" hint="In plain English, since I was last here">
        <div className="space-y-2 px-4 pb-3.5 text-[0.8125rem] leading-relaxed text-fg-soft">
          <p>
            Two changes landed in <span className="font-medium text-fg">acme/web</span>. CSV exports now stream in batches of 1,000 rows, so the
            largest accounts no longer time out; it went live 9 minutes after the merge queue merged it. Jordan pinned the build image's cache key, which fixed last night's failed deploy.
          </p>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
            <Button type="button" variant="soft" size="xs" tabIndex={-1}>
              <MarkGlyph className="h-2.5" />
              Ask a follow-up
            </Button>
            <Button type="button" variant="ghost" size="xs" tabIndex={-1}>
              <RotateCcw size={12} />
              Summarize again
            </Button>
          </div>
        </div>
      </HomeCard>

      <HomeCard title="Landed" hint="1 pull request merged · 1 push">
        {[
          { title: "Stream CSV exports in batches", detail: "web#431 · by priya", push: false, ship: <Badge tone="success"><Rocket size={10} aria-hidden="true" />Live 9 min after merge</Badge> },
          { title: "Pin the build image's cache key", detail: "web · 1 push by jordan", push: true, ship: <Badge tone="success"><Rocket size={10} aria-hidden="true" />Live 4 min after push</Badge> },
        ].map((row) => (
          <div key={row.title} className={ROW}>
            {row.push ? <GitCommitHorizontal size={15} className="shrink-0 text-muted" aria-hidden="true" /> : <GitMerge size={15} className="shrink-0 text-merged" aria-hidden="true" />}
            <div className="min-w-0 grow">
              <p className="truncate text-sm text-fg">{row.title}</p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-xs text-muted">{row.detail}</span>
                {row.ship}
              </div>
            </div>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md text-accent">
              <Sparkles size={13} aria-hidden="true" />
            </span>
          </div>
        ))}
      </HomeCard>
    </Picture>
  );
}

/** What still needs you: what settled by itself, Where you're needed, and Start here. */
export function NeedsYouArt() {
  return (
    <Picture label="Home: Settled for you lists notifications that settled themselves and why, Where you're needed lists a pull request ready to merge and a review asked of you, and Start here opens the one to do first">
      <HomeCard title="Settled for you" hint="3 finished by themselves">
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          <Badge tone="success" size="md">3 notifications settled</Badge>
          <Badge tone="warn" size="md">2 things still need you</Badge>
        </div>
        {[
          { title: "CI failed on main", why: "CI passed in run 330" },
          { title: "Review requested: Cache the dependency graph", why: "Merged by @ana" },
        ].map((row) => (
          <div key={row.title} className={ROW}>
            <CheckCheck size={15} className="shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0 grow">
              <p className="truncate text-sm text-fg">{row.title}</p>
              <p className="truncate text-xs text-fg-soft">{row.why}</p>
            </div>
          </div>
        ))}
      </HomeCard>

      <HomeCard title="Where you're needed">
        {[
          { icon: <GitMerge size={15} className="shrink-0 text-success" aria-hidden="true" />, title: "Retry webhook deliveries with backoff", detail: "acme/web #433 · Ready to land when you merge it.", stake: "Ready to merge", action: "Open" },
          { icon: <GitPullRequest size={15} className="shrink-0 text-info" aria-hidden="true" />, title: "Add audit log export", detail: "acme/web #435 · Your review", stake: "+212 −40", action: "Review" },
        ].map((row) => (
          <div key={row.title} className={ROW}>
            {row.icon}
            <div className="min-w-0 grow">
              <p className="truncate text-sm font-semibold text-fg">{row.title}</p>
              <p className="truncate text-xs text-muted">{row.detail}</p>
            </div>
            <span className="hidden shrink-0 text-xs font-medium text-fg-soft sm:inline">{row.stake}</span>
            <Button type="button" variant="outline" size="xs" tabIndex={-1} className="border-line-strong px-2.5 text-fg">
              {row.action}
            </Button>
          </div>
        ))}
      </HomeCard>

      <HomeCard
        title={
          <>
            Start here <span className="font-normal text-faint">· picked by g1t</span>
          </>
        }
      >
        <div className="px-4 pb-4">
          <p className="text-sm font-semibold text-fg">Retry webhook deliveries with backoff</p>
          <p className="mt-2.5 rounded-lg bg-raised/60 px-3 py-2 text-xs leading-relaxed text-fg-soft">
            <span className="font-medium text-fg">Why this one: </span>
            Everything it needs is met; it lands when you merge it.
          </p>
          <Button type="button" variant="accent" size="sm" tabIndex={-1} className="mt-3">
            Open pull request
            <ArrowRight size={13} />
          </Button>
        </div>
      </HomeCard>
    </Picture>
  );
}
