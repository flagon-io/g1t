/**
 * Security, as a project's page shows it: open alerts by severity, the
 * secrets found in pushes and history, vulnerable dependencies with the
 * security update g1t opened for each, and what happened to every alert.
 * The page posts the intents in `routes/repo/security.tsx`'s action.
 */
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  History,
  KeyRound,
  Loader,
  Package,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import {
  type AlertActivity,
  type AlertState,
  DEPENDENCY_DISMISS_REASONS,
  type DismissReason,
  SECRET_DISMISS_REASONS,
  SEVERITIES,
  type PullStatus,
  type SecretFinding,
  type SecurityUpdate,
  type Severity,
  type SeverityCounts,
  type Vulnerability,
  dismissLabel,
} from "@g1t/contracts";

import {
  type ActivityEntry,
  type PackageGroup,
  UPDATE_STATES,
  alertActivity,
  groupByPackage,
  highestFix,
  latestUpdate,
  splitSecrets,
  worstSeverity,
} from "../lib/security-alerts";
import { Avatar, TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { RadioGroup, RadioOption } from "./ui/radio-group";

type Done = { ok: boolean; error?: string } | undefined;

const SEVERITY: Record<Severity, { label: string; tone: BadgeTone }> = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "warn" },
  medium: { label: "Medium", tone: "merged" },
  low: { label: "Low", tone: "info" },
  unknown: { label: "Unrated", tone: "neutral" },
};


export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY[severity].tone}>{SEVERITY[severity].label}</Badge>;
}

/** Open alerts by severity, one tile each. */
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

const STATE_FILTERS: { state: AlertState; label: string; icon: ReactNode }[] = [
  { state: "open", label: "Open", icon: <CircleDot size={14} /> },
  { state: "dismissed", label: "Dismissed", icon: <CircleSlash size={14} /> },
  { state: "fixed", label: "Fixed", icon: <CircleCheck size={14} /> },
];

/** Open, Dismissed and Fixed, with how many alerts each holds. */
export function StateFilter({
  counts,
  value,
  onChange,
}: {
  counts: Record<AlertState, number>;
  value: AlertState;
  onChange: (state: AlertState) => void;
}) {
  return (
    <div role="group" aria-label="Filter alerts" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {STATE_FILTERS.map(({ state, label, icon }) => (
        <button
          key={state}
          type="button"
          aria-pressed={value === state}
          onClick={() => onChange(state)}
          className={`inline-flex items-center gap-1.5 transition-colors ${
            value === state ? "font-medium text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {icon}
          {counts[state]} {label}
        </button>
      ))}
    </div>
  );
}

const TEXTAREA =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

const SMALL_BUTTON =
  "rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50";

/** Dismiss an alert with one of `reasons` and an optional comment. */
export function DismissDialog({
  id,
  title,
  detail,
  reasons,
  note,
  action,
  defaultReason,
  trigger = "Dismiss",
}: {
  id: string;
  title: string;
  /** What the alert is, in a line of code type. */
  detail: string;
  reasons: { reason: DismissReason; label: string; about: string }[];
  note?: string;
  action: string;
  defaultReason?: DismissReason;
  trigger?: string;
}) {
  const fetcher = useFetcher<Done>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(defaultReason ?? "");
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setReason(defaultReason ?? "");
      }}
    >
      <DialogTrigger className={SMALL_BUTTON}>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Say why it can stay. The alert keeps your name, the reason and your comment, and anyone with access can reopen it.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="space-y-4">
          <input type="hidden" name="intent" value="dismiss" />
          <input type="hidden" name="id" value={id} />
          <p className="font-mono text-xs break-all text-muted">{detail}</p>
          <fieldset>
            <legend className="text-xs font-medium text-muted">Reason</legend>
            <RadioGroup name="reason" value={reason} onValueChange={setReason} required className="mt-2 gap-3">
              {reasons.map((option) => (
                <RadioOption key={option.reason} value={option.reason} label={option.label} description={option.about} />
              ))}
            </RadioGroup>
          </fieldset>
          {note && <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{note}</p>}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Comment (optional)</span>
            <textarea name="comment" rows={3} maxLength={500} placeholder="What someone reading this later should know." className={TEXTAREA} />
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={fetcher.state !== "idle" || !reason}
              className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
            >
              {fetcher.state !== "idle" ? "Dismissing…" : "Dismiss alert"}
            </button>
          </div>
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

export function ReopenButton({ id, action }: { id: string; action: string }) {
  const fetcher = useFetcher<Done>();
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={fetcher.state !== "idle"}
        onClick={() => fetcher.submit({ intent: "reopen", id }, { method: "post", action })}
        className={SMALL_BUTTON}
      >
        {fetcher.state !== "idle" ? "Reopening…" : "Reopen"}
      </button>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </span>
  );
}

/** What happened to an alert, oldest first, folded away until asked for. */
function ActivityLog({ entries, base, open }: { entries: ActivityEntry[]; base: string; open?: boolean }) {
  if (entries.length === 0) return null;
  return (
    <details className="group mt-2" open={open}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <History size={12} />
        <span className="group-open:hidden">Show activity ({entries.length})</span>
        <span className="hidden group-open:inline">Hide activity</span>
      </summary>
      <ol className="mt-2 space-y-2 border-l border-line pl-3">
        {entries.map((entry) => (
          <li key={entry.key} className="text-xs">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted">
              {entry.actor ? (
                <>
                  <Avatar name={entry.actor} size={16} />
                  <span className="font-medium text-fg">{entry.actor}</span>
                </>
              ) : (
                <CircleDot size={12} className="text-faint" />
              )}
              <span>{entry.text}</span>
              {entry.ref && (
                <Link
                  to={`${base}/${entry.ref.kind === "pull" ? "pull" : "issues"}/${entry.ref.number}`}
                  className="font-medium text-fg-soft hover:text-fg hover:underline"
                >
                  #{entry.ref.number}
                </Link>
              )}
              {entry.reason && <Badge>{dismissLabel(entry.reason)}</Badge>}
              <span className="text-faint">
                <TimeAgo at={entry.at} />
              </span>
            </p>
            {entry.comment && <p className="mt-1 text-fg-soft wrap-anywhere">“{entry.comment}”</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}

function useFocus<T extends HTMLElement>(focused: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return ref;
}

const FOCUSED = "bg-accent/5 ring-1 ring-accent/40 ring-inset";

function secretBadge(finding: SecretFinding): { label: string; tone: BadgeTone; about: string } {
  if (finding.state === "dismissed") {
    return {
      label: "Dismissed",
      tone: "neutral",
      about: finding.status === "allowed" ? "Pushes carrying it go through." : "Dismissed.",
    };
  }
  if (finding.state === "fixed") return { label: "Revoked", tone: "accent", about: "Revoked or rotated." };
  if (finding.status === "blocked") {
    return { label: "Push blocked", tone: finding.testValue ? "neutral" : "warn", about: "A push carrying it was refused, so it never landed." };
  }
  return {
    label: "In history",
    tone: finding.testValue ? "neutral" : "danger",
    about: "In the repository's history. Rotate it with whoever issued it, then dismiss it as revoked.",
  };
}

function SecretItem({
  finding,
  activity,
  base,
  action,
  focused,
  canDismiss,
}: {
  finding: SecretFinding;
  activity: AlertActivity[];
  base: string;
  action: string;
  focused: boolean;
  canDismiss: boolean;
}) {
  const ref = useFocus<HTMLLIElement>(focused);
  const badge = secretBadge(finding);
  const landed = finding.source === "history" || finding.status === "open";
  const where = `${finding.path}:${finding.line}`;
  return (
    <li ref={ref} id={finding.id} className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start ${focused ? FOCUSED : ""}`}>
      <KeyRound size={15} className="mt-0.5 hidden shrink-0 text-muted sm:block" />
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`${base}/security/secret-scanning/${finding.id}`} className="text-sm font-medium first-letter:uppercase hover:underline">
            {finding.label}
          </Link>
          <Badge tone={badge.tone} title={badge.about}>
            {badge.label}
          </Badge>
          {finding.testValue && <Badge title={finding.testValue}>Likely test value</Badge>}
          {finding.validity === "active" && (
            <Badge tone="danger" title="Its issuer says it still works">
              Active
            </Badge>
          )}
          {finding.validity === "inactive" && <Badge title="Its issuer refused it: revoked or expired">Inactive</Badge>}
          {finding.bypass && <Badge tone="warn" title={`Bypassed by ${finding.bypass.by}`}>Bypassed</Badge>}
          {finding.state === "dismissed" && finding.dismissedReason && <Badge>{dismissLabel(finding.dismissedReason)}</Badge>}
        </div>
        <p className="mt-1 truncate font-mono text-xs">
          {landed ? (
            <Link to={`${base}/blob/${finding.commit}/${finding.path}#L${finding.line}`} className="text-fg-soft hover:text-fg hover:underline">
              {where}
            </Link>
          ) : (
            <span className="text-fg-soft">{where}</span>
          )}
          <span className="text-faint"> · {finding.preview}</span>
        </p>
        {finding.testValue && <p className="mt-1 text-xs text-muted">{finding.testValue}</p>}
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
        </p>
        <ActivityLog entries={alertActivity(finding, activity)} base={base} open={focused && finding.state !== "open"} />
      </div>
      {canDismiss && (
        <div className="flex shrink-0 items-center gap-1.5">
          {finding.state === "open" ? (
            <DismissDialog
              id={finding.id}
              title={`Dismiss ${finding.label}`}
              detail={`${where} · ${finding.preview}`}
              reasons={SECRET_DISMISS_REASONS}
              note={
                finding.status === "blocked" && !finding.testValue
                  ? "Dismissing it lets the same push through, unless you dismiss it as revoked."
                  : undefined
              }
              action={action}
            />
          ) : (
            <ReopenButton id={finding.id} action={action} />
          )}
        </div>
      )}
    </li>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <ShieldCheck size={22} className="mx-auto text-accent" />
      <p className="mt-2 font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  );
}

const LIST = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";

/** The secret alerts in one state: on Open, real ones first, then likely test values. */
export function SecretsList({
  secrets,
  state,
  activity,
  base,
  action,
  focus,
  canDismiss,
}: {
  /** Already filtered to `state`. */
  secrets: SecretFinding[];
  state: AlertState;
  activity: AlertActivity[];
  base: string;
  action: string;
  focus: string | null;
  /** Whether the viewer may dismiss and reopen secret alerts (Admin). */
  canDismiss: boolean;
}) {
  const item = (finding: SecretFinding) => (
    <SecretItem
      key={finding.id}
      finding={finding}
      activity={activity}
      base={base}
      action={action}
      focused={finding.id === focus}
      canDismiss={canDismiss}
    />
  );
  if (secrets.length === 0) {
    return state === "open" ? (
      <Empty title="No open secret alerts">
        Pushes that add a key or a token are refused before they land, and the history is scanned once in the background.
      </Empty>
    ) : (
      <Empty title={state === "dismissed" ? "No dismissed secret alerts" : "No revoked secrets"}>
        {state === "dismissed"
          ? "Alerts someone dismissed as a false positive, a test value or accepted are listed here."
          : "Secrets dismissed as revoked are listed here."}
      </Empty>
    );
  }
  if (state !== "open") return <ul className={LIST}>{secrets.map(item)}</ul>;
  const { real, tests } = splitSecrets(secrets);
  return (
    <div className="space-y-5">
      {real.length > 0 ? (
        <ul className={LIST}>{real.map(item)}</ul>
      ) : (
        <Empty title="No secrets that look real">Only likely test values are open, and they never block a push.</Empty>
      )}
      {tests.length > 0 && (
        <section>
          <h4 className="text-sm font-medium">Likely test values</h4>
          <p className="mt-0.5 mb-2 text-xs text-muted">
            These look made for tests or documentation. They never block a push and are not counted as critical; dismiss them
            to clear the list.
          </p>
          <ul className={LIST}>{tests.map(item)}</ul>
        </section>
      )}
    </div>
  );
}

/** Where the legacy upgrade issue for a package stands, as the page loads it. */
export type UpgradeFix = {
  number: number;
  state: "open" | "closed";
  /** The newest pull request for the issue, if any. */
  pull: { number: number; status: PullStatus; agent: string | null } | null;
  resolvedBy: number | null;
};

/** A security update's pull request as the page loads it. */
export type PullInfo = { number: number; status: PullStatus; title: string };

function FixLink({ issue, fix, base }: { issue: number; fix: UpgradeFix | undefined; base: string }) {
  const pull = fix?.pull;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted">Upgrade issue</span>
      <Link to={`${base}/issues/${issue}`} className="inline-flex items-center gap-1 text-fg-soft hover:text-fg">
        {fix?.state === "closed" ? <CircleCheck size={12} className="text-merged" /> : <CircleDot size={12} className="text-accent" />}#{issue}
      </Link>
      {pull && (
        <Link to={`${base}/pull/${pull.number}`} className="inline-flex items-center gap-1 text-muted hover:text-fg">
          {pull.agent ? <Bot size={12} /> : <GitPullRequest size={12} />}#{pull.number} {pull.status === "draft" ? "in progress" : pull.status}
        </Link>
      )}
    </span>
  );
}

const PULL_ICON: Record<PullStatus, ReactNode> = {
  draft: <GitPullRequest size={13} className="text-muted" />,
  open: <GitPullRequest size={13} className="text-accent" />,
  merged: <GitMerge size={13} className="text-merged" />,
  closed: <GitPullRequestClosed size={13} className="text-danger" />,
};

/** Where g1t's security update for a package stands. */
function UpdateStatus({ update, name, pulls, base }: { update: SecurityUpdate; name: string; pulls: Record<number, PullInfo>; base: string }) {
  const meta = UPDATE_STATES[update.state];
  const pull = update.pull != null ? pulls[update.pull] : undefined;
  const about: Record<SecurityUpdate["state"], ReactNode> = {
    requested: <>A sandbox is raising {name} to {update.target}.</>,
    open: <>It raises {name} to {update.target} and lands through your branch's required checks.</>,
    merged: <>{name} was raised to {update.target}.</>,
    closed: <>The pull request was closed without merging.</>,
    superseded: <>A newer update replaced it, or the package is no longer vulnerable, so g1t closed it.</>,
    needs_code: (
      <>
        Raising {name} to {update.target} needs code changes, so g1t opened an issue to make them
        {update.issue != null && (
          <>
            :{" "}
            <Link to={`${base}/issues/${update.issue}`} className="font-medium text-fg-soft hover:text-fg hover:underline">
              #{update.issue}
            </Link>
          </>
        )}
        .
      </>
    ),
    failed: <>{update.error ?? "g1t could not make the change."}</>,
  };
  return (
    <div className="mt-2.5 rounded-lg border border-line bg-bg/40 px-3 py-2 text-xs sm:ml-7">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {update.state === "requested" ? (
          <Loader size={13} className="animate-spin text-info motion-reduce:animate-none" />
        ) : update.state === "failed" || update.state === "needs_code" ? (
          <CircleAlert size={13} className={update.state === "failed" ? "text-danger" : "text-warn"} />
        ) : (
          PULL_ICON[pull?.status ?? (update.state === "merged" ? "merged" : update.state === "open" ? "open" : "closed")]
        )}
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {update.pull != null && (
          <Link to={`${base}/pull/${update.pull}`} className="font-medium text-fg-soft hover:text-fg hover:underline">
            #{update.pull}
            {pull && <span className="font-normal text-muted"> {pull.status === "draft" ? "draft" : pull.status}</span>}
          </Link>
        )}
        {update.branch && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-muted">
            <GitBranch size={12} className="shrink-0" />
            <span className="truncate">{update.branch}</span>
          </span>
        )}
        <span className="text-faint">
          <TimeAgo at={update.updatedAt} />
        </span>
      </div>
      <p className={`mt-1 ${update.state === "failed" ? "text-danger" : "text-muted"} wrap-anywhere`}>{about[update.state]}</p>
    </div>
  );
}

export function VulnerabilityList({
  vulnerabilities,
  state,
  activity,
  fixes,
  pulls,
  upkeep,
  base,
  action,
  focus,
  canDismiss,
}: {
  /** Already filtered to `state`. */
  vulnerabilities: Vulnerability[];
  state: AlertState;
  activity: AlertActivity[];
  fixes: Record<number, UpgradeFix>;
  pulls: Record<number, PullInfo>;
  /** Whether security updates are on. */
  upkeep: boolean;
  base: string;
  action: string;
  focus: string | null;
  /** Whether the viewer may dismiss and reopen dependency alerts (Write). */
  canDismiss: boolean;
}) {
  const packages = groupByPackage(vulnerabilities);
  if (packages.length === 0) {
    return state === "open" ? (
      <Empty title="No known vulnerabilities">
        Every package the lockfiles resolve is checked against the OSV database on each push to the default branch, and daily.
      </Empty>
    ) : (
      <Empty title={state === "dismissed" ? "No dismissed dependency alerts" : "Nothing fixed yet"}>
        {state === "dismissed"
          ? "Alerts someone dismissed, with their reason, are listed here."
          : "Alerts whose package was upgraded, or is no longer vulnerable, are listed here."}
      </Empty>
    );
  }
  return (
    <ul className={LIST}>
      {packages.map((group) => (
        <PackageItem
          key={group.key}
          group={group}
          activity={activity}
          fixes={fixes}
          pulls={pulls}
          upkeep={upkeep}
          base={base}
          action={action}
          focus={focus}
          canDismiss={canDismiss}
        />
      ))}
    </ul>
  );
}

function PackageItem({
  group,
  activity,
  fixes,
  pulls,
  upkeep,
  base,
  action,
  focus,
  canDismiss,
}: {
  group: PackageGroup;
  activity: AlertActivity[];
  fixes: Record<number, UpgradeFix>;
  pulls: Record<number, PullInfo>;
  upkeep: boolean;
  base: string;
  action: string;
  focus: string | null;
  canDismiss: boolean;
}) {
  const versions = [...new Set(group.vulns.map((vuln) => vuln.version))];
  const manifests = [...new Set(group.vulns.map((vuln) => vuln.manifest))];
  const target = highestFix(group.vulns);
  const update = latestUpdate(group.vulns);
  const issue = update ? null : (group.vulns.find((vuln) => vuln.issue != null)?.issue ?? null);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Package size={15} className="mt-0.5 hidden shrink-0 text-muted sm:block" />
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium break-all">{group.name}</span>
            <span className="font-mono text-xs text-muted">{versions.join(", ")}</span>
            <Badge>{group.ecosystem}</Badge>
            <SeverityBadge severity={worstSeverity(group.vulns)} />
          </div>
          <p className="mt-1 text-xs text-faint wrap-anywhere">
            {target ? <>Fixed in {target}</> : "No patched version"} · locked in{" "}
            <span className="font-mono">{manifests.join(", ")}</span>
          </p>
        </div>
      </div>
      {update && <UpdateStatus update={update} name={group.name} pulls={pulls} base={base} />}
      {issue != null && (
        <div className="mt-2 sm:ml-7">
          <FixLink issue={issue} fix={fixes[issue]} base={base} />
        </div>
      )}
      <ul className="mt-2.5 space-y-px overflow-hidden rounded-lg border border-line sm:ml-7">
        {group.vulns.map((vuln) => (
          <AdvisoryItem
            key={vuln.id}
            vuln={vuln}
            showManifest={manifests.length > 1}
            activity={activity}
            upkeep={upkeep}
            base={base}
            action={action}
            focused={vuln.id === focus}
            canDismiss={canDismiss}
          />
        ))}
      </ul>
    </li>
  );
}

function AdvisoryItem({
  vuln,
  showManifest,
  activity,
  upkeep,
  base,
  action,
  focused,
  canDismiss,
}: {
  vuln: Vulnerability;
  showManifest: boolean;
  activity: AlertActivity[];
  upkeep: boolean;
  base: string;
  action: string;
  focused: boolean;
  canDismiss: boolean;
}) {
  const ref = useFocus<HTMLLIElement>(focused);
  const osv = `https://osv.dev/vulnerability/${vuln.osvId}`;
  const dismiss = (reason?: DismissReason, trigger?: string) => (
    <DismissDialog
      id={vuln.id}
      title={`Dismiss ${vuln.advisory}`}
      detail={`${vuln.package} ${vuln.version} · ${vuln.manifest}`}
      reasons={DEPENDENCY_DISMISS_REASONS}
      action={action}
      defaultReason={reason}
      trigger={trigger}
    />
  );
  return (
    <li ref={ref} id={vuln.id} className={`bg-bg/30 px-3 py-2.5 not-first:border-t not-first:border-line ${focused ? FOCUSED : ""}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 grow text-xs">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a href={osv} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-fg-soft hover:text-fg">
              {vuln.advisory}
              <ExternalLink size={10} />
            </a>
            <SeverityBadge severity={vuln.severity} />
            {vuln.fixedVersion && <span className="text-faint">fixed in {vuln.fixedVersion}</span>}
            {showManifest && <span className="font-mono text-faint">{vuln.manifest}</span>}
            {vuln.state === "dismissed" && vuln.dismissedReason && <Badge>{dismissLabel(vuln.dismissedReason)}</Badge>}
          </p>
          <p className="mt-1 text-muted wrap-anywhere">{vuln.summary}</p>
        </div>
        {canDismiss && vuln.state !== "fixed" && (
          <div className="flex shrink-0 items-center gap-1.5">
            {vuln.state === "open" ? dismiss() : <ReopenButton id={vuln.id} action={action} />}
          </div>
        )}
      </div>
      {vuln.state === "open" && !vuln.fixedVersion && (
        <div className="mt-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-warn">
            <ShieldAlert size={13} />
            No patched version available
          </p>
          <p className="mt-1 text-muted">
            No release fixes this yet. Dependencies are checked again daily
            {upkeep
              ? ", and g1t opens a pull request when a fix is published."
              : "; turn on security updates and g1t opens a pull request when a fix is published."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a href={osv} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-soft hover:text-fg hover:underline">
              Read the advisory
              <ExternalLink size={10} />
            </a>
            {canDismiss && dismiss("tolerable_risk", "Dismiss as tolerable risk")}
          </div>
        </div>
      )}
      <ActivityLog entries={alertActivity(vuln, activity)} base={base} open={focused && vuln.state !== "open"} />
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
