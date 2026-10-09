import { ChevronRight, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AccessToken } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { permissionChips, reachSummary, statusBadge } from "../lib/access-tokens";
import { describeExpiry } from "../lib/token-scopes";
import { ButtonLink, CopyLine, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";

// One access token in a line, and the list of them: the same on your
// settings, a workspace's tokens and a workspace's view of its members'
// tokens.

/** What a token reaches and may do, under its name. */
export function TokenFacts({ token, className }: { token: AccessToken; className?: string }) {
  const chips = permissionChips(token);
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-xs text-muted">{reachSummary(token)}</p>
      <div className="flex flex-wrap gap-1.5">
        {chips.length === 0 && <span className="text-xs text-faint">No permissions</span>}
        {chips.map((chip) => (
          <span
            key={chip.label}
            className={cn(
              "rounded border px-1.5 py-px text-[0.6875rem]",
              chip.dangerous ? "border-danger/40 text-danger" : "border-line text-muted",
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>
      {token.repositorySelection === "selected" && (token.repositories?.length ?? 0) > 0 && (
        <p className="truncate font-mono text-[0.6875rem] text-faint">{token.repositories!.join(", ")}</p>
      )}
      {token.reviewReason && <p className="text-xs text-faint">Owner's note: {token.reviewReason}</p>}
    </div>
  );
}

/** When it was made, by whom, last used, and when it expires. */
export function TokenMeta({ token }: { token: AccessToken }) {
  const expiry = describeExpiry(token.expiresAt);
  return (
    <p className="text-xs text-faint">
      Created <TimeAgo at={token.createdAt} />
      {token.workspaceOwned &&
        (token.createdBy ? (
          <>
            {" "}
            by <span className="font-mono">{token.createdBy}</span>
          </>
        ) : (
          " by someone who has since left g1t"
        ))}{" "}
      ·{" "}
      {token.lastUsedAt ? (
        <>
          last used <TimeAgo at={token.lastUsedAt} />
        </>
      ) : (
        "never used"
      )}{" "}
      · <span className={expiry === "Expired" ? "text-danger" : expiry === "No expiry" ? "text-warn" : undefined}>{expiry}</span>
    </p>
  );
}

/** Its badges: waiting, denied or revoked; Admin on a workspace's token. */
export function TokenBadges({ token }: { token: AccessToken }) {
  const badge = statusBadge(token.status);
  return (
    <>
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      {token.workspaceOwned && <Badge tone={token.admin ? "danger" : "neutral"}>{token.admin ? "Admin" : "Write"}</Badge>}
      {token.website && <Badge tone="warn">Uses the website</Badge>}
    </>
  );
}

/** A list of tokens, each a link to its page. */
export function TokenList({
  tokens,
  href,
  lead,
  aside,
}: {
  tokens: AccessToken[];
  href: (token: AccessToken) => string;
  /** Before a token's name, such as whose it is. */
  lead?: (token: AccessToken) => ReactNode;
  /** After it, such as an action. */
  aside?: (token: AccessToken) => ReactNode;
}) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {tokens.map((token) => (
        <li key={token.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
          <div className="min-w-0 grow space-y-1">
            <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              {lead?.(token)}
              <Link to={href(token)} className="flex min-w-0 items-center gap-1.5 font-medium text-fg hover:underline">
                <KeyRound size={13} className="shrink-0 text-faint" />
                <span className="truncate">{token.name}</span>
              </Link>
              <TokenBadges token={token} />
            </p>
            {token.description && <p className="truncate text-xs text-muted">{token.description}</p>}
            <TokenMeta token={token} />
            <TokenFacts token={token} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {aside?.(token)}
            <Link to={href(token)} aria-label={`Open ${token.name}`} className="hidden text-faint hover:text-fg sm:block">
              <ChevronRight size={16} />
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A token just made: the secret, once, and what it is. */
export function TokenCreated({ secret, token, back }: { secret: string; token: AccessToken; back: string }) {
  return (
    <div className="space-y-4 rounded-xl border border-accent/40 bg-surface p-4 sm:p-5">
      <p className="text-sm">
        <span className="font-medium">{token.name}</span> is ready. Copy it now: it will not be shown again.
      </p>
      <CopyLine text={secret} />
      <div className="flex flex-wrap items-center gap-2">
        <TokenBadges token={token} />
      </div>
      <TokenMeta token={token} />
      <TokenFacts token={token} />
      <ButtonLink variant="quiet" to={back}>
        Back to tokens
      </ButtonLink>
    </div>
  );
}
