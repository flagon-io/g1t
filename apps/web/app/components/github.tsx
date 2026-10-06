import type { GithubRepoLink } from "@g1t/contracts";
import { Form } from "react-router";
import { siGithub } from "simple-icons";

import { TimeAgo } from "./ui";

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
    <a
      href={href}
      className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg"
    >
      <GithubMark />
      {label}
    </a>
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

const LINK_LABEL: Record<GithubRepoLink["mode"], string> = {
  import: "Imported from",
  mirror: "Mirrored from",
  push: "Pushed to",
};

/**
 * Where a repository's code came from on GitHub, on its overview: how it
 * stays in step, when it last did, and what went wrong if anything did.
 */
export function GithubLinkStrip({ link }: { link: GithubRepoLink }) {
  const syncing = link.mode !== "import";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-4 py-2.5 text-sm">
      <span className="flex min-w-0 items-start gap-2 text-muted">
        <GithubMark className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          {LINK_LABEL[link.mode]}{" "}
          <a href={`https://github.com/${link.fullName}`} className="font-mono break-all text-fg hover:text-accent" target="_blank" rel="noreferrer">
            github.com/{link.fullName}
          </a>
        </span>
      </span>
      {link.syncedAt && (
        <span className="text-xs text-faint">
          {syncing ? "synced" : "copied"} <TimeAgo at={link.syncedAt} />
        </span>
      )}
      {syncing && (
        <Form method="post" className="ml-auto flex items-center gap-3">
          <button type="submit" name="intent" value="github-sync" className="text-xs text-muted hover:text-fg">
            Sync now
          </button>
          <button type="submit" name="intent" value="github-stop" className="text-xs text-faint hover:text-danger">
            Stop {link.mode === "mirror" ? "mirroring" : "pushing"}
          </button>
        </Form>
      )}
      {link.lastError && <p className="w-full text-xs text-warn">{link.lastError}</p>}
    </div>
  );
}
