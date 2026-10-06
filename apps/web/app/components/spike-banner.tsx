import { AlertTriangle, OctagonX, Play } from "lucide-react";
import { Form } from "react-router";

import type { Entitlements } from "@g1t/contracts";

import { dollars } from "../lib/billing";
import { Button } from "./ui";

/**
 * Compute paused by a spend spike, with the owners' choice: keep going for
 * 24 hours, or stop. Also a hold by g1t, which only g1t lifts. Posts to the
 * workspace's billing page, so it works from anywhere in the app.
 */
export function SpikeBanner({
  slug,
  entitlements,
  owner,
  compact = false,
}: {
  slug: string;
  entitlements: Pick<Entitlements, "paused" | "spike">;
  owner: boolean;
  compact?: boolean;
}) {
  const spike = entitlements.spike?.status === "open" ? entitlements.spike : null;
  if (!spike && !entitlements.paused) return null;
  const text = spike
    ? `Spending spiked: ${dollars(spike.hourMicros)} in the last hour, against a usual ${dollars(spike.averageMicros)}. New agents, checks and builds wait until an owner decides; work already running finishes.`
    : `g1t paused new compute for this workspace: ${entitlements.paused}`;
  return (
    <div
      id="spike"
      role="alert"
      className={
        compact
          ? "flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm"
          : "mb-6 scroll-mt-20 rounded-xl border border-danger/40 bg-danger/5 p-5"
      }
    >
      <p className={compact ? "flex items-center gap-2" : "flex gap-2.5 text-sm"}>
        <AlertTriangle size={compact ? 15 : 17} className="shrink-0 text-danger" />
        <span>{compact ? (spike ? `${slug}: spending spiked, so new compute is paused.` : `${slug}: new compute is paused.`) : text}</span>
      </p>
      {spike && owner ? (
        <Form method="post" action={`/${slug}/-/billing`} className={compact ? "flex gap-2" : "mt-4 flex flex-wrap gap-2"}>
          <input type="hidden" name="intent" value="spike" />
          <Button variant="accent" type="submit" name="decision" value="keep">
            <Play size={14} />
            Keep going
          </Button>
          <Button variant="quiet" type="submit" name="decision" value="stop">
            <OctagonX size={14} />
            Stop
          </Button>
        </Form>
      ) : spike ? (
        <p className={compact ? "text-xs text-muted" : "mt-3 text-sm text-muted"}>An owner chooses Keep going or Stop on Billing.</p>
      ) : (
        <p className={compact ? "text-xs text-muted" : "mt-3 text-sm text-muted"}>
          Write to <a href="mailto:hey@flagon.io" className="underline underline-offset-2">hey@flagon.io</a> to have it looked at.
        </p>
      )}
      {!compact && spike && (
        <p className="mt-3 text-xs text-faint">
          Keep going lets work start again for 24 hours, unless spending doubles again first. Stop keeps new compute paused until you
          choose Keep going.
        </p>
      )}
    </div>
  );
}
