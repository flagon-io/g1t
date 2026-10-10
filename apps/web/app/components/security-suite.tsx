/**
 * The security suite's pieces, shared by a project's Security sections and
 * the workspace's: the activation prompt, filters, code scanning alerts,
 * the trend chart and coverage table, the custom pattern editor, and the
 * bypass and "Fix with g1t" forms. Each form posts an `intent` to the page
 * it is on.
 */
import { Bot, CircleCheck, CircleDot, CircleSlash, FileCode2, Lock, ShieldCheck, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import {
  type AlertState,
  BYPASS_REASONS,
  type CodeAlert,
  type DryRun,
  type RepoCoverage,
  type SavedPattern,
  type Severity,
  type SeverityCounts,
  type TrendPoint,
} from "@g1t/contracts";

import { total, trendMax } from "../lib/security-suite";
import { SeverityBadge } from "./security";
import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Done = { ok: boolean; error?: string } | undefined;

export const CARD = "rounded-xl border border-line bg-surface";
export const LIST = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";
const INPUT =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";
const SMALL_BUTTON =
  "rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50";
const PRIMARY = "rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg transition-colors hover:bg-fg-hover disabled:opacity-50";

/** A section's title, what it is for, and what can be done there. */
export function SectionHeader({ title, about, actions }: { title: string; about: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1.5 text-sm text-muted">{about}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * What a private repository's paid feature needs: the g1t plan, which
 * Security and quality comes with at no price of its own, and who can
 * start it. No pressure: what stays free is said too.
 */
export function ActivationPrompt({
  workspace,
  feature,
  monthlyCents,
  isOwner,
}: {
  workspace: string;
  feature: string;
  /** The g1t plan's monthly price, from billing; null when it could not be read. */
  monthlyCents: number | null;
  isOwner: boolean;
}) {
  const price = monthlyCents == null ? null : `$${(monthlyCents / 100).toFixed(monthlyCents % 100 ? 2 : 0)} a month`;
  return (
    <div className={`${CARD} flex flex-col gap-4 p-5 sm:flex-row sm:items-start`}>
      <Lock size={18} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 grow">
        <p className="font-medium">{feature} on private repositories comes with the g1t plan</p>
        <p className="mt-1.5 text-sm text-muted">
          Security and quality has no price of its own. With the plan{price ? ` (${price} for the workspace)` : ""}, custom patterns,
          validity checks, delegated bypass, code scanning, dependency review and the security overview are on for every private
          repository in {workspace}, and their scans are charged at cost plus 20%, like everything g1t runs. Fixes by g1t's agent
          are charged as agent usage. Public repositories have all of it free, and secret scanning, push protection, vulnerability
          alerts and security updates stay free everywhere.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {isOwner ? (
            <Link to={`/${workspace}/-/billing`} className={PRIMARY}>
              Start the plan
            </Link>
          ) : (
            <span className="text-muted">An owner of {workspace} can start the plan in Billing.</span>
          )}
          <a href="https://docs.g1t.sh/guides/security/pricing/" className="text-muted underline underline-offset-2 hover:text-fg">
            What's free and what's paid
          </a>
        </div>
      </div>
    </div>
  );
}

/** A labelled select that changes a filter in the address. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="min-w-36" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([option, text]) => (
            <SelectItem key={option} value={option}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

const STATE_ICON: Record<AlertState, ReactNode> = {
  open: <CircleDot size={14} />,
  dismissed: <CircleSlash size={14} />,
  fixed: <CircleCheck size={14} />,
};

/** A code scanning alert in a list. */
export function CodeAlertItem({ alert, base }: { alert: CodeAlert; base: string }) {
  const where = alert.path ? `${alert.path}${alert.startLine ? `:${alert.startLine}` : ""}` : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
      <span className={`mt-0.5 hidden shrink-0 sm:block ${alert.state === "open" ? "text-warn" : "text-muted"}`}>{STATE_ICON[alert.state]}</span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`${base}/security/code-scanning/${alert.number}`} className="min-w-0 text-sm font-medium break-words hover:underline">
            {alert.ruleName && alert.ruleName !== alert.ruleId ? alert.ruleName : shortRule(alert.ruleId)}
          </Link>
          <SeverityBadge severity={alert.severity} />
          {alert.issue != null && (
            <Link to={`${base}/issues/${alert.issue}`}>
              <Badge tone="accent">
                <Bot size={11} /> g1t on #{alert.issue}
              </Badge>
            </Link>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-xs text-muted">{alert.message}</p>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
          <span>#{alert.number}</span>
          <span>{alert.tool}</span>
          {where && <span className="truncate font-mono">{where}</span>}
          <span>
            {alert.state === "fixed" && alert.fixedAt ? (
              <>
                fixed <TimeAgo at={alert.fixedAt} />
              </>
            ) : (
              <>
                found <TimeAgo at={alert.createdAt} />
              </>
            )}
          </span>
        </p>
      </div>
    </li>
  );
}

/** The last part of a dotted rule id: Semgrep's are long. */
export function shortRule(ruleId: string): string {
  const parts = ruleId.split(".");
  return parts.length > 2 ? parts[parts.length - 1] : ruleId;
}

/** Open counts as compact words: "3 critical · 1 high". */
export function countsLine(counts: SeverityCounts): string {
  const parts = (["critical", "high", "medium", "low"] as Severity[]).filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length ? parts.join(" · ") : "none open";
}

// The trend's three series, each its own hue, validated for the dark
// surface (dataviz: categorical slots 1–3, dark steps).
const SERIES = [
  { key: "secretScanning", label: "Secrets", color: "#3987e5" },
  { key: "codeScanning", label: "Code scanning", color: "#d95926" },
  { key: "vulnerability", label: "Vulnerabilities", color: "#199e70" },
] as const;

/** Open alerts by type each day, as stacked bars with a legend and a table. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = trendMax(points);
  const width = 640;
  const height = 140;
  const gap = 2;
  const bar = Math.max(2, width / Math.max(points.length, 1) - gap);
  const shown = hover != null ? points[hover] : points[points.length - 1];
  return (
    <figure className={`${CARD} p-4`}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Open alerts, by day</span>
        <span className="text-xs text-muted" aria-live="polite">
          {shown
            ? `${shown.day}: ${SERIES.map((s) => `${shown[s.key]} ${s.label.toLowerCase()}`).join(", ")}`
            : "No days yet"}
        </span>
      </figcaption>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ background: series.color }} />
            {series.label}
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="mt-3 h-36 w-full"
        role="img"
        aria-label="Open alerts by type each day; the table below has the numbers"
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="currentColor" className="text-line" />
        {points.map((point, at) => {
          const x = at * (bar + gap);
          let y = height;
          return (
            <g key={point.day} onMouseEnter={() => setHover(at)}>
              {/* A hit target the full height of the day. */}
              <rect x={x} y={0} width={bar + gap} height={height} fill="transparent" />
              {SERIES.map((series) => {
                const value = point[series.key];
                if (!value) return null;
                const h = Math.max(1, (value / max) * (height - 8));
                y -= h;
                const rect = <rect key={series.key} x={x} y={y} width={bar} height={Math.max(0, h - gap)} rx={Math.min(2, bar / 2)} fill={series.color} opacity={hover == null || hover === at ? 1 : 0.55} />;
                return rect;
              })}
              <title>{`${point.day}: ${SERIES.map((s) => `${point[s.key]} ${s.label.toLowerCase()}`).join(", ")}`}</title>
            </g>
          );
        })}
      </svg>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted hover:text-fg">Show as a table</summary>
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-medium">Day</th>
                {SERIES.map((series) => (
                  <th key={series.key} className="py-1 text-right font-medium">
                    {series.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.day} className="border-t border-line">
                  <td className="py-1">{point.day}</td>
                  {SERIES.map((series) => (
                    <td key={series.key} className="py-1 text-right">
                      {point[series.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function On({ on, children }: { on: boolean; children?: ReactNode }) {
  return on ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CircleCheck size={13} aria-hidden="true" />
      {children ?? "On"}
    </span>
  ) : (
    <span className="text-faint">{children ? children : "Off"}</span>
  );
}

/** Which repository has which feature on, and what is open in each. */
export function CoverageTable({ repos, owner }: { repos: RepoCoverage[]; owner: string }) {
  if (repos.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
        No repository has been scanned yet. Each one is scanned on its next push to its default branch, or when its Security page
        is first opened.
      </p>
    );
  }
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full min-w-[46rem] text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2.5 font-medium">Repository</th>
            <th className="px-3 py-2.5 font-medium">Open</th>
            <th className="px-3 py-2.5 font-medium">Push protection</th>
            <th className="px-3 py-2.5 font-medium">Custom patterns</th>
            <th className="px-3 py-2.5 font-medium">Code scanning</th>
            <th className="px-3 py-2.5 font-medium">Dependency review</th>
            <th className="px-3 py-2.5 font-medium">Security updates</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => {
            const open = total(repo.secrets) + total(repo.code) + total(repo.vulnerabilities);
            const critical = repo.secrets.critical + repo.code.critical + repo.vulnerabilities.critical;
            const high = repo.secrets.high + repo.code.high + repo.vulnerabilities.high;
            return (
              <tr key={repo.repoId} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <Link to={`/${owner}/${repo.name}/security`} className="font-mono text-sm font-medium hover:underline">
                    {repo.name}
                  </Link>
                  {repo.private && <span className="ml-2 text-xs text-faint">private</span>}
                </td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                  {open === 0 ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <ShieldCheck size={13} /> None
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {critical > 0 && <Badge tone="danger">{critical} critical</Badge>}
                      {high > 0 && <Badge tone="warn">{high} high</Badge>}
                      {open - critical - high > 0 && <Badge>{open - critical - high} other</Badge>}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs">
                  <On on>On</On>
                </td>
                <td className="px-3 py-2.5 text-xs tabular-nums">
                  <On on={repo.customPatterns > 0}>{repo.customPatterns > 0 ? `${repo.customPatterns}` : "None"}</On>
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {repo.codeScanningAt ? (
                    <span className="text-success">
                      <TimeAgo at={repo.codeScanningAt} />
                    </span>
                  ) : (
                    <span className="text-faint">Not set up</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs">
                  <On on={repo.dependencyReview && repo.lockfiles > 0}>{repo.lockfiles === 0 ? "No lockfiles" : undefined}</On>
                </td>
                <td className="px-3 py-2.5 text-xs">
                  <On on={repo.securityUpdates} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Fix with g1t": an issue for g1t, as the person asking. */
export function FixWithG1t({ id, action, issue, base }: { id: string; action: string; issue: number | null; base: string }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; issue?: number; message?: string | null }>();
  const opened = fetcher.data?.issue ?? issue;
  if (opened != null) {
    return (
      <Link to={`${base}/issues/${opened}`} className={`${SMALL_BUTTON} inline-flex items-center gap-1.5`}>
        <Bot size={13} /> g1t is on #{opened}
      </Link>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <Hint label="Opens an issue assigned to g1t; its run is charged as agent usage">
        <button
          type="button"
          disabled={fetcher.state !== "idle"}
          onClick={() => fetcher.submit({ intent: "fix", id }, { method: "post", action })}
          className={`${SMALL_BUTTON} inline-flex items-center gap-1.5`}
        >
          <Sparkles size={13} />
          {fetcher.state !== "idle" ? "Opening…" : "Fix with g1t"}
        </button>
      </Hint>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </span>
  );
}

/** Pushing past push protection with a reason, or asking to. */
export function BypassForm({ id, action, request }: { id: string; action: string; request: boolean }) {
  const fetcher = useFetcher<Done & { requested?: boolean }>();
  const [reason, setReason] = useState("");
  if (fetcher.data?.ok) {
    return (
      <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
        {fetcher.data.requested
          ? "Asked. The workspace's owners and the repository's admins were told; push again once one approves."
          : "Bypassed. Push again and it goes through."}
      </p>
    );
  }
  return (
    <fetcher.Form method="post" action={action} className="space-y-3">
      <input type="hidden" name="intent" value="bypass" />
      <input type="hidden" name="id" value={id} />
      <fieldset>
        <legend className="text-xs font-medium text-muted">Why does it need to go through?</legend>
        <RadioGroup name="reason" value={reason} onValueChange={setReason} required className="mt-2 gap-3">
          {BYPASS_REASONS.map((option) => (
            <RadioOption key={option.reason} value={option.reason} label={option.label} description={option.about} />
          ))}
        </RadioGroup>
      </fieldset>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Comment (optional)</span>
        <textarea name="comment" rows={2} maxLength={500} className={INPUT} placeholder="What a reviewer should know." />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={fetcher.state !== "idle" || !reason} className={PRIMARY}>
          {fetcher.state !== "idle" ? "Sending…" : request ? "Ask to bypass" : "Bypass push protection"}
        </button>
        <span className="text-xs text-muted">Recorded with your name and reason, on the alert and in the audit log.</span>
      </div>
      {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
    </fetcher.Form>
  );
}

export type PatternDraft = {
  id?: string;
  name: string;
  pattern: string;
  before: string;
  after: string;
  testStrings: string;
  published: boolean;
};

/** Where a test string matched, the match marked. */
function TestResult({ text, found }: { text: string; found: [number, number] | null }) {
  if (!found) {
    return (
      <li className="flex items-start gap-2 font-mono text-xs break-all">
        <CircleSlash size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="text-muted">{text}</span>
      </li>
    );
  }
  const chars = [...text];
  return (
    <li className="flex items-start gap-2 font-mono text-xs break-all">
      <CircleCheck size={13} className="mt-0.5 shrink-0 text-success" />
      <span>
        {chars.slice(0, found[0]).join("")}
        <mark className="rounded-sm bg-accent/25 text-fg">{chars.slice(found[0], found[1]).join("")}</mark>
        {chars.slice(found[1]).join("")}
      </span>
    </li>
  );
}

/**
 * Making or changing a custom pattern: its regular expression, what comes
 * before and after it, test strings, a dry run over the default branch,
 * and saving it as a draft or published.
 */
export function PatternEditor({ draft, action, onDone }: { draft: PatternDraft; action: string; onDone?: () => void }) {
  const save = useFetcher<{ ok: boolean; error?: string; saved?: SavedPattern }>();
  const dry = useFetcher<{ ok: boolean; error?: string; dryRun?: DryRun }>();
  const [form, setForm] = useState(draft);
  useEffect(() => {
    if (save.state === "idle" && save.data?.ok && onDone) onDone();
  }, [save.state, save.data, onDone]);
  const set = (key: keyof PatternDraft) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const fields = (publish: boolean) => ({
    intent: "save_pattern",
    id: form.id ?? "",
    name: form.name,
    pattern: form.pattern,
    before: form.before,
    after: form.after,
    testStrings: form.testStrings,
    publish: String(publish),
  });
  const tests = form.testStrings.split("\n").filter((line) => line.trim());
  const saved = save.data?.saved;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <input value={form.name} onChange={set("name")} maxLength={100} placeholder="Acme API key" className={INPUT} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-muted">Secret format (regular expression)</span>
          <input
            value={form.pattern}
            onChange={set("pattern")}
            maxLength={1000}
            spellCheck={false}
            placeholder="acme_[a-z0-9]{32}"
            className={`${INPUT} font-mono`}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Before the secret (optional)</span>
          <input value={form.before} onChange={set("before")} spellCheck={false} placeholder="\A|[^0-9A-Za-z]" className={`${INPUT} font-mono`} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">After the secret (optional)</span>
          <input value={form.after} onChange={set("after")} spellCheck={false} placeholder="\z|[^0-9A-Za-z]" className={`${INPUT} font-mono`} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-muted">Test strings, one a line</span>
          <textarea value={form.testStrings} onChange={set("testStrings")} rows={3} spellCheck={false} className={`${INPUT} font-mono`} />
        </label>
      </div>
      <p className="text-xs text-muted">
        Patterns use the Rust regex syntax, which runs in time linear in the text: no look-around or back-references. Before and
        after default to a line edge or a character that is not a letter or digit.
      </p>
      {saved && tests.length > 0 && (
        <ul className="space-y-1">
          {tests.map((text, at) => (
            <TestResult key={at} text={text} found={saved.tests[at] ?? null} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={save.state !== "idle" || !form.name.trim() || !form.pattern.trim()}
          onClick={() => save.submit(fields(true), { method: "post", action })}
          className={PRIMARY}
        >
          {save.state !== "idle" ? "Saving…" : form.published ? "Save" : "Publish"}
        </button>
        <button
          type="button"
          disabled={save.state !== "idle" || !form.name.trim() || !form.pattern.trim()}
          onClick={() => save.submit(fields(false), { method: "post", action })}
          className={SMALL_BUTTON}
        >
          {form.published ? "Unpublish, keep as draft" : "Save as draft"}
        </button>
        <button
          type="button"
          disabled={dry.state !== "idle" || !form.pattern.trim()}
          onClick={() => dry.submit({ intent: "dry_run", pattern: form.pattern, before: form.before, after: form.after }, { method: "post", action })}
          className={SMALL_BUTTON}
        >
          {dry.state !== "idle" ? "Running…" : "Dry run"}
        </button>
        {form.id && (
          <button
            type="button"
            disabled={save.state !== "idle"}
            onClick={() => {
              if (confirm(`Delete "${form.name}"? The alerts it found stay.`)) save.submit({ intent: "delete_pattern", id: form.id ?? "" }, { method: "post", action });
            }}
            className="ml-auto rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>
      {save.data?.error && <p className="text-sm text-danger">{save.data.error}</p>}
      {save.data?.ok && (saved ? <p className="text-sm text-success">Saved{saved.pattern.state === "published" ? " and published: the history is scanned again for it" : " as a draft"}.</p> : <p className="text-sm text-success">Deleted. The alerts it found stay.</p>)}
      {dry.data?.error && <p className="text-sm text-danger">{dry.data.error}</p>}
      {dry.data?.dryRun && <DryRunResults dryRun={dry.data.dryRun} />}
    </div>
  );
}

function DryRunResults({ dryRun }: { dryRun: DryRun }) {
  return (
    <div className="space-y-3">
      {dryRun.repos.map((repo) => (
        <section key={repo.name} className={`${CARD} p-3`}>
          <p className="text-sm">
            <span className="font-mono font-medium">{repo.name}</span>
            <span className="text-muted">
              {" "}
              · {repo.matches.length} {repo.matches.length === 1 ? "match" : "matches"} in {repo.filesScanned} files
              {repo.truncated ? " (stopped early)" : ""}
            </span>
          </p>
          {repo.matches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {repo.matches.map((match, at) => (
                <li key={at} className="font-mono text-xs break-all">
                  <span className="inline-flex items-center gap-1 text-fg-soft">
                    <FileCode2 size={12} />
                    {match.path}:{match.line}
                  </span>
                  <span className="text-faint"> {match.preview}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** Reads a pattern form's fields, as the pages' actions take them. */
export function patternFields(form: FormData) {
  const text = (key: string) => String(form.get(key) ?? "");
  return {
    id: text("id") || undefined,
    name: text("name").trim(),
    pattern: text("pattern"),
    before: text("before").trim() || null,
    after: text("after").trim() || null,
    testStrings: text("testStrings")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim()),
    publish: text("publish") === "true",
  };
}
