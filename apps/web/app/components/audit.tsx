/**
 * The audit log's entries, as the workspace's Audit log page, an agent
 * run's page and a pull request's Agent panel show them.
 */

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { Link, useFetcher } from "react-router";

import type { AuditEntry } from "@g1t/contracts";

import { actionLabel, actorLabel, ruleLabel, targetLabel } from "../lib/audit";
import { Avatar, TimeAgo } from "./ui";

function clock(at: string): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** Allowed or denied, and by which rule. */
export function OutcomeMark({ entry }: { entry: AuditEntry }) {
  const denied = entry.outcome === "denied";
  return (
    <span
      title={`${entry.outcome}: ${ruleLabel(entry.rule)} (${entry.rule})`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
        denied ? "bg-danger/10 text-danger ring-1 ring-danger/30" : "bg-raised text-muted ring-1 ring-line"
      }`}
    >
      {denied ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
      {entry.outcome}
    </span>
  );
}

/** Who acted, with an agent shown as working for someone. */
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
    <ol className="divide-y divide-line rounded-xl border border-line bg-surface">
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
              <span title={entry.rule}>{ruleLabel(entry.rule)}</span>
              <span>{entry.surface.toUpperCase()}</span>
              {entry.result && entry.result !== "ok" && <span>result: {entry.result}</span>}
              {entry.runId && entry.repo && (
                <Link to={`/${entry.repo}/agents/runs/${entry.runId}`} className="hover:text-fg">
                  {entry.runKind ?? "agent"} run
                </Link>
              )}
              {entry.runId && (
                <Link to={`${base}?run=${encodeURIComponent(entry.runId)}`} className="hover:text-fg">
                  everything this run did
                </Link>
              )}
              {entry.credentialId && (
                <span className="font-mono" title="Credential">
                  {entry.credentialId}
                </span>
              )}
              <span className="font-mono" title="Request id">
                {entry.requestId}
              </span>
            </p>
            {entry.outcome === "denied" && entry.message && <p className="mt-1 text-xs text-danger">{entry.message}</p>}
          </div>
          <span className="sm:text-right">
            <OutcomeMark entry={entry} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What an agent's run did, oldest first: every call it made and every git
 * request, allowed or refused. `entries` come from the run's audit log.
 */
export function WhatItDid({ entries, compact = false }: { entries: AuditEntry[]; compact?: boolean }) {
  if (entries.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted">
        Nothing recorded yet. Every call this run makes with its credentials, and every clone and push, is listed here.
      </p>
    );
  }
  const who = entries.find((entry) => entry.onBehalfOf);
  const denied = entries.filter((entry) => entry.outcome === "denied").length;
  const shown = compact ? entries.slice(-8) : entries;
  return (
    <div className="mt-3">
      <p className="text-xs text-muted">
        {who ? actorLabel(who) : entries[0].actor} · {entries.length} {entries.length === 1 ? "action" : "actions"}
        {denied > 0 && <span className="text-danger"> · {denied} refused</span>}
        {compact && entries.length > shown.length && ` · the latest ${shown.length}`}
      </p>
      <ol className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
        {shown.map((entry) => (
          <li key={entry.id} className="flex items-start gap-3 px-4 py-2 text-sm">
            <time dateTime={entry.time} className="shrink-0 font-mono text-xs leading-5 text-faint" suppressHydrationWarning>
              {clock(entry.time)}
            </time>
            <div className="min-w-0 grow">
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs leading-5">
                <span className="text-fg/85">{actionLabel(entry.action)}</span>
                <span className="truncate text-muted">{targetLabel(entry)}</span>
              </p>
              {entry.outcome === "denied" && (
                <p className="text-xs text-danger">
                  {entry.message ?? "Refused."} <span className="text-faint">({ruleLabel(entry.rule)})</span>
                </p>
              )}
            </div>
            <OutcomeMark entry={entry} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the runs on a pull request did, fetched from the project's
 * `audit.json`, for the Agent panel. Shown to members only.
 */
export function RunAudit({ owner, repo, runIds, live }: { owner: string; repo: string; runIds: string[]; live: boolean }) {
  const fetcher = useFetcher<{ entries: AuditEntry[] }>();
  const search = new URLSearchParams(runIds.map((id) => ["run", id])).toString();
  const url = `/${owner}/${repo}/audit.json?${search}`;
  const { load } = fetcher;
  useEffect(() => {
    if (runIds.length > 0) load(url);
  }, [load, url, runIds.length]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(url);
    }, 8000);
    return () => clearInterval(timer);
  }, [live, load, url]);
  const entries = fetcher.data?.entries;
  if (!entries || entries.length === 0) return null;
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">What it did</summary>
      <WhatItDid entries={entries} compact />
      <Link to={`/${owner}/-/audit?project=${encodeURIComponent(repo)}&kind=agent`} className="mt-2 inline-block text-xs text-muted hover:text-fg">
        Open the audit log
      </Link>
    </details>
  );
}
