/**
 * Rulesets on the site: the list, the form that creates and changes one
 * (every rule with its parameters), the rules that hold for one branch,
 * how the rules judged pushes and merges, and the violations a pull
 * request's merge box lists. Used by a repository's Settings → Rules and a
 * workspace's.
 */
import {
  Bot,
  Download,
  FileUp,
  GitBranch,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Tag,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Form, Link } from "react-router";

import type {
  AppliesTo,
  BypassActor,
  BypassActorKind,
  ConfidenceLevel,
  EffectiveRules,
  Enforcement,
  Evaluation,
  EvaluationPage,
  Level,
  MergeMethod,
  PatternOperator,
  RuleEntry,
  RuleType,
  Ruleset,
  RulesetSpec,
  SeenCheck,
  Violation,
  Weekday,
} from "@g1t/contracts";

import { cn } from "../lib/cn";
import {
  ALL,
  DEFAULT_BRANCH,
  RULES,
  RULE_GROUPS,
  describeAppliesTo,
  describeBypassActor,
  exportRuleset,
  importRuleset,
  newRule,
  patternLabel,
  ruleInfo,
  targetSummary,
} from "../lib/rules";
import { Button, ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { CheckboxOption } from "./ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

// --- Small pieces -----------------------------------------------------------

const ENFORCEMENT: Record<Enforcement, { label: string; about: string; tone: "accent" | "info" | "neutral" }> = {
  active: { label: "Active", about: "Its rules hold: what breaks them is refused.", tone: "accent" },
  evaluate: { label: "Evaluate", about: "A dry run: nothing is refused, and what would have been is recorded in Insights.", tone: "info" },
  disabled: { label: "Disabled", about: "Kept, but not evaluated.", tone: "neutral" },
};

export function EnforcementBadge({ enforcement }: { enforcement: Enforcement }) {
  const info = ENFORCEMENT[enforcement];
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

/** A list of patterns or names, as removable chips and a field to add one. */
export function PatternList({
  values,
  onChange,
  placeholder,
  quick = [],
  disabled,
  label,
  mono = true,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  quick?: { value: string; label: string }[];
  disabled?: boolean;
  label: string;
  mono?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setTyped("");
  };
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((value) => (
            <li key={value} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-bg py-0.5 pr-1 pl-2 text-sm">
              <span className={cn("truncate", mono && !value.startsWith("~") && "font-mono text-[0.8125rem]")}>{patternLabel(value)}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${patternLabel(value)}`}
                  className="rounded p-0.5 text-faint hover:bg-surface hover:text-fg"
                  onClick={() => onChange(values.filter((other) => other !== value))}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={typed}
            aria-label={label}
            placeholder={placeholder}
            className="w-56 max-w-full font-mono text-[0.8125rem]"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add(typed);
              }
            }}
          />
          <Button type="button" variant="quiet" onClick={() => add(typed)} disabled={!typed.trim()}>
            <Plus size={14} /> Add
          </Button>
          {quick
            .filter((option) => !values.includes(option.value))
            .map((option) => (
              <button
                key={option.value}
                type="button"
                className="rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-muted hover:border-line-strong hover:text-fg"
                onClick={() => add(option.value)}
              >
                + {option.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={cn("w-auto min-w-28", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  about,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  about?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="block text-sm text-fg">{title}</span>
        {about && <span className="mt-0.5 block text-xs text-muted">{about}</span>}
      </span>
      <Switch size="sm" checked={checked} onCheckedChange={(next) => onChange(next === true)} disabled={disabled} className="mt-0.5" aria-label={title} />
    </label>
  );
}

function NumberField({
  value,
  onChange,
  label,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-fg">{label}</span>
      <span className="flex items-center gap-2">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          disabled={disabled}
          className="w-24 text-right"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix && <span className="text-sm text-muted">{suffix}</span>}
      </span>
    </label>
  );
}

// --- Rule parameters ----------------------------------------------------------

const OPERATORS: { value: PatternOperator; label: string }[] = [
  { value: "starts_with", label: "Starts with" },
  { value: "ends_with", label: "Ends with" },
  { value: "contains", label: "Contains" },
  { value: "regex", label: "Matches regex" },
];
const LEVELS: { value: ConfidenceLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** An RFC 3339 time as a datetime-local value, in the viewer's zone. */
function toLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type Periods = { start: string; end?: string | null; reason: string }[];

function PeriodList({
  periods,
  onChange,
  label,
  disabled,
  allowOpen,
}: {
  periods: Periods;
  onChange: (periods: Periods) => void;
  label: string;
  disabled?: boolean;
  allowOpen?: boolean;
}) {
  return (
    <div className="space-y-2">
      {periods.map((period, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
          <Input
            type="datetime-local"
            aria-label={`${label} ${index + 1} starts`}
            value={toLocal(period.start)}
            disabled={disabled}
            className="w-auto"
            onChange={(event) => onChange(periods.map((one, at) => (at === index ? { ...one, start: fromLocal(event.target.value) ?? one.start } : one)))}
          />
          <span className="text-sm text-muted">to</span>
          <Input
            type="datetime-local"
            aria-label={`${label} ${index + 1} ends`}
            value={toLocal(period.end)}
            disabled={disabled}
            className="w-auto"
            onChange={(event) => onChange(periods.map((one, at) => (at === index ? { ...one, end: fromLocal(event.target.value) } : one)))}
          />
          <Input
            aria-label={`${label} ${index + 1} reason`}
            placeholder="Why"
            value={period.reason}
            disabled={disabled}
            className="w-40 grow"
            onChange={(event) => onChange(periods.map((one, at) => (at === index ? { ...one, reason: event.target.value } : one)))}
          />
          {!disabled && (
            <button type="button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} className="rounded p-1 text-faint hover:text-fg" onClick={() => onChange(periods.filter((_, at) => at !== index))}>
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="quiet"
            onClick={() => onChange([...periods, { start: new Date().toISOString(), end: new Date(Date.now() + 86_400_000).toISOString(), reason: "" }])}
          >
            <Plus size={14} /> {label}
          </Button>
          {allowOpen && (
            <Button type="button" variant="quiet" onClick={() => onChange([...periods, { start: new Date().toISOString(), end: null, reason: "Incident" }])}>
              <ShieldAlert size={14} /> Freeze now, until lifted
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The parameters of one rule, as fields. */
function Parameters({
  entry,
  onChange,
  seen,
  disabled,
}: {
  entry: RuleEntry;
  onChange: (entry: RuleEntry) => void;
  seen: SeenCheck[];
  disabled?: boolean;
}) {
  // Each case narrows `entry` and writes back its own parameters.
  const set = (parameters: object) => onChange({ ...entry, parameters } as RuleEntry);
  switch (entry.type) {
    case "pull_request": {
      const p = entry.parameters;
      const methods: MergeMethod[] = ["merge", "squash", "rebase"];
      return (
        <div className="divide-y divide-line">
          <NumberField label="Required approvals" min={0} max={10} value={p.required_approvals} disabled={disabled} onChange={(value) => set({ ...p, required_approvals: value })} />
          <Toggle title="An agent's approval counts" about="Off: approvals must come from people." checked={p.count_agent_approvals} disabled={disabled} onChange={(value) => set({ ...p, count_agent_approvals: value })} />
          <Toggle title="Dismiss approvals when new commits are pushed" checked={p.dismiss_stale_reviews_on_push} disabled={disabled} onChange={(value) => set({ ...p, dismiss_stale_reviews_on_push: value })} />
          <Toggle title="Require review from code owners" about="The owners of every file it changes, as CODEOWNERS names them, approve." checked={p.require_code_owner_review} disabled={disabled} onChange={(value) => set({ ...p, require_code_owner_review: value })} />
          <Toggle title="Require approval of the most recent push" about="Someone other than whoever pushed last approves after that push." checked={p.require_last_push_approval} disabled={disabled} onChange={(value) => set({ ...p, require_last_push_approval: value })} />
          {p.allow_direct_pushes && (
            <Toggle
              title="Still allow pushes straight to the branch"
              about="Kept from branch protection that did not require pull requests. Turn it off to require them."
              checked={p.allow_direct_pushes}
              disabled={disabled}
              onChange={(value) => set({ ...p, allow_direct_pushes: value })}
            />
          )}
          <div className="py-2">
            <p className="text-sm text-fg">Allowed merge methods</p>
            <p className="mt-0.5 text-xs text-muted">None ticked allows every one. g1t merges by landing the branch as it is (merge).</p>
            <div className="mt-2 flex flex-wrap gap-4">
              {methods.map((method) => (
                <CheckboxOption
                  key={method}
                  label={method[0]!.toUpperCase() + method.slice(1)}
                  checked={p.allowed_merge_methods.includes(method)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    set({
                      ...p,
                      allowed_merge_methods: checked
                        ? [...p.allowed_merge_methods, method]
                        : p.allowed_merge_methods.filter((other) => other !== method),
                    })
                  }
                />
              ))}
            </div>
          </div>
        </div>
      );
    }
    case "required_status_checks": {
      const p = entry.parameters;
      const names = p.checks.map((check) => check.context);
      const suggestions = seen.map((check) => check.name).filter((name) => !names.some((have) => have.toLowerCase() === name.toLowerCase()));
      return (
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-sm text-fg">Checks</p>
            <ul className="space-y-1.5">
              {p.checks.map((check, index) => (
                <li key={check.context} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                  <span className="grow font-mono text-[0.8125rem]">{check.context}</span>
                  <Choice
                    label={`Where ${check.context} comes from`}
                    value={check.integration ?? "any"}
                    disabled={disabled}
                    options={[
                      { value: "any", label: "Any source" },
                      { value: "actions", label: "Workflows" },
                      { value: "deployments", label: "Deployments" },
                      { value: "security", label: "Security" },
                      { value: "g1t", label: "g1t" },
                      { value: "api", label: "The API" },
                    ]}
                    onChange={(value) =>
                      set({
                        ...p,
                        checks: p.checks.map((one, at) =>
                          at === index ? (value === "any" ? { context: one.context } : { context: one.context, integration: value }) : one,
                        ),
                      })
                    }
                  />
                  {!disabled && (
                    <button type="button" aria-label={`Stop requiring ${check.context}`} className="rounded p-1 text-faint hover:text-fg" onClick={() => set({ ...p, checks: p.checks.filter((_, at) => at !== index) })}>
                      <X size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <PatternList
                label="Add a required check"
                values={[]}
                placeholder="CI"
                mono={false}
                disabled={disabled}
                quick={suggestions.slice(0, 8).map((name) => ({ value: name, label: name }))}
                onChange={(added) => set({ ...p, checks: [...p.checks, ...added.map((context) => ({ context }))] })}
              />
            </div>
          </div>
          <div className="divide-y divide-line">
            <Toggle title="Require branches to be up to date before merging" about="What merges is exactly what was checked." checked={p.strict} disabled={disabled} onChange={(value) => set({ ...p, strict: value })} />
            <Toggle title="Let someone who may merge bypass these checks" about="They tick a box as they merge, and the pull request says who did." checked={p.allow_bypass_on_merge} disabled={disabled} onChange={(value) => set({ ...p, allow_bypass_on_merge: value })} />
          </div>
          <div>
            <p className="text-sm text-fg">Only when these paths change</p>
            <p className="mb-2 text-xs text-muted">Empty: always required.</p>
            <PatternList label="Paths" values={p.paths} placeholder="infra/**" disabled={disabled} onChange={(paths) => set({ ...p, paths })} />
          </div>
        </div>
      );
    }
    case "merge_queue": {
      const p = entry.parameters;
      return (
        <div className="divide-y divide-line">
          <NumberField label="Pull requests tested at once" min={1} max={20} value={p.max_entries_to_build} disabled={disabled} onChange={(value) => set({ ...p, max_entries_to_build: value })} />
          <NumberField label="Smallest batch to start" min={1} max={20} value={p.min_entries_to_merge} disabled={disabled} onChange={(value) => set({ ...p, min_entries_to_merge: value })} />
          <NumberField label="Wait for a batch to fill, at most" min={0} max={360} value={p.min_entries_wait_minutes} suffix="min" disabled={disabled} onChange={(value) => set({ ...p, min_entries_wait_minutes: value })} />
          <NumberField label="Check timeout" min={5} max={360} value={p.check_response_timeout_minutes} suffix="min" disabled={disabled} onChange={(value) => set({ ...p, check_response_timeout_minutes: value })} />
        </div>
      );
    }
    case "required_deployments":
      return (
        <PatternList
          label="Environments"
          values={entry.parameters.environments}
          placeholder="preview, or a project's slug"
          quick={[{ value: "preview", label: "preview" }]}
          disabled={disabled}
          onChange={(environments) => set({ environments })}
        />
      );
    case "commit_message_pattern":
    case "commit_author_email_pattern":
    case "committer_email_pattern":
    case "branch_name_pattern":
    case "tag_name_pattern": {
      const p = entry.parameters;
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Choice label="How it compares" value={p.operator} options={OPERATORS} disabled={disabled} onChange={(operator) => set({ ...p, operator })} />
            <Input aria-label="Pattern" value={p.pattern} disabled={disabled} placeholder={p.operator === "regex" ? "^(feat|fix)(\\(.+\\))?: " : "@acme.com"} className="w-64 grow font-mono text-[0.8125rem]" onChange={(event) => set({ ...p, pattern: event.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <CheckboxOption label="Must not match" checked={p.negate} disabled={disabled} onCheckedChange={(checked) => set({ ...p, negate: checked === true })} />
            <Input aria-label="What people call it" value={p.name} disabled={disabled} placeholder="Name it, e.g. Conventional commits" className="w-64 grow" onChange={(event) => set({ ...p, name: event.target.value })} />
          </div>
          {p.operator === "regex" && <p className="text-xs text-muted">Runs on a linear-time engine: no look-around or back-references.</p>}
        </div>
      );
    }
    case "file_path_restriction":
      return (
        <PatternList
          label="Restricted paths"
          values={entry.parameters.restricted_file_paths}
          placeholder=".g1t/workflows/**"
          quick={[
            { value: ".g1t/workflows/**", label: "Workflows" },
            { value: "CODEOWNERS", label: "CODEOWNERS" },
          ]}
          disabled={disabled}
          onChange={(restricted_file_paths) => set({ restricted_file_paths })}
        />
      );
    case "file_extension_restriction":
      return (
        <PatternList
          label="Restricted extensions"
          values={entry.parameters.restricted_file_extensions}
          placeholder=".exe"
          quick={[
            { value: ".exe", label: ".exe" },
            { value: ".zip", label: ".zip" },
          ]}
          disabled={disabled}
          onChange={(restricted_file_extensions) => set({ restricted_file_extensions })}
        />
      );
    case "max_file_size":
      return <NumberField label="Largest file" min={1} max={100} suffix="MB" value={entry.parameters.max_file_size_mb} disabled={disabled} onChange={(max_file_size_mb) => set({ max_file_size_mb })} />;
    case "max_file_path_length":
      return <NumberField label="Longest path" min={1} max={4096} suffix="characters" value={entry.parameters.max_file_path_length} disabled={disabled} onChange={(max_file_path_length) => set({ max_file_path_length })} />;
    case "max_files_changed":
      return <NumberField label="Most files one commit changes" min={1} max={100000} value={entry.parameters.max_files} disabled={disabled} onChange={(max_files) => set({ max_files })} />;
    case "confidence_threshold": {
      const p = entry.parameters;
      return (
        <div className="divide-y divide-line">
          <label className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-sm text-fg">Changes rated below</span>
            <Choice label="Lowest confidence that merges without people" value={p.minimum} options={LEVELS} disabled={disabled} onChange={(minimum) => set({ ...p, minimum })} />
          </label>
          <NumberField label="need approvals from people" min={1} max={10} value={p.required_approvals} disabled={disabled} onChange={(required_approvals) => set({ ...p, required_approvals })} />
        </div>
      );
    }
    case "cost_cap":
      return <NumberField label="Most agents may spend on one pull request" min={0.5} max={10000} step={0.5} suffix="USD" value={entry.parameters.max_usd} disabled={disabled} onChange={(max_usd) => set({ max_usd })} />;
    case "path_review": {
      const p = entry.parameters;
      return (
        <div className="space-y-2">
          <PatternList label="Sensitive paths" values={p.paths} placeholder="infra/**" disabled={disabled} onChange={(paths) => set({ ...p, paths })} />
          <NumberField label="Approvals from people" min={1} max={10} value={p.required_approvals} disabled={disabled} onChange={(required_approvals) => set({ ...p, required_approvals })} />
          <label className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-sm text-fg">From the team</span>
            <Input aria-label="Team" value={p.team ?? ""} disabled={disabled} placeholder="Anyone, or workspace/team" className="w-56" onChange={(event) => set({ ...p, team: event.target.value || null })} />
          </label>
        </div>
      );
    }
    case "merge_window": {
      const p = entry.parameters;
      return (
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-fg">Time zone, as an offset from UTC</span>
            <Input aria-label="Time zone" value={p.time_zone} disabled={disabled} placeholder="UTC or +02:00" className="w-32" onChange={(event) => set({ ...p, time_zone: event.target.value })} />
          </label>
          <div>
            <p className="text-sm text-fg">Weekly hours when merging is open</p>
            <p className="mb-2 text-xs text-muted">None: open whenever no freeze covers the moment.</p>
            <div className="space-y-2">
              {p.windows.map((window, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
                  <div className="flex flex-wrap gap-1">
                    {DAYS.map((day) => {
                      const on = window.days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={on}
                          disabled={disabled}
                          className={cn("rounded-md border px-2 py-1 text-xs", on ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}
                          onClick={() =>
                            set({
                              ...p,
                              windows: p.windows.map((one, at) =>
                                at === index ? { ...one, days: on ? one.days.filter((other) => other !== day) : DAYS.filter((d) => d === day || one.days.includes(d)) } : one,
                              ),
                            })
                          }
                        >
                          {DAY_LABEL[day]}
                        </button>
                      );
                    })}
                  </div>
                  <Input type="time" aria-label="Opens" value={window.start} disabled={disabled} className="w-28" onChange={(event) => set({ ...p, windows: p.windows.map((one, at) => (at === index ? { ...one, start: event.target.value } : one)) })} />
                  <span className="text-sm text-muted">to</span>
                  <Input type="time" aria-label="Closes" value={window.end} disabled={disabled} className="w-28" onChange={(event) => set({ ...p, windows: p.windows.map((one, at) => (at === index ? { ...one, end: event.target.value } : one)) })} />
                  {!disabled && (
                    <button type="button" aria-label={`Remove window ${index + 1}`} className="rounded p-1 text-faint hover:text-fg" onClick={() => set({ ...p, windows: p.windows.filter((_, at) => at !== index) })}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {!disabled && (
                <Button type="button" variant="quiet" onClick={() => set({ ...p, windows: [...p.windows, { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }] })}>
                  <Plus size={14} /> Weekly hours
                </Button>
              )}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm text-fg">Freezes: merging waits</p>
            <PeriodList label="Freeze" periods={p.freezes} allowOpen disabled={disabled} onChange={(freezes) => set({ ...p, freezes })} />
          </div>
          <div>
            <p className="mb-2 text-sm text-fg">Exceptions: merging is open whatever else says</p>
            <PeriodList label="Exception" periods={p.exceptions} disabled={disabled} onChange={(exceptions) => set({ ...p, exceptions })} />
          </div>
        </div>
      );
    }
    case "agent_auto_merge": {
      const p = entry.parameters;
      return (
        <div className="divide-y divide-line">
          <Toggle title="Agents' ready changes may merge here by themselves" about="The repository's auto-merge setting must be on too." checked={p.allowed} disabled={disabled} onChange={(allowed) => set({ ...p, allowed })} />
          <label className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-sm text-fg">Only at this confidence or higher</span>
            <Choice
              label="Lowest confidence that merges by itself"
              value={p.minimum_confidence ?? "any"}
              options={[{ value: "any", label: "Any" }, ...LEVELS]}
              disabled={disabled}
              onChange={(value) => set({ ...p, minimum_confidence: value === "any" ? null : value })}
            />
          </label>
        </div>
      );
    }
    default:
      return null;
  }
}

const APPLIES: { value: AppliesTo; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "agents", label: "Agents' changes" },
  { value: "people", label: "People's changes" },
];

function RuleCard({
  entry,
  onChange,
  onRemove,
  seen,
  disabled,
}: {
  entry: RuleEntry;
  onChange: (entry: RuleEntry) => void;
  onRemove: () => void;
  seen: SeenCheck[];
  disabled?: boolean;
}) {
  const info = ruleInfo(entry.type);
  const agentsOnly = info?.group === "agents";
  return (
    <li className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 grow basis-60">
          <p className="flex items-center gap-2 text-sm font-medium">
            {agentsOnly && <Bot size={14} className="text-accent" />}
            {info?.label ?? entry.type}
          </p>
          <p className="mt-0.5 text-sm text-muted">{info?.about}</p>
        </div>
        <div className="flex items-center gap-2">
          <Choice label={`Whose changes ${info?.label ?? entry.type} holds for`} value={entry.applies_to} options={APPLIES} disabled={disabled} onChange={(applies_to) => onChange({ ...entry, applies_to })} />
          {!disabled && (
            <button type="button" aria-label={`Remove ${info?.label ?? entry.type}`} className="rounded-md p-1.5 text-faint hover:bg-bg hover:text-danger" onClick={onRemove}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
      {Object.keys(entry.parameters).length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <Parameters entry={entry} onChange={onChange} seen={seen} disabled={disabled} />
        </div>
      )}
    </li>
  );
}

// --- Bypass list --------------------------------------------------------------

const KINDS: { value: BypassActorKind; label: string; placeholder: string }[] = [
  { value: "role", label: "Role", placeholder: "admin" },
  { value: "team", label: "Team", placeholder: "workspace/team" },
  { value: "user", label: "Person", placeholder: "username" },
  { value: "token", label: "Token", placeholder: "token id, or workspace" },
  { value: "g1t", label: "g1t", placeholder: "" },
];

function BypassList({ actors, onChange, disabled }: { actors: BypassActor[]; onChange: (actors: BypassActor[]) => void; disabled?: boolean }) {
  const update = (index: number, change: Partial<BypassActor>) => onChange(actors.map((one, at) => (at === index ? { ...one, ...change } : one)));
  const hasG1t = actors.some((actor) => actor.kind === "g1t");
  return (
    <div className="space-y-2">
      {actors.length === 0 && <p className="text-sm text-muted">Nobody: these rules hold for everyone, people and agents alike, g1t included.</p>}
      <ul className="space-y-2">
        {actors.map((actor, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
            <Choice label="Who" value={actor.kind} options={KINDS} disabled={disabled} onChange={(kind) => update(index, { kind, value: kind === "role" ? "admin" : "" })} />
            {actor.kind === "role" ? (
              <Choice
                label="Role"
                value={actor.value || "admin"}
                disabled={disabled}
                options={[
                  { value: "write", label: "Write and up" },
                  { value: "maintain", label: "Maintain and up" },
                  { value: "admin", label: "Admin" },
                  { value: "owner", label: "Workspace owners" },
                ]}
                onChange={(value) => update(index, { value })}
              />
            ) : actor.kind === "g1t" ? (
              <span className="grow text-sm text-muted">g1t's agents and g1t itself (the merge queue, security updates)</span>
            ) : (
              <Input aria-label="Who, by name" value={actor.value} disabled={disabled} placeholder={KINDS.find((kind) => kind.value === actor.kind)?.placeholder} className="w-48 grow" onChange={(event) => update(index, { value: event.target.value })} />
            )}
            <Choice
              label="When"
              value={actor.mode}
              disabled={disabled}
              options={[
                { value: "always", label: "Always" },
                { value: "pull_requests", label: "Pull requests only" },
              ]}
              onChange={(mode) => update(index, { mode })}
            />
            {!disabled && (
              <button type="button" aria-label={`Remove ${describeBypassActor(actor)}`} className="rounded p-1 text-faint hover:text-fg" onClick={() => onChange(actors.filter((_, at) => at !== index))}>
                <X size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {hasG1t && (
        <p className="flex items-start gap-2 text-xs text-warn">
          <TriangleAlert size={13} className="mt-px shrink-0" /> g1t's agents bypass these rules. Agents obey rules exactly as people do unless they are listed here.
        </p>
      )}
      {!disabled && (
        <Button type="button" variant="quiet" onClick={() => onChange([...actors, { kind: "role", value: "admin", mode: "pull_requests" }])}>
          <Plus size={14} /> Add a bypass
        </Button>
      )}
    </div>
  );
}

// --- The form -----------------------------------------------------------------

function Block({ title, about, children }: { title: string; about: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-3 border-t border-line pt-6 lg:grid-cols-[14rem_1fr]">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{about}</p>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

/** Downloads `ruleset` as a JSON file. */
function download(ruleset: RulesetSpec) {
  const blob = new Blob([JSON.stringify(exportRuleset(ruleset), null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(ruleset.name || "ruleset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ruleset"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Creating or changing a ruleset. The ruleset is posted whole, as JSON in
 * `ruleset`, with `intent` `save`; deleting posts `intent` `delete`.
 */
export function RulesetForm({
  initial,
  level,
  existing,
  seen = [],
  editable,
  error,
  backHref,
  repositoryLabel,
}: {
  initial: RulesetSpec;
  level: Level;
  /** The ruleset being changed; absent for a new one. */
  existing?: Ruleset;
  /** Check names reported lately, to require. */
  seen?: SeenCheck[];
  editable: boolean;
  error?: string | null;
  backHref: string;
  /** For a repository's: its name, for the hint about the default branch. */
  repositoryLabel?: string;
}) {
  const [spec, setSpec] = useState<RulesetSpec>(initial);
  const [imported, setImported] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const disabled = !editable;
  const update = (change: Partial<RulesetSpec>) => setSpec((current) => ({ ...current, ...change }));
  const addable = RULES.filter(
    (info) => info.targets.includes(spec.target) && (info.repeatable || !spec.rules.some((rule) => rule.type === info.type && rule.applies_to === "everyone")),
  );
  const fromBranchProtection = existing?.source === "branch_protection";
  return (
    <>
    <Form method="post" className="space-y-6">
      <input type="hidden" name="intent" value="save" />
      <input type="hidden" name="ruleset" value={JSON.stringify(spec)} />
      {fromBranchProtection && (
        <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 p-3 text-sm text-muted">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-info" />
          Made from this repository's branch protection settings, holding exactly what they held. The pull request, status check and merge
          queue rules here are also what Settings → Branches and the settings API read and write.
        </p>
      )}
      <section className="grid gap-4 md:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Name</span>
          <Input name="name" value={spec.name} disabled={disabled} maxLength={100} placeholder="Protect main" required onChange={(event) => update({ name: event.target.value })} />
        </label>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Targets</span>
          <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Targets">
            {(["branch", "tag"] as const).map((target) => (
              <button
                key={target}
                type="button"
                role="radio"
                aria-checked={spec.target === target}
                disabled={disabled}
                className={cn("flex items-center gap-1.5 rounded px-3 py-1.5 text-sm", spec.target === target ? "bg-surface text-fg" : "text-muted hover:text-fg")}
                onClick={() =>
                  update({
                    target,
                    conditions: { ...spec.conditions, ref_name: { include: target === "tag" ? [] : [DEFAULT_BRANCH], exclude: [] } },
                    rules: spec.rules.filter((rule) => ruleInfo(rule.type)?.targets.includes(target)),
                  })
                }
              >
                {target === "branch" ? <GitBranch size={14} /> : <Tag size={14} />}
                {target === "branch" ? "Branches" : "Tags"}
              </button>
            ))}
          </div>
        </div>
      </section>

      <Block title="Enforcement" about="Try a ruleset in evaluate first: Insights shows what it would have refused.">
        <RadioGroup value={spec.enforcement} onValueChange={(value) => update({ enforcement: value as Enforcement })} disabled={disabled} className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(ENFORCEMENT) as Enforcement[]).map((enforcement) => (
            <RadioOption key={enforcement} value={enforcement} label={ENFORCEMENT[enforcement].label} description={ENFORCEMENT[enforcement].about} />
          ))}
        </RadioGroup>
      </Block>

      <Block
        title={spec.target === "branch" ? "Branches" : "Tags"}
        about={
          <>
            Names it holds for: fnmatch patterns, <code>*</code> within a segment and <code>**</code> across them.
            {repositoryLabel ? ` Default branch follows ${repositoryLabel}'s default branch if it is renamed.` : ""}
          </>
        }
      >
        <div>
          <p className="mb-2 text-sm text-fg">Include</p>
          <PatternList
            label="Include"
            values={spec.conditions.ref_name.include}
            placeholder={spec.target === "branch" ? "release/*" : "v*"}
            quick={
              spec.target === "branch"
                ? [
                    { value: DEFAULT_BRANCH, label: "Default branch" },
                    { value: ALL, label: "All branches" },
                  ]
                : [{ value: ALL, label: "All tags" }]
            }
            disabled={disabled}
            onChange={(include) => update({ conditions: { ...spec.conditions, ref_name: { ...spec.conditions.ref_name, include } } })}
          />
        </div>
        <div>
          <p className="mb-2 text-sm text-fg">Exclude</p>
          <PatternList
            label="Exclude"
            values={spec.conditions.ref_name.exclude}
            placeholder={spec.target === "branch" ? "dependabot/**" : "v*-rc*"}
            disabled={disabled}
            onChange={(exclude) => update({ conditions: { ...spec.conditions, ref_name: { ...spec.conditions.ref_name, exclude } } })}
          />
        </div>
      </Block>

      {level === "workspace" && spec.conditions.repository && (
        <Block title="Repositories" about="Which of the workspace's repositories it holds in.">
          <div>
            <p className="mb-2 text-sm text-fg">Names to include</p>
            <PatternList
              label="Repositories to include"
              values={spec.conditions.repository.include}
              placeholder="api-*"
              quick={[{ value: ALL, label: "All repositories" }]}
              disabled={disabled}
              onChange={(include) => update({ conditions: { ...spec.conditions, repository: { ...spec.conditions.repository!, include } } })}
            />
          </div>
          <div>
            <p className="mb-2 text-sm text-fg">Names to exclude</p>
            <PatternList
              label="Repositories to exclude"
              values={spec.conditions.repository.exclude}
              placeholder="sandbox-*"
              disabled={disabled}
              onChange={(exclude) => update({ conditions: { ...spec.conditions, repository: { ...spec.conditions.repository!, exclude } } })}
            />
          </div>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-fg">Visibility</span>
            <Choice
              label="Visibility"
              value={spec.conditions.repository.visibility}
              disabled={disabled}
              options={[
                { value: "any", label: "Public and private" },
                { value: "public", label: "Public only" },
                { value: "private", label: "Private only" },
              ]}
              onChange={(visibility) => update({ conditions: { ...spec.conditions, repository: { ...spec.conditions.repository!, visibility } } })}
            />
          </label>
          <div>
            <p className="text-sm text-fg">Topics</p>
            <p className="mb-2 text-xs text-muted">Only repositories carrying one of these. Empty: any.</p>
            <PatternList
              label="Topics"
              values={spec.conditions.repository.topics}
              placeholder="payments"
              mono={false}
              disabled={disabled}
              onChange={(topics) => update({ conditions: { ...spec.conditions, repository: { ...spec.conditions.repository!, topics } } })}
            />
          </div>
        </Block>
      )}

      <Block title="Bypass list" about="Who these rules do not hold for. Nobody bypasses unless listed: agents, g1t's included, obey rules as people do.">
        <BypassList actors={spec.bypass_actors} disabled={disabled} onChange={(bypass_actors) => update({ bypass_actors })} />
      </Block>

      <Block title="Rules" about="Every rule holds at once, and with every other ruleset that targets the same branch: the most restrictive wins. Each can hold for everyone, only agents' changes, or only people's.">
        {spec.rules.length === 0 && <p className="text-sm text-muted">No rules yet.</p>}
        <ul className="space-y-3">
          {spec.rules.map((entry, index) => (
            <RuleCard
              key={`${entry.type}-${index}`}
              entry={entry}
              seen={seen}
              disabled={disabled}
              onChange={(changed) => update({ rules: spec.rules.map((one, at) => (at === index ? changed : one)) })}
              onRemove={() => update({ rules: spec.rules.filter((_, at) => at !== index) })}
            />
          ))}
        </ul>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="quiet">
                <Plus size={14} /> Add a rule
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[60vh] w-80 overflow-y-auto">
              {RULE_GROUPS.map((group, groupIndex) => {
                const rules = addable.filter((info) => info.group === group.id);
                if (rules.length === 0) return null;
                return (
                  <div key={group.id}>
                    {groupIndex > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                    {rules.map((info) => (
                      <DropdownMenuItem key={info.type} onSelect={() => update({ rules: [...spec.rules, newRule(info.type as RuleType)] })}>
                        <span className="min-w-0">
                          <span className="block text-sm">{info.label}</span>
                          <span className="block text-xs text-muted">{info.about}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Block>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
        {editable && (
          <SubmitButton pending="Saving…" match={{ intent: "save" }}>
            {existing ? "Save changes" : "Create ruleset"}
          </SubmitButton>
        )}
        <Link to={backHref} className="text-sm text-muted hover:text-fg">
          {editable ? "Cancel" : "Back to rules"}
        </Link>
        <span className="grow" />
        <Button type="button" variant="quiet" onClick={() => download(spec)}>
          <Download size={14} /> Export JSON
        </Button>
        {editable && (
          <>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (event) => {
                const chosen = event.target.files?.[0];
                event.target.value = "";
                if (!chosen) return;
                try {
                  setSpec(importRuleset(await chosen.text(), level));
                  setImported(`Imported ${chosen.name}. Check it, then save.`);
                } catch (problem) {
                  setImported(problem instanceof Error ? problem.message : "That file could not be read.");
                }
              }}
            />
            <Button type="button" variant="quiet" onClick={() => file.current?.click()}>
              <FileUp size={14} /> Import JSON
            </Button>
          </>
        )}
        {imported && <p className="w-full text-sm text-muted">{imported}</p>}
        <div className="w-full">
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </Form>
    {editable && existing && (
      <Form method="post" className="mt-8 rounded-xl border border-danger/30 p-4">
        <input type="hidden" name="intent" value="delete" />
        <h2 className="font-medium">Delete this ruleset</h2>
        <p className="mt-1 text-sm text-muted">Its rules stop holding at once. Its evaluations stay in Insights.</p>
        <div className="mt-3">
          <SubmitButton variant="danger" pending="Deleting…" match={{ intent: "delete" }}>
            <Trash2 size={14} /> Delete ruleset
          </SubmitButton>
        </div>
      </Form>
    )}
    </>
  );
}

// --- The list -----------------------------------------------------------------

function RulesetRow({ ruleset, href, inherited }: { ruleset: Ruleset; href: string; inherited?: boolean }) {
  const agents = ruleset.rules.some((rule) => rule.applies_to === "agents" || ruleInfo(rule.type)?.group === "agents");
  return (
    <li>
      <Link to={href} className="group flex flex-wrap items-start gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface">
        <span className="mt-0.5 shrink-0 text-muted">
          {ruleset.enforcement === "disabled" ? <ShieldOff size={16} /> : <ShieldCheck size={16} className={ruleset.enforcement === "active" ? "text-accent" : "text-info"} />}
        </span>
        <span className="min-w-0 grow basis-48">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium group-hover:underline">{ruleset.name}</span>
            <EnforcementBadge enforcement={ruleset.enforcement} />
            {inherited && <Badge>From the workspace</Badge>}
            {ruleset.source === "branch_protection" && <Badge>Branch protection</Badge>}
            {agents && (
              <Badge tone="merged">
                <Bot size={11} /> Agent rules
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-sm text-muted">
            {ruleset.target === "tag" ? "Tags" : "Branches"}: {targetSummary(ruleset)} · {ruleset.rules.length} {ruleset.rules.length === 1 ? "rule" : "rules"}
            {ruleset.bypass_actors.length > 0 && ` · ${ruleset.bypass_actors.length} may bypass`}
          </span>
        </span>
        <span className="shrink-0 text-xs text-faint">
          Changed <TimeAgo at={ruleset.updated_at} /> by <span className="font-mono">{ruleset.updated_by}</span>
        </span>
      </Link>
    </li>
  );
}

export function RulesetList({
  rulesets,
  hrefFor,
  level,
  empty,
}: {
  rulesets: Ruleset[];
  hrefFor: (ruleset: Ruleset) => string;
  level: Level;
  empty: ReactNode;
}) {
  if (rulesets.length === 0) {
    return <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">{empty}</div>;
  }
  return (
    <ul className="space-y-2">
      {rulesets.map((ruleset) => (
        <RulesetRow key={ruleset.id} ruleset={ruleset} href={hrefFor(ruleset)} inherited={level === "repository" && ruleset.level === "workspace"} />
      ))}
    </ul>
  );
}

// --- Effective rules ----------------------------------------------------------

/** Every rule that holds for one branch, grouped by where it comes from. */
export function EffectiveRulesView({ effective, hrefFor }: { effective: EffectiveRules; hrefFor: (id: string, level: Level) => string }) {
  if (effective.rules.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">
        No ruleset targets <span className="font-mono text-fg">{effective.name}</span>: anyone who may push can change it however they like.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {effective.rulesets.map((ruleset) => {
        const rules = effective.rules.filter((rule) => rule.ruleset_id === ruleset.id);
        return (
          <div key={ruleset.id} className="rounded-xl border border-line">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <Link to={hrefFor(ruleset.id, ruleset.level)} className="font-medium hover:underline">
                {ruleset.name}
              </Link>
              <EnforcementBadge enforcement={ruleset.enforcement} />
              {ruleset.level === "workspace" && <Badge>Workspace</Badge>}
              <span className="grow" />
              <span className="flex items-center gap-1 text-xs text-muted">
                <Users size={12} />
                {ruleset.bypass_actors.length === 0 ? "Nobody bypasses" : ruleset.bypass_actors.map(describeBypassActor).join(", ")}
              </span>
            </div>
            <ul className="divide-y divide-line">
              {rules.map((rule, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="grow">{ruleInfo(rule.type)?.label ?? rule.type}</span>
                  {rule.applies_to !== "everyone" && <Badge tone="merged">{describeAppliesTo(rule.applies_to)}</Badge>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// --- Insights -----------------------------------------------------------------

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "info" | "warn" }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums", tone === "danger" && "text-danger", tone === "info" && "text-info", tone === "warn" && "text-warn")}>{value}</p>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  push: "Push",
  merge: "Merge",
  create_ref: "Create",
  delete_ref: "Delete",
  rename_ref: "Rename",
  commit: "Commit",
};

function verdictBadge(evaluation: Evaluation) {
  if (evaluation.verdict === "pass") return <Badge tone="accent">Passed</Badge>;
  if (evaluation.verdict === "bypass") return <Badge tone="warn">Bypassed</Badge>;
  if (evaluation.enforcement === "evaluate") return <Badge tone="info">Would block</Badge>;
  return <Badge tone="danger">Blocked</Badge>;
}

/** How the rules judged pushes and merges: the last 30 days, and each evaluation. */
export function InsightsView({ page, showRepository, olderHref }: { page: EvaluationPage; showRepository?: boolean; olderHref?: string | null }) {
  const insights = page.insights;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label={`Evaluations, ${insights.days} days`} value={insights.total} />
        <Stat label="Passed" value={insights.passed} />
        <Stat label="Blocked" value={insights.blocked} tone="danger" />
        <Stat label="Would block" value={insights.would_block} tone="info" />
        <Stat label="Bypassed" value={insights.bypassed} tone="warn" />
      </div>
      {insights.by_rule.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Rules broken most</h3>
          <ul className="space-y-1.5">
            {insights.by_rule.slice(0, 6).map((row) => {
              const top = insights.by_rule[0]!.count || 1;
              return (
                <li key={row.rule} className="flex items-center gap-3 text-sm">
                  <span className="w-56 shrink-0 truncate">{ruleInfo(row.rule)?.label ?? row.rule}</span>
                  <span className="h-2 grow overflow-hidden rounded-full bg-surface">
                    <span className="block h-full rounded-full bg-danger/70" style={{ width: `${Math.max(4, (row.count / top) * 100)}%` }} />
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted">{row.count}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-sm font-medium">Recent evaluations</h3>
        {page.evaluations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">Nothing evaluated yet. Pushes and merges show here as the rules judge them.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {page.evaluations.map((evaluation) => (
              <li key={evaluation.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {verdictBadge(evaluation)}
                  <span className="font-medium">{ACTION_LABEL[evaluation.action] ?? evaluation.action}</span>
                  <span className="font-mono text-[0.8125rem] text-muted">{evaluation.git_ref.replace(/^refs\/(heads|tags)\//, "")}</span>
                  {evaluation.number != null && <span className="text-muted">#{evaluation.number}</span>}
                  <span className="text-muted">
                    by <span className="font-mono">{evaluation.actor}</span>
                    {evaluation.actor_kind !== "person" && <Bot size={12} className="ml-1 inline text-accent" />}
                  </span>
                  {showRepository && evaluation.repository && <span className="text-faint">{evaluation.repository}</span>}
                  <span className="grow" />
                  <span className="text-xs text-faint">
                    {evaluation.ruleset_name} · <TimeAgo at={evaluation.created_at} />
                  </span>
                </div>
                {evaluation.violations.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {evaluation.violations.map((violation, index) => (
                      <li key={index} className="text-sm text-muted">
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {olderHref && (
          <Link to={olderHref} className="mt-3 inline-block text-sm text-muted hover:text-fg">
            Older evaluations →
          </Link>
        )}
      </div>
    </div>
  );
}

// --- The merge box ------------------------------------------------------------

/** Rules a pull request does not meet, each with its ruleset and how to meet it. */
export function ViolationList({ violations, tone = "danger" }: { violations: Violation[]; tone?: "danger" | "info" | "warn" }) {
  const grouped = useMemo(() => {
    const seen = new Set<string>();
    return violations.filter((violation) => {
      const key = `${violation.rule}:${violation.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [violations]);
  return (
    <ul className="space-y-2">
      {grouped.map((violation, index) => (
        <li key={index} className="flex items-start gap-2 text-sm">
          <ShieldAlert size={14} className={cn("mt-0.5 shrink-0", tone === "danger" ? "text-danger" : tone === "info" ? "text-info" : "text-warn")} />
          <span className="min-w-0">
            <span className="text-fg">{violation.message}</span>{" "}
            {violation.remedy && <span className="text-muted">{violation.remedy}</span>}
            <span className="mt-0.5 block text-xs text-faint">
              {ruleInfo(violation.rule)?.label ?? violation.rule} · {violation.ruleset_name}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
