import { useRef, useState } from "react";

import type { CommitMessageDefault, MergeMethod, RepoSettings } from "@g1t/contracts";

import { MERGE_METHODS, MESSAGE_CHOICES, METHOD_INFO, PLACEHOLDERS, SAMPLE_PULL, defaultMessage } from "../lib/merge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { CheckboxOption } from "./ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

type Settings = Pick<
  RepoSettings,
  | "allowMergeCommit"
  | "allowSquashMerge"
  | "allowRebaseMerge"
  | "allowFastForward"
  | "defaultMergeMethod"
  | "mergeCommitMessage"
  | "squashCommitMessage"
  | "mergeCommitTemplate"
  | "squashCommitTemplate"
>;

/**
 * Which merge methods pull requests may use, what merge and squash commits
 * say by default, and which method is offered first. Posts `allowMergeCommit`
 * and the rest by their settings' names. At least one method stays on.
 */
export function MergeMethodSettings({ settings, disabled }: { settings: Settings; disabled?: boolean }) {
  const [allowed, setAllowed] = useState<Record<MergeMethod, boolean>>({
    merge: settings.allowMergeCommit,
    squash: settings.allowSquashMerge,
    rebase: settings.allowRebaseMerge,
    fast_forward: settings.allowFastForward,
  });
  const on = MERGE_METHODS.filter((method) => allowed[method]);
  const [chosenDefault, setDefault] = useState<MergeMethod>(settings.defaultMergeMethod);
  // A default that is no longer allowed gives way to the first that is.
  const defaultMethod = on.includes(chosenDefault) ? chosenDefault : (on[0] ?? "merge");
  return (
    <>
      <Card divided className="overflow-hidden">
        {MERGE_METHODS.map((method) => {
          const info = METHOD_INFO[method];
          const last = on.length === 1 && allowed[method];
          return (
            <div key={method} className="space-y-3 p-4">
              <Hint label={last ? "At least one merge method stays on." : null} disabled={last} align="start">
                <CheckboxOption
                  name={info.setting}
                  checked={allowed[method]}
                  disabled={disabled || last}
                  onCheckedChange={(checked) => setAllowed((now) => ({ ...now, [method]: checked === true }))}
                  label={
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      Allow {info.label.toLowerCase()}
                      {defaultMethod === method && on.length > 1 && <Badge tone="accent">Default</Badge>}
                    </span>
                  }
                  description={info.about}
                />
              </Hint>
              {(method === "merge" || method === "squash") && allowed[method] && (
                <MessageDefault
                  method={method}
                  choice={method === "merge" ? settings.mergeCommitMessage : settings.squashCommitMessage}
                  template={method === "merge" ? settings.mergeCommitTemplate : settings.squashCommitTemplate}
                  disabled={disabled}
                />
              )}
            </div>
          );
        })}
      </Card>
      {/* A method whose box is unticked does not post: its template is kept by the action. */}
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <div className="grow">
          <p className="text-sm font-medium">Default merge method</p>
          <p className="mt-1 text-sm text-muted">
            Offered first on the merge button, and used by the API, the CLI and auto-merge when no method is named. A person's last choice in this repository is
            offered to them first.
          </p>
        </div>
        <Select
          name="defaultMergeMethod"
          value={defaultMethod}
          onValueChange={(value) => setDefault(value as MergeMethod)}
          disabled={disabled || on.length < 2}
        >
          <SelectTrigger size="sm" aria-label="Default merge method" className="w-full shrink-0 sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {on.map((method) => (
              <SelectItem key={method} value={method}>
                {METHOD_INFO[method].action}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Card>
    </>
  );
}

/** What a merge or squash commit says unless whoever merges writes it: a choice, or a template. */
function MessageDefault({
  method,
  choice: saved,
  template: savedTemplate,
  disabled,
}: {
  method: "merge" | "squash";
  choice: CommitMessageDefault;
  template: string | null;
  disabled?: boolean;
}) {
  const [choice, setChoice] = useState<CommitMessageDefault>(saved);
  const [template, setTemplate] = useState(savedTemplate ?? "{title} (#{number})\n\n{body}\n\nCloses {items}\n{co_authors}");
  const box = useRef<HTMLTextAreaElement>(null);
  const name = method === "merge" ? "mergeCommit" : "squashCommit";
  const preview = defaultMessage(method, choice, template, SAMPLE_PULL);
  // A placeholder goes in where the cursor is, or at the end.
  const insert = (placeholder: string) => {
    const area = box.current;
    const text = `{${placeholder}}`;
    if (!area) return setTemplate((now) => now + text);
    const start = area.selectionStart ?? template.length;
    const end = area.selectionEnd ?? start;
    const next = template.slice(0, start) + text + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return (
    <div className="ml-6.5 space-y-3">
      <Field>
        <FieldLabel htmlFor={`${name}-message`} className="text-xs text-muted">
          Default commit message
        </FieldLabel>
        <Select name={`${name}Message`} value={choice} onValueChange={(value) => setChoice(value as CommitMessageDefault)} disabled={disabled}>
          <SelectTrigger id={`${name}-message`} size="sm" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MESSAGE_CHOICES[method].map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {choice === "custom" ? (
        <Field>
          <FieldLabel htmlFor={`${name}-template`} className="text-xs text-muted">
            Template
          </FieldLabel>
          <Textarea
            ref={box}
            id={`${name}-template`}
            name={`${name}Template`}
            rows={6}
            maxLength={4000}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            disabled={disabled}
            className="font-mono text-xs"
          />
          <FieldDescription>The first line is the commit's title. Press a placeholder to put it in:</FieldDescription>
          <div className="flex flex-wrap gap-1.5">
            {PLACEHOLDERS.map((placeholder) => (
              <Hint key={placeholder.name} label={placeholder.about}>
                <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => insert(placeholder.name)} className="font-mono">
                  {`{${placeholder.name}}`}
                </Button>
              </Hint>
            ))}
          </div>
        </Field>
      ) : (
        // Kept while another choice is made, so switching back finds it.
        savedTemplate != null && <input type="hidden" name={`${name}Template`} value={savedTemplate} />
      )}
      <div>
        <p className="text-xs text-faint">Preview, for a sample pull request</p>
        <Card tone="bg" radius="lg" className="mt-1.5 px-3 py-2 font-mono text-xs">
          <p className="font-semibold text-fg wrap-break-word">{preview.title || <span className="text-faint">(no title)</span>}</p>
          {preview.message && <p className="mt-2 whitespace-pre-wrap text-muted wrap-break-word">{preview.message}</p>}
        </Card>
      </div>
    </div>
  );
}
