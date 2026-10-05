/**
 * Security, as a project's page shows it: findings by severity, the
 * secrets found in pushes and history with what was decided about each,
 * and vulnerable dependencies with the upgrade fixing each. The page
 * posts the intents in `routes/repo/security.tsx`'s action.
 */
import { Bot, CircleCheck, CircleDot, ExternalLink, GitPullRequest, KeyRound, Package, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { SEVERITIES, type SecretFinding, type SecretStatus, type Severity, type SeverityCounts, type Vulnerability } from "@g1t/contracts";

import { TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

type Done = { ok: boolean; error?: string } | undefined;

const SEVERITY: Record<Severity, { label: string; tone: BadgeTone }> = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "warn" },
  medium: { label: "Medium", tone: "merged" },
  low: { label: "Low", tone: "info" },
  unknown: { label: "Unrated", tone: "neutral" },
};

const STATUS: Record<SecretStatus, { label: string; tone: BadgeTone; about: string }> = {
  open: { label: "Open", tone: "danger", about: "In the repository's history. Rotate it, then mark it resolved." },
  blocked: { label: "Push blocked", tone: "warn", about: "A push carrying it was refused, so it never landed." },
  allowed: { label: "Allowed", tone: "neutral", about: "Not a real secret, so pushes carrying it go through." },
  resolved: { label: "Resolved", tone: "accent", about: "Rotated or removed." },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY[severity].tone}>{SEVERITY[severity].label}</Badge>;
}

/** Open findings by severity, one tile each. */
export function SeverityCountsGrid({ counts }: { counts: SeverityCounts }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {SEVERITIES.map((severity) => (
        <div key={severity} className="rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-xs text-muted">{SEVERITY[severity].label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${counts[severity] > 0 && severity === "critical" ? "text-danger" : ""}`}>
            {counts[severity]}
          </p>
        </div>
      ))}
    </div>
  );
}

/** A compact row of severity counts, for a list of projects. */
export function SeverityCountsInline({ counts }: { counts: SeverityCounts }) {
  const shown = SEVERITIES.filter((severity) => counts[severity] > 0);
  if (shown.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-accent">
        <ShieldCheck size={13} />
        Nothing open
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {shown.map((severity) => (
        <Badge key={severity} tone={SEVERITY[severity].tone}>
          {counts[severity]} {SEVERITY[severity].label.toLowerCase()}
        </Badge>
      ))}
    </span>
  );
}

const TEXTAREA =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

/** Allow or resolve a secret, with the reason the record keeps. */
function Decide({ finding, decision, action }: { finding: SecretFinding; decision: "allow" | "resolve"; action: string }) {
  const fetcher = useFetcher<Done>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  const allow = decision === "allow";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          allow ? "border-line text-muted hover:border-line-strong hover:text-fg" : "border-accent/40 text-accent hover:bg-accent/10"
        }`}
      >
        {allow ? "Allow" : "Resolve"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{allow ? `Allow ${finding.label}?` : `Mark ${finding.label} resolved?`}</DialogTitle>
          <DialogDescription>
            {allow
              ? finding.status === "blocked"
                ? "Say why it is not a real secret. The push it stopped can then be pushed again as it is, and the record keeps your name and reason."
                : "Say why it is not a real secret. The record keeps your name and reason."
              : "Rotate it with whoever issued it first: removing it from the code leaves it in history. The record keeps your name and reason."}
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="space-y-3">
          <input type="hidden" name="intent" value="decide" />
          <input type="hidden" name="id" value={finding.id} />
          <input type="hidden" name="decision" value={decision} />
          <p className="font-mono text-xs text-muted">
            {finding.path}:{finding.line} · {finding.preview}
          </p>
          <textarea
            name="reason"
            required
            rows={3}
            maxLength={500}
            placeholder={allow ? "A fake key in a test fixture." : "Rotated in the AWS console; the old key is disabled."}
            className={TEXTAREA}
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
            >
              {allow ? "Allow" : "Mark resolved"}
            </button>
          </div>
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function SecretItem({ finding, base, action, focused }: { finding: SecretFinding; base: string; action: string; focused: boolean }) {
  const reopen = useFetcher<Done>();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const status = STATUS[finding.status];
  const landed = finding.source === "history" || finding.status === "open";
  return (
    <li ref={ref} className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start ${focused ? "bg-accent/5 ring-1 ring-accent/40 ring-inset" : ""}`}>
      <KeyRound size={15} className="mt-0.5 hidden shrink-0 text-muted sm:block" />
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium first-letter:uppercase">{finding.label}</span>
          <Badge tone={status.tone} title={status.about}>
            {status.label}
          </Badge>
        </div>
        <p className="mt-1 truncate font-mono text-xs">
          {landed ? (
            <Link to={`${base}/blob/${finding.commit}/${finding.path}#L${finding.line}`} className="text-fg-soft hover:text-fg hover:underline">
              {finding.path}:{finding.line}
            </Link>
          ) : (
            <span className="text-fg-soft">
              {finding.path}:{finding.line}
            </span>
          )}
          <span className="text-faint"> · {finding.preview}</span>
        </p>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
          <span>
            {finding.source === "push" ? "in a push" : "in history"}
            {finding.foundBy && <> by {finding.foundBy}</>}, commit{" "}
            {landed ? (
              <Link to={`${base}/commit/${finding.commit}`} className="font-mono hover:text-fg">
                {finding.commit.slice(0, 7)}
              </Link>
            ) : (
              <span className="font-mono">{finding.commit.slice(0, 7)}</span>
            )}
          </span>
          <span>
            found <TimeAgo at={finding.foundAt} />
          </span>
          {finding.decidedBy && finding.decidedAt && (
            <span>
              {finding.status === "allowed" ? "allowed" : "resolved"} by {finding.decidedBy} <TimeAgo at={finding.decidedAt} />
              {finding.reason && <>: “{finding.reason}”</>}
            </span>
          )}
        </p>
        {reopen.data?.error && <p className="mt-1.5 text-xs text-danger">{reopen.data.error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {finding.status === "open" || finding.status === "blocked" ? (
          <>
            <Decide finding={finding} decision="allow" action={action} />
            {finding.status === "open" && <Decide finding={finding} decision="resolve" action={action} />}
          </>
        ) : (
          <button
            type="button"
            disabled={reopen.state !== "idle"}
            onClick={() => reopen.submit({ intent: "decide", id: finding.id, decision: "reopen" }, { method: "post", action })}
            className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50"
          >
            Reopen
          </button>
        )}
      </div>
    </li>
  );
}

export function SecretsList({
  secrets,
  base,
  action,
  focus,
}: {
  secrets: SecretFinding[];
  base: string;
  action: string;
  focus: string | null;
}) {
  if (secrets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
        <ShieldCheck size={22} className="mx-auto text-accent" />
        <p className="mt-2 font-medium">No secrets found</p>
        <p className="mt-1 text-sm text-muted">
          Pushes that add a key or a token are refused before they land, and the history is scanned once in the background.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {secrets.map((finding) => (
        <SecretItem key={finding.id} finding={finding} base={base} action={action} focused={finding.id === focus} />
      ))}
    </ul>
  );
}

/** Where the upgrade issue for a package stands, as the page loads it. */
export type UpgradeFix = {
  number: number;
  state: "open" | "closed";
  /** The newest pull request for the issue, if any. */
  pull: { number: number; status: "draft" | "open" | "merged" | "closed"; agent: string | null } | null;
  resolvedBy: number | null;
};

function FixLink({ issue, fix, base }: { issue: number | null; fix: UpgradeFix | undefined; base: string }) {
  if (issue == null) return <span className="text-xs text-faint">No upgrade issue</span>;
  const pull = fix?.pull;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Link to={`${base}/issues/${issue}`} className="inline-flex items-center gap-1 text-fg-soft hover:text-fg">
        {fix?.state === "closed" ? <CircleCheck size={12} className="text-merged" /> : <CircleDot size={12} className="text-accent" />}#{issue}
      </Link>
      {pull && (
        <Link to={`${base}/pull/${pull.number}`} className="inline-flex items-center gap-1 text-muted hover:text-fg">
          {pull.agent ? <Bot size={12} /> : <GitPullRequest size={12} />}
          #{pull.number} {pull.status === "draft" ? "in progress" : pull.status}
        </Link>
      )}
    </span>
  );
}

type PackageGroup = { key: string; ecosystem: string; name: string; vulns: Vulnerability[] };

function groups(vulnerabilities: Vulnerability[]): PackageGroup[] {
  const map = new Map<string, PackageGroup>();
  for (const vuln of vulnerabilities) {
    const key = `${vuln.ecosystem}:${vuln.package}`;
    const group = map.get(key) ?? { key, ecosystem: vuln.ecosystem, name: vuln.package, vulns: [] };
    group.vulns.push(vuln);
    map.set(key, group);
  }
  return [...map.values()];
}

function worst(vulns: Vulnerability[]): Severity {
  return SEVERITIES.find((severity) => vulns.some((vuln) => vuln.severity === severity)) ?? "unknown";
}

export function VulnerabilityList({
  vulnerabilities,
  fixes,
  base,
}: {
  vulnerabilities: Vulnerability[];
  fixes: Record<number, UpgradeFix>;
  base: string;
}) {
  const open = groups(vulnerabilities.filter((vuln) => vuln.status === "open"));
  const fixed = groups(vulnerabilities.filter((vuln) => vuln.status === "fixed"));
  return (
    <div className="space-y-6">
      {open.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <ShieldCheck size={22} className="mx-auto text-accent" />
          <p className="mt-2 font-medium">No known vulnerabilities</p>
          <p className="mt-1 text-sm text-muted">
            Every package the lockfiles resolve is checked against the OSV database on each push to the default branch, and daily.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {open.map((group) => (
            <PackageItem key={group.key} group={group} fixes={fixes} base={base} />
          ))}
        </ul>
      )}
      {fixed.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted hover:text-fg">
            Fixed ({fixed.reduce((sum, group) => sum + group.vulns.length, 0)})
          </summary>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface opacity-80">
            {fixed.map((group) => (
              <PackageItem key={group.key} group={group} fixes={fixes} base={base} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PackageItem({ group, fixes, base }: { group: PackageGroup; fixes: Record<number, UpgradeFix>; base: string }) {
  const first = group.vulns[0];
  const versions = [...new Set(group.vulns.map((vuln) => vuln.version))];
  const targets = group.vulns.map((vuln) => vuln.fixedVersion).filter((version): version is string => !!version);
  const manifests = [...new Set(group.vulns.map((vuln) => vuln.manifest))];
  const issue = group.vulns.find((vuln) => vuln.issue != null)?.issue ?? null;
  const advisories = [...new Map(group.vulns.map((vuln) => [vuln.advisory, vuln])).values()];
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Package size={15} className="mt-0.5 hidden shrink-0 text-muted sm:block" />
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">{group.name}</span>
            <span className="font-mono text-xs text-muted">{versions.join(", ")}</span>
            <Badge>{first.ecosystem}</Badge>
            <SeverityBadge severity={worst(group.vulns)} />
          </div>
          <p className="mt-1 text-xs text-faint">
            {targets.length > 0 ? <>Fixed in {targets.sort().at(-1)}</> : "No fixed version yet"} · locked in{" "}
            <span className="font-mono">{manifests.join(", ")}</span>
          </p>
        </div>
        <FixLink issue={issue} fix={issue != null ? fixes[issue] : undefined} base={base} />
      </div>
      <ul className="mt-2 space-y-1 sm:pl-7">
        {advisories.map((vuln) => (
          <li key={vuln.advisory} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <a
              href={`https://osv.dev/vulnerability/${vuln.osvId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-fg-soft hover:text-fg"
            >
              {vuln.advisory}
              <ExternalLink size={10} />
            </a>
            <span className="text-muted">{SEVERITY[vuln.severity].label.toLowerCase()}</span>
            <span className="min-w-0 truncate text-muted">{vuln.summary}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function ScanSummary({
  scan,
}: {
  scan: { history: string; commitsScanned: number; historyFinishedAt: string | null; dependenciesScannedAt: string | null; dependenciesError: string | null; lockfiles: string[] };
}) {
  const history =
    scan.history === "done" ? (
      <>
        History scanned: {scan.commitsScanned.toLocaleString()} commits
        {scan.historyFinishedAt && (
          <>
            , <TimeAgo at={scan.historyFinishedAt} />
          </>
        )}
      </>
    ) : scan.history === "stopped" ? (
      "History scan paused: the workspace reached its spending limit"
    ) : scan.history === "running" ? (
      `Scanning history: ${scan.commitsScanned.toLocaleString()} commits so far`
    ) : (
      "History scan queued"
    );
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <KeyRound size={12} />
        {history}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Package size={12} />
        {scan.dependenciesScannedAt ? (
          <>
            Dependencies read <TimeAgo at={scan.dependenciesScannedAt} />
            {scan.lockfiles.length > 0 ? <> from {scan.lockfiles.join(", ")}</> : " (no lockfiles found)"}
          </>
        ) : (
          "Dependencies not read yet"
        )}
      </span>
      {scan.dependenciesError && (
        <span className="inline-flex items-center gap-1.5 text-warn">
          <ShieldAlert size={12} />
          {scan.dependenciesError}
        </span>
      )}
    </div>
  );
}
