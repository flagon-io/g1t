/**
 * Guardrails: the form a workspace sets its defaults with and a project its
 * overrides: how long its runs may take.
 */
import type { ReactNode } from "react";
import { Form } from "react-router";

import { type GuardrailSettings, type Guardrails, type GuardrailsView, RUN_KIND_LABEL } from "@g1t/contracts";

import { SANDBOX_RUN_KINDS } from "../lib/guardrails";
import { ErrorText, Input, SubmitButton, TimeAgo } from "./ui";
import { Card } from "./ui/card";

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
  return (
    // Keyed to the last change, so after a save the fields show what was kept, as it was tidied.
    <Form key={own.updatedAt ?? "unset"} method="post" className="max-w-4xl space-y-8">
      <fieldset disabled={!editable} className="min-w-0 space-y-8">
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
            : "Only members of the workspace can change a repository's guardrails."}
        </p>
      )}
    </Form>
  );
}
