/** Small pieces every page about deployments shares. */
import type { DeployStatus } from "@g1t/contracts";

export const DEPLOY_STATUS: Record<DeployStatus, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-muted" },
  building: { label: "Building", tone: "text-warn" },
  ready: { label: "Live", tone: "text-accent" },
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
