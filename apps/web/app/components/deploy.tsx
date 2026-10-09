/** Small pieces every page about deployments shares. */
import type { AnchorHTMLAttributes } from "react";

import type { DeployStatus } from "@g1t/contracts";

export const DEPLOY_STATUS: Record<DeployStatus, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-muted" },
  building: { label: "Building", tone: "text-warn" },
  ready: { label: "Live", tone: "text-success" },
  replaced: { label: "Replaced", tone: "text-faint" },
  down: { label: "Down", tone: "text-faint" },
  failed: { label: "Failed", tone: "text-danger" },
  skipped: { label: "Skipped", tone: "text-faint" },
};

export function StatusDot({ status, label }: { status: DeployStatus; label?: string }) {
  const { label: word, tone } = DEPLOY_STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      <span className={`size-1.5 rounded-full bg-current ${status === "building" || status === "queued" ? "animate-pulse" : ""}`} />
      {label ?? word}
    </span>
  );
}

/** An address on g1t.page without its scheme. */
export function host(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * A link to where something runs: a g1t.page address, an environment's
 * URL, a preview, a project's homepage. It always opens in a new tab, so
 * the page about it stays open behind it. `rel` adds to noopener and
 * noreferrer (nofollow, say), never replaces them.
 */
export function DeployLink({ rel, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} target="_blank" rel={rel ? `noopener noreferrer ${rel}` : "noopener noreferrer"} />;
}
