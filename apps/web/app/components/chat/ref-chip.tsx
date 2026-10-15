/**
 * References in chat and in g1t's answers, as compact chips: an issue or
 * pull request (`acme/web#12`, `#12` in a repository's context, or a link
 * to one) with its title and state in a hover card, a commit by its short
 * hash, and any other page of the site by its path. One look everywhere a
 * conversation shows them (components/chat/text.tsx for people's messages,
 * components/ai-elements/response.tsx for g1t's answers).
 */
import { CircleDot, GitCommitHorizontal, GitPullRequest, Link2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import type { PullStatus } from "@g1t/contracts";

import { PullIcon, IssueIcon } from "../work-icons";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/cn";
import type { RefCard } from "../../routes/workspace/chat/ref";

/** The chip's frame: a quiet pill that reads as part of the sentence. */
const CHIP =
  "inline-flex max-w-full items-baseline gap-1 rounded-md border border-line bg-surface px-1.5 py-px align-baseline text-[0.8125em] font-medium text-fg-soft no-underline transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg [&_svg]:self-center";

const PULL_STATUSES: PullStatus[] = ["draft", "open", "merged", "closed"];

/** Cards already asked for in this tab, by where they come from: a chip seen twice asks once. */
const cards = new Map<string, Promise<RefCard | null>>();

function cardAt(url: string): Promise<RefCard | null> {
  let found = cards.get(url);
  if (!found) {
    found = fetch(url, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<RefCard>) : null))
      .catch(() => null);
    cards.set(url, found);
  }
  return found;
}

/**
 * The card itself, asked for from `url` once it opens: chat's
 * (routes/workspace/chat/ref.ts) for chips there, a repository's
 * (routes/repo/ref-card.ts) for references in its commits and timelines.
 */
export function RefCardBody({ url, repo, number }: { url: string; repo: string; number: number }) {
  const [card, setCard] = useState<RefCard | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    void cardAt(url).then((found) => live && setCard(found));
    return () => {
      live = false;
    };
  }, [url]);
  if (card === "loading") {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }
  if (!card) return <p className="text-xs text-muted">Nothing you can see is numbered #{number} in {repo}.</p>;
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5">
        {card.kind === "pull" ? (
          <PullIcon status={PULL_STATUSES.find((s) => s === card.state) ?? "open"} size={16} />
        ) : (
          <IssueIcon issue={{ state: card.state === "open" ? "open" : "closed", reason: null }} size={16} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted">
          {card.repo} · {card.kind === "pull" ? "Pull request" : "Issue"} #{card.number}
        </span>
        <span className="mt-0.5 block font-medium leading-snug text-fg">{card.title}</span>
        <span className="mt-1 block text-xs text-faint capitalize">{card.state}</span>
      </span>
    </div>
  );
}

/** `acme/web#12`: a chip to the issue or pull request, its card on hover. */
export function IssueChip({ slug, repo, number, label, to, kind }: { slug: string; repo: string; number: number; label?: ReactNode; to?: string; kind?: "issue" | "pull" }) {
  const href = to ?? `/${repo}/issues/${number}`;
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link to={href} className={CHIP} data-ref="issue">
          {kind === "pull" ? <GitPullRequest size={12} className="text-faint" /> : <CircleDot size={12} className="text-faint" />}
          <span className="truncate">{label ?? `${repo}#${number}`}</span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <RefCardBody url={`/${slug}/-/chat/ref?repo=${encodeURIComponent(repo)}&number=${number}`} repo={repo} number={number} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A commit, by its short hash. */
export function CommitChip({ href, sha }: { href: string; sha: string }) {
  return (
    <Link to={href} className={cn(CHIP, "font-mono")} data-ref="commit">
      <GitCommitHorizontal size={12} className="text-faint" />
      {sha.slice(0, 7)}
    </Link>
  );
}

/** Another page of the site, linked by its path or a full link to it. */
export function PageChip({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link to={href} className={CHIP}>
      <Link2 size={12} className="text-faint" />
      <span className="truncate">{children}</span>
    </Link>
  );
}
