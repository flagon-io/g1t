/**
 * Guardrails: the form a workspace sets its defaults with and a project its
 * overrides, and what a run shows of its caps.
 */
import { Clock, Coins, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form } from "react-router";

import {
  type AgentRun,
  type GuardrailSettings,
  type Guardrails,
  type GuardrailsView,
  RUN_KINDS,
  RUN_KIND_LABEL,
  isActiveRun,
} from "@g1t/contracts";

import { formatCap, tri, workflowDomainLine } from "../lib/guardrails";
import { formatCost } from "./agents";
import { ErrorText, Input, SubmitButton, TimeAgo } from "./ui";
import { CheckboxOption } from "./ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

function Section({ title, about, children }: { title: string; about: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-line pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="font-medium">{title}</h2>
        <div className="mt-1 text-sm text-muted">{about}</div>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

/** A choice of inheriting, or on or off, for one setting. */
function TriSelect({
  name,
  value,
  inherited,
  parent,
  labels,
  title,
  children,
}: {
  name: string;
  value: boolean | null | undefined;
  inherited: boolean;
  parent: string;
  labels: [on: string, off: string];
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-start">
      <div className="min-w-0 grow">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{children}</p>
      </div>
      <Select name={name} defaultValue={tri(value)}>
        <SelectTrigger size="sm" aria-label={title} className="w-full shrink-0 sm:w-auto sm:min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="inherit">
            As {parent} ({(inherited ? labels[0] : labels[1]).toLowerCase()})
          </SelectItem>
          <SelectItem value="on">{labels[0]}</SelectItem>
          <SelectItem value="off">{labels[1]}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** Hosts in a compact list. */
function Hosts({ hosts }: { hosts: string[] }) {
  return (
    <span className="font-mono text-xs break-words text-faint">{hosts.length ? hosts.join(", ") : "none"}</span>
  );
}

/**
 * One level's guardrails. `level` says which: the workspace's defaults,
 * over g1t's, or a project's overrides, over its workspace's.
 */
export function GuardrailsForm({
  view,
  level,
  editable,
  saving,
  saved,
  error,
}: {
  view: GuardrailsView;
  level: "workspace" | "project";
  editable: boolean;
  /** Working for a reason the Save button cannot see; it follows its own submission by itself. */
  saving?: boolean;
  saved: boolean;
  error: string | null | undefined;
}) {
  const own: GuardrailSettings = (level === "project" ? view.project : view.workspace) ?? {};
  // What this level inherits, and what it is called.
  const base: Guardrails = level === "project" ? view.inherited : view.defaults;
  const parent = level === "project" ? "the workspace" : "g1t's default";
  const [registryMode, setRegistryMode] = useState(own.registries ? "custom" : "inherit");
  const shownRegistries = own.registries ?? base.registries;
  const inheritedDomains = level === "project" ? view.inherited.domains : [];
  const inheritedDeny = level === "project" ? view.inherited.deny : [];
  const inheritedWorkflowDomains = level === "project" ? (view.inherited.workflowDomains ?? []) : [];
  return (
    // Keyed to the last change, so after a save the fields show what was kept, as it was tidied.
    <Form key={own.updatedAt ?? "unset"} method="post" className="max-w-4xl space-y-8">
      <fieldset disabled={!editable} className="min-w-0 space-y-8">
        <Section
          title="Network"
          about={
            <>
              Which hosts a sandbox may reach. Requests anywhere else are refused at the sandbox's edge, and
              each refused host shows on the run as a step.
            </>
          }
        >
          <TriSelect
            name="restrictNetwork"
            value={own.restrictNetwork}
            inherited={base.restrictNetwork}
            parent={parent}
            labels={["Restricted", "Open"]}
            title="Only allowed hosts"
          >
            Restricted, a sandbox reaches g1t, the registries below and the domains you list, over HTTP and
            HTTPS only. Open, it reaches the whole internet.
          </TriSelect>
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm font-medium">Always allowed</p>
            <p className="mt-1 text-sm text-muted">
              g1t's own hosts, for cloning, pushing, reporting and the model: <Hosts hosts={view.g1tHosts} />
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 grow">
                <p className="text-sm font-medium">Package registries</p>
                <p className="mt-1 text-sm text-muted">Where installs fetch dependencies from.</p>
              </div>
              <Select name="registries" value={registryMode} onValueChange={setRegistryMode}>
                <SelectTrigger size="sm" aria-label="Package registries" className="w-full shrink-0 sm:w-auto sm:min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="inherit">As {parent}</SelectItem>
                  <SelectItem value="custom">Choose</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {view.registries.map((registry) => (
                <CheckboxOption
                  key={`${registry.id}-${registryMode}`}
                  name={`registry:${registry.id}`}
                  disabled={registryMode !== "custom"}
                  defaultChecked={(registryMode === "custom" ? shownRegistries : base.registries).includes(registry.id)}
                  label={registry.name}
                  description={registry.hosts.join(", ")}
                />
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <label htmlFor="guardrail-domains" className="text-sm font-medium">
              Allowed domains
            </label>
            <p className="mt-1 text-sm text-muted">
              One per line: <span className="font-mono text-xs">api.stripe.com</span>, or{" "}
              <span className="font-mono text-xs">*.example.com</span> for its subdomains.
              {level === "project" && " These add to the workspace's."}
            </p>
            <Textarea
              id="guardrail-domains"
              name="domains"
              className="mt-3 font-mono text-xs"
              rows={4}
              defaultValue={(own.domains ?? []).join("\n")}
              placeholder="api.stripe.com"
            />
            {inheritedDomains.length > 0 && (
              <p className="mt-2 text-xs text-faint">
                From the workspace: <Hosts hosts={inheritedDomains} />
              </p>
            )}
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <label htmlFor="guardrail-workflow-domains" className="text-sm font-medium">
              Workflow-only domains
            </label>
            <p className="mt-1 text-sm text-muted">
              Hosts that only workflow jobs may reach, never agents, such as the API a deploy uploads to. One
              per line: the domain, then the workflows and the environments it is for, each comma-separated;
              leave either out for any. Only jobs of runs that are not pull requests from forks get them.
              {level === "project" && " These add to the workspace's."}
            </p>
            <Textarea
              id="guardrail-workflow-domains"
              name="workflowDomains"
              className="mt-3 font-mono text-xs"
              rows={3}
              defaultValue={(own.workflowDomains ?? []).map(workflowDomainLine).join("\n")}
              placeholder="api.cloudflare.com | deploy.yml | production"
            />
            {inheritedWorkflowDomains.length > 0 && (
              <p className="mt-2 text-xs text-faint">
                From the workspace:{" "}
                <span className="font-mono break-words">{inheritedWorkflowDomains.map(workflowDomainLine).join("; ")}</span>
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Commands"
          about={
            <>
              What the agent's harness refuses to run. A refused command is not run; the agent is told why, and
              the run shows it as a step.
            </>
          }
        >
          {view.rules.map((rule) => (
            <TriSelect
              key={rule.id}
              name={`rule:${rule.id}`}
              value={own.rules?.[rule.id]}
              inherited={base.rules[rule.id] ?? true}
              parent={parent}
              labels={["On", "Off"]}
              title={rule.title}
            >
              {rule.about}
            </TriSelect>
          ))}
          <div className="rounded-xl border border-line bg-surface p-4">
            <label htmlFor="guardrail-deny" className="text-sm font-medium">
              Also refuse
            </label>
            <p className="mt-1 text-sm text-muted">
              One rule per line, as <span className="font-mono text-xs">Bash(terraform apply:*)</span>,{" "}
              <span className="font-mono text-xs">Edit(//etc/**)</span> or{" "}
              <span className="font-mono text-xs">WebFetch</span>. Plain text is the start of a shell command.
              {level === "project" && " These add to the workspace's."}
            </p>
            <Textarea
              id="guardrail-deny"
              name="deny"
              className="mt-3 font-mono text-xs"
              rows={4}
              defaultValue={(own.deny ?? []).join("\n")}
              placeholder="Bash(terraform apply:*)"
            />
            {inheritedDeny.length > 0 && (
              <p className="mt-2 text-xs text-faint">
                From the workspace: <span className="font-mono">{inheritedDeny.join(", ")}</span>
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Caps"
          about="How much one run may cost and how long it may take. A run that reaches either is stopped, and its pull request waits for you."
        >
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-start">
            <div className="min-w-0 grow">
              <label htmlFor="guardrail-budget" className="text-sm font-medium">
                Cost per run, in US dollars
              </label>
              <p className="mt-1 text-sm text-muted">
                Empty: as {parent} ({formatCap(base.budgetUsd)}). 0: no cap here. The workspace's spend cap per run, under Billing, applies as well, and a run stops at the lower of the two.
              </p>
            </div>
            <Input
              id="guardrail-budget"
              name="budgetUsd"
              inputMode="decimal"
              className="w-full shrink-0 sm:w-32"
              defaultValue={own.budgetUsd == null ? "" : String(own.budgetUsd)}
              placeholder={base.budgetUsd == null ? "0" : base.budgetUsd.toFixed(2)}
            />
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm font-medium">Time per run, in minutes</p>
            <p className="mt-1 text-sm text-muted">Empty: as {parent}, shown faded.</p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {RUN_KINDS.map((kind) => (
                <label key={kind} className="flex flex-col gap-1 text-xs text-muted">
                  {RUN_KIND_LABEL[kind]}
                  <Input
                    name={`minutes:${kind}`}
                    inputMode="numeric"
                    defaultValue={own.minutes?.[kind] == null ? "" : String(own.minutes[kind])}
                    placeholder={String(base.minutes[kind] ?? "")}
                  />
                </label>
              ))}
            </div>
          </div>
        </Section>
      </fieldset>

      {editable ? (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
          <SubmitButton pending="Saving…" busy={saving}>
            Save guardrails
          </SubmitButton>
          {saved && <span className="text-sm text-muted">Saved. Runs that start from now on get these.</span>}
          <ErrorText>{error}</ErrorText>
          {own.updatedBy && own.updatedAt && !saved && !error && (
            <span className="text-xs text-faint">
              Last changed by <span className="font-mono">{own.updatedBy}</span> <TimeAgo at={own.updatedAt} />
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">
          {level === "workspace"
            ? "Only the workspace's owners can change its defaults."
            : "Only members of the workspace can change a project's guardrails."}
        </p>
      )}
    </Form>
  );
}

/** Minutes since `from`, ticking while the run goes on. */
function useMinutes(from: string | null, to: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!from || to) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [from, to]);
  if (!from) return null;
  return ((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 60000;
}

function Meter({ share, tone }: { share: number | null; tone: string }) {
  if (share == null) return null;
  return (
    <span className="mt-2 block h-1 overflow-hidden rounded-full bg-line" aria-hidden>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/** A run's caps: spent and elapsed against them, and whether one stopped it. */
export function RunCaps({ run, member }: { run: AgentRun; member: boolean }) {
  const active = isActiveRun(run.status);
  const minutes = useMinutes(run.startedAt ?? (active ? run.createdAt : null), run.finishedAt);
  if (run.timeCapMinutes == null && run.budgetUsd == null && !run.halted) return null;
  const cap = run.timeCapMinutes ?? null;
  const timeShare = cap && minutes != null ? Math.min(1, minutes / cap) : null;
  const spent = formatCost(run.costUsd);
  const budget = run.budgetUsd ?? null;
  const costShare = budget && run.costUsd != null ? Math.min(1, run.costUsd / budget) : null;
  return (
    <section className="mt-6 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck size={15} className="text-accent" />
        Guardrails
        {run.halted && (
          <span className="ml-auto rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-normal text-warn">
            {run.halted === "abuse"
              ? "Stopped: unusual CPU use"
              : `Stopped at its ${run.halted === "budget" ? "cost" : "time"} cap`}
          </span>
        )}
      </div>
      <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
        {cap != null && (
          <div>
            <p className="flex items-center gap-1.5 text-muted">
              <Clock size={13} />
              <span className="tabular-nums text-fg" suppressHydrationWarning>
                {minutes == null ? "—" : `${Math.floor(minutes)}m`}
              </span>
              of {cap}m
            </p>
            <Meter share={timeShare} tone={timeShare != null && timeShare > 0.85 ? "bg-warn" : "bg-success"} />
          </div>
        )}
        {member && (
          <div>
            <p className="flex items-center gap-1.5 text-muted">
              <Coins size={13} />
              {spent ? <span className="tabular-nums text-fg">{spent}</span> : <span>Spend</span>}
              of {formatCap(budget)}
            </p>
            <Meter share={costShare} tone={costShare != null && costShare > 0.85 ? "bg-warn" : "bg-success"} />
            {active && !spent && budget != null && (
              <p className="mt-1.5 text-xs text-faint">
                The agent stops itself at the cap. What it spent is reported when the run ends.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
