/**
 * Guardrails: the form a workspace sets its defaults with and a project its
 * overrides: the network a sandbox may reach, and how long its runs may take.
 */
import { type ReactNode, useState } from "react";
import { Form } from "react-router";

import { type GuardrailSettings, type Guardrails, type GuardrailsView, RUN_KIND_LABEL } from "@g1t/contracts";

import { SANDBOX_RUN_KINDS, tri, workflowDomainLine } from "../lib/guardrails";
import { ErrorText, Input, SubmitButton, TimeAgo } from "./ui";
import { Card } from "./ui/card";
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
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
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
    </Card>
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
          <Card className="p-4">
            <p className="text-sm font-medium">Always allowed</p>
            <p className="mt-1 text-sm text-muted">
              g1t's own hosts, for cloning, pushing and reporting: <Hosts hosts={view.g1tHosts} />
            </p>
          </Card>
          <Card className="p-4">
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
          </Card>
          <Card className="p-4">
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
          </Card>
          <Card className="p-4">
            <label htmlFor="guardrail-workflow-domains" className="text-sm font-medium">
              Workflow-only domains
            </label>
            <p className="mt-1 text-sm text-muted">
              Hosts that only workflow jobs may reach, such as the API a deploy uploads to. One
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
          </Card>
        </Section>

        <Section title="Time limits" about="How long one run may take. A run that reaches it is stopped.">
          <Card className="p-4">
            <p className="text-sm font-medium">Time per run, in minutes</p>
            <p className="mt-1 text-sm text-muted">Empty: as {parent}, shown faded.</p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {SANDBOX_RUN_KINDS.map((kind) => (
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
          </Card>
        </Section>
      </fieldset>

      {editable ? (
        <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
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
