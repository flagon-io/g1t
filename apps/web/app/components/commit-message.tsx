/**
 * A commit message's text with its references linked: `#12` and
 * `acme/web#12` to the work item or pull request they name (lib/refs.ts),
 * with its card on hover, and a full hash to its commit. Where the whole
 * message links to its commit (a list of commits), the text between
 * references links there and each reference links on its own, so no link
 * sits inside another.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

import { RefCardBody } from "./chat/ref-chip";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { cn } from "../lib/cn";
import { messageParts } from "../lib/commit-message";
import { type RefContext, itemPath, repoRefPath } from "../lib/refs";

/**
 * `#12` read in `scope`, a repository or a workspace: a link to what it
 * names, its card on hover. In a repository both are its `ref` page
 * (routes/repo/ref-card.ts); in a workspace, the work item's page and the
 * workspace's `-/work/ref` card.
 */
export function RefLink({ scope, number, className, children }: { scope: RefContext; number: number; className?: string; children: ReactNode }) {
  const to = "repo" in scope ? repoRefPath(scope.repo, number) : itemPath(scope.workspace, number);
  const card = "repo" in scope ? to : `/${scope.workspace}/-/work/ref/${number}`;
  const where = "repo" in scope ? `${scope.repo.namespace}/${scope.repo.name}` : scope.workspace;
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link to={to} className={cn("relative z-10", className)} data-ref="ref">
          {children}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <RefCardBody url={card} where={where} number={number} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** `owner/name` as a reference's repository. */
export function repoScope(path: string): RefContext {
  const [namespace = "", name = ""] = path.replace(/^\//, "").split("/");
  return { repo: { namespace, name } };
}

/**
 * `text` with its references linked, in the repository at `base`
 * (`/owner/name`). With `to`, the text between them links there, styled
 * by `linkClassName`.
 */
export function CommitText({
  text,
  base,
  to,
  linkClassName,
  refClassName = "text-accent hover:underline",
}: {
  text: string;
  base: string;
  to?: string;
  linkClassName?: string;
  refClassName?: string;
}) {
  const repo = base.replace(/^\//, "");
  return (
    <>
      {messageParts(text).map((part, index) => {
        if (part.kind === "ref") {
          return (
            <RefLink key={index} scope={repoScope(part.repo ?? repo)} number={part.number} className={refClassName}>
              {part.text}
            </RefLink>
          );
        }
        if (part.kind === "commit") {
          return (
            <Link key={index} to={`${base}/commit/${part.sha}`} className={cn("relative z-10 font-mono text-[0.9em]", refClassName)}>
              {part.sha.slice(0, 7)}
            </Link>
          );
        }
        return to ? (
          <Link key={index} to={to} prefetch="intent" className={linkClassName}>
            {part.text}
          </Link>
        ) : (
          part.text
        );
      })}
    </>
  );
}
