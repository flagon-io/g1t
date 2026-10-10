import type { GithubRepoLink } from "@g1t/contracts";
import { siGithub } from "simple-icons";

import { TimeAgo } from "./ui";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** GitHub's mark (from Simple Icons), for the buttons that go there. */
export function GithubMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className={className}>
      <path d={siGithub.path} />
    </svg>
  );
}

/**
 * "Continue with GitHub": a full page load to /auth/github, which sends the
 * browser on to GitHub.
 */
export function ContinueWithGithub({ href, label = "Continue with GitHub" }: { href: string; label?: string }) {
  return (
    <Button asChild variant="outline" className="w-full">
      <a href={href}>
        <GithubMark />
        {label}
      </a>
    </Button>
  );
}

/** The rule between "Continue with GitHub" and the form below it. */
export function OrDivider() {
  return (
    <div className="my-6 flex items-center gap-3 text-xs text-faint">
      <span className="h-px grow bg-line" />
      or
      <span className="h-px grow bg-line" />
    </div>
  );
}

/**
 * Where a repository's code was imported from on GitHub, on its overview,
 * and when. A repository that stays in step with GitHub says so beside its
 * name instead, and is managed under Settings → Mirroring.
 */
export function GithubLinkStrip({ link }: { link: GithubRepoLink }) {
  return (
    <Card tone="plain" radius="lg" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
      <span className="flex min-w-0 items-start gap-2 text-muted">
        <GithubMark className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          Imported from{" "}
          <a href={`https://github.com/${link.fullName}`} className="font-mono break-all text-fg hover:text-accent" target="_blank" rel="noreferrer">
            github.com/{link.fullName}
          </a>
        </span>
      </span>
      {link.syncedAt && (
        <span className="text-xs text-faint">
          copied <TimeAgo at={link.syncedAt} />
        </span>
      )}
      {link.lastError && <p className="w-full text-xs text-warn">{link.lastError}</p>}
    </Card>
  );
}
