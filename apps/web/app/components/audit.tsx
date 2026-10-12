/** The audit log's entries, as the workspace's Audit log page shows them. */

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import type { AuditEntry } from "@g1t/contracts";

import { actionLabel, ruleLabel, targetLabel } from "../lib/audit";
import { TimeAgo } from "./ui";
import { Avatar } from "./ui/avatar";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";

/** Allowed or denied, and by which rule. */
export function OutcomeMark({ entry }: { entry: AuditEntry }) {
  const denied = entry.outcome === "denied";
  return (
    <Hint label={`${entry.outcome}: ${ruleLabel(entry.rule)} (${entry.rule})`}>
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
          denied ? "bg-danger/10 text-danger ring-1 ring-danger/30" : "bg-raised text-muted ring-1 ring-line"
        }`}
      >
        {denied ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
        {entry.outcome}
      </span>
    </Hint>
  );
}

/** Who acted, with whoever acted for someone (an app, or an old agent) shown as working for them. */
export function ActorLine({ entry }: { entry: AuditEntry }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={entry.agent ?? entry.actor} size={18} square={entry.actorKind === "workspace"} />
      <span className="truncate">
        {entry.onBehalfOf ? (
          <>
            <span className="font-medium">{entry.agent ?? entry.actor}</span>
            <span className="text-muted"> on behalf of </span>
            <span className="font-medium">{entry.onBehalfOf}</span>
          </>
        ) : (
          <span className="font-medium">{entry.actor}</span>
        )}
      </span>
    </span>
  );
}

/** The workspace's log, one row an entry, newest first. */
export function AuditTable({ entries, base }: { entries: AuditEntry[]; base: string }) {
  return (
    <Card asChild divided>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id} className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[9rem_1fr_auto]">
            <span className="text-xs leading-5 text-faint">
              <TimeAgo at={entry.time} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ActorLine entry={entry} />
                <span className="font-mono text-xs text-fg/85">{actionLabel(entry.action)}</span>
                <span className="truncate font-mono text-xs text-muted">{targetLabel(entry)}</span>
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-faint">
                <Hint label={entry.rule}>
                  <span>{ruleLabel(entry.rule)}</span>
                </Hint>
                <span>{entry.surface.toUpperCase()}</span>
                {entry.result && entry.result !== "ok" && <span>result: {entry.result}</span>}
                {entry.runId && (
                  <Link to={`${base}?run=${encodeURIComponent(entry.runId)}`} className="hover:text-fg">
                    everything this run did
                  </Link>
                )}
                {entry.credentialId && (
                  <Hint label="Credential">
                    <span className="font-mono">
                      <span className="sr-only">Credential </span>
                      {entry.credentialId}
                    </span>
                  </Hint>
                )}
                <Hint label="Request id">
                  <span className="font-mono">
                    <span className="sr-only">Request id </span>
                    {entry.requestId}
                  </span>
                </Hint>
              </p>
              {entry.outcome === "denied" && entry.message && <p className="mt-1 text-xs text-danger">{entry.message}</p>}
            </div>
            <span className="sm:text-right">
              <OutcomeMark entry={entry} />
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
