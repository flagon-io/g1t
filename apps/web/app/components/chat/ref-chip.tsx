/**
 * References in chat and in g1t's answers, as compact chips: a work item
 * or pull request (`acme/web#12`, `acme#12`, `#12` read as lib/refs.ts
 * says, or a link to one) with its title and state in a hover card, a
 * commit by its short hash, and any other page of the site by its path.
 * One look everywhere a conversation shows them (components/chat/text.tsx
 * for people's messages, components/ai-elements/response.tsx for g1t's
 * answers).
 */
import { Bot, GitCommitHorizontal, GitPullRequest, Link2, ListTodo } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import type { PullStatus } from "@g1t/contracts";

import { ItemIcon, PullIcon } from "../work-icons";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/cn";
import type { RefContext } from "../../lib/refs";
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

/** Where `#number` is read, in words: `acme/web` or `acme`. */
function scopeName(scope: RefContext): string {
  return "repo" in scope ? `${scope.repo.namespace}/${scope.repo.name}` : scope.workspace;
}

/** Chat's card for `#number` read in `scope`, asked for in the workspace `slug` (routes/workspace/chat/ref.ts). */
export function chatCardUrl(slug: string, scope: RefContext, number: number): string {
  const where = "repo" in scope ? `repo=${encodeURIComponent(scopeName(scope))}` : `workspace=${encodeURIComponent(scope.workspace)}`;
  return `/${slug}/-/chat/ref?${where}&number=${number}`;
}

/**
 * The card itself, asked for from `url` once it opens: chat's
 * (routes/workspace/chat/ref.ts) for chips there, a repository's
 * (routes/repo/ref-card.ts) for references in its commits and timelines.
 * `where` names the repository or workspace it was read in.
 */
export function RefCardBody({ url, where, number }: { url: string; where: string; number: number }) {
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
  if (!card)
    return (
      <p className="text-xs text-muted">
        Nothing you can see is numbered #{number} in {where}.
      </p>
    );
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5">
        {card.kind === "pull" ? (
          <PullIcon status={PULL_STATUSES.find((s) => s === card.state) ?? "open"} size={16} />
        ) : (
          <ItemIcon item={{ state: card.state === "open" ? "open" : "closed", reason: card.state === "not planned" ? "not_planned" : null }} size={16} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted">
          {card.kind === "pull" ? `${card.repo} · Pull request` : `${card.workspace} · Work item`} #{card.number}
        </span>
        <span className="mt-0.5 block font-medium leading-snug text-fg">{card.title}</span>
        <span className="mt-1 block text-xs text-faint capitalize">{card.state}</span>
      </span>
    </div>
  );
}

/**
 * `acme/web#12` or `#12`: a chip to the work item or pull request it names
 * (`to`), its card on hover, read in `scope` and asked for in the
 * workspace `slug`.
 */
export function RefChip({
  slug,
  scope,
  number,
  label,
  to,
  kind,
}: {
  slug: string;
  scope: RefContext;
  number: number;
  label?: ReactNode;
  to: string;
  kind?: "item" | "pull";
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link to={to} className={CHIP} data-ref="ref">
          {kind === "pull" ? <GitPullRequest size={12} className="text-faint" /> : <ListTodo size={12} className="text-faint" />}
          <span className="truncate">{label ?? `${"repo" in scope ? scopeName(scope) : ""}#${number}`}</span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <RefCardBody url={chatCardUrl(slug, scope, number)} where={scopeName(scope)} number={number} />
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

/** A session, by the end of its id, which is what tells sessions started together apart. */
export function SessionChip({ href, id }: { href: string; id: string }) {
  return (
    <Link to={href} className={cn(CHIP, "font-mono")} data-ref="session">
      <Bot size={12} className="text-faint" />
      {id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id}
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
