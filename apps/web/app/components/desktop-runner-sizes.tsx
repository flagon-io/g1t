import { useEffect, useId, useState } from "react";

import { memorySaid } from "@g1t/contracts";

import {
  type DesktopRunnerSize,
  type DesktopRunnerSizes,
  type SizeDraft,
  canSetSizes,
  desktopRunner,
  draftProblem,
  draftsOf,
  isolationWords,
  sizesList,
} from "../lib/desktop-runner";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { CheckboxOption } from "./ui/checkbox";
import { Input } from "./ui/input";

/**
 * The sizes the sandbox's Linux jobs are taken for, in the desktop app's
 * runner settings: a job asking for one of g1t's machines (`ubuntu-latest`)
 * runs here when it is one of these, in a sandbox of exactly that size, or
 * of more where it says so. One is picked when nobody chose (Standard if it
 * fits in half this computer, else Small); the person adds, removes and
 * gives more from there. Shown only by an app and a g1t-runner that can
 * change them.
 */
export function JobSizes({ sizes, isolation, onError }: { sizes: DesktopRunnerSizes; isolation: string | null; onError: (reason: unknown) => void }) {
  const [drafts, setDrafts] = useState<SizeDraft[]>(() => draftsOf(sizes));
  const [saving, setSaving] = useState(false);
  const shownKey = JSON.stringify(draftsOf(sizes));
  // What the launcher says now replaces the drafts once nothing is being changed here.
  useEffect(() => {
    if (!saving) setDrafts(JSON.parse(shownKey) as SizeDraft[]);
  }, [shownKey, saving]);
  const bridge = desktopRunner();
  if (!canSetSizes(bridge)) return null;

  const problems = sizes.choices.map((choice, at) => draftProblem(drafts[at] ?? draftsOf(sizes)[at]!, choice));
  const changed = sizesList(drafts) !== sizesList(draftsOf(sizes));
  const busy = saving || sizes.saving;
  const save = (list: string | null) => {
    setSaving(true);
    bridge
      .setSizes(list)
      .catch(onError)
      .finally(() => setSaving(false));
  };
  const update = (at: number, patch: Partial<SizeDraft>) =>
    setDrafts((current) => current.map((draft, index) => (index === at ? { ...draft, ...patch } : draft)));
  const sandbox = isolationWords(isolation);
  const machine = `${sizes.machine.cpus} CPUs, ${memorySaid(sizes.machine.memory_mib)}`;
  const share = sizes.share ? `${sizes.share.cpus} CPUs, ${memorySaid(sizes.share.memory_mib)}` : null;
  return (
    <Card className="space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-fg">Job sizes</p>
        <p className="mt-1 text-sm text-muted">
          Jobs that ask for one of g1t&apos;s machines, such as <code>ubuntu-latest</code>, run here when their size is ticked, in a sandbox of exactly that
          size, or of more where you give it more.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {sandbox && (
          <>
            <dt className="text-muted">Sandbox</dt>
            <dd className="text-fg-soft">{sandbox}</dd>
          </>
        )}
        <dt className="text-muted">This computer</dt>
        <dd className="text-fg-soft">
          {machine}
          {share && `; the Linux sandbox has ${share}`}
        </dd>
      </dl>
      {sizes.picked && (
        <p className="text-sm text-fg-soft">Chosen for you: {sizes.reason ?? "the size that fits this computer."} Add sizes or give them more below.</p>
      )}
      <ul className="space-y-3">
        {sizes.choices.map((choice, at) => (
          <SizeRow
            key={choice.size}
            choice={choice}
            draft={drafts[at] ?? draftsOf(sizes)[at]!}
            problem={problems[at] ?? null}
            disabled={busy}
            onChange={(patch) => update(at, patch)}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="accent" busy={busy} disabled={!changed || problems.some(Boolean)} onClick={() => save(sizesList(drafts))}>
          Save sizes
        </Button>
        {!sizes.picked && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save(null)}>
            Choose for me
          </Button>
        )}
        <p className="text-xs text-faint" aria-live="polite">
          {busy
            ? "Saving. Linux jobs start again with these after the job they're running, if any."
            : sizes.applies === "restart"
              ? "A change starts Linux jobs again after the job they're running. The runner isn't registered again."
              : "A change counts from the runner's next poll."}
        </p>
      </div>
      {sizes.error && (
        <p role="alert" className="text-sm text-danger">
          {sizes.error}
        </p>
      )}
    </Card>
  );
}

/** One size: ticked or not, what its jobs get beyond it, and what it costs this computer. */
function SizeRow({
  choice,
  draft,
  problem,
  disabled,
  onChange,
}: {
  choice: DesktopRunnerSize;
  draft: SizeDraft;
  problem: string | null;
  disabled: boolean;
  onChange: (patch: Partial<SizeDraft>) => void;
}) {
  const cpusId = useId();
  const memoryId = useId();
  return (
    <li className="space-y-1.5">
      <CheckboxOption
        checked={draft.offered}
        disabled={disabled}
        onCheckedChange={(on) => onChange({ offered: on === true })}
        label={
          <>
            <span className="font-medium">{choice.name}</span> <span className="text-muted">· {choice.spec}</span>
          </>
        }
        description={choice.offered && choice.sandbox !== choice.spec ? `Its jobs get ${choice.sandbox}.` : undefined}
      />
      {draft.offered && (
        <div className="flex flex-wrap items-center gap-2 pl-6.5 text-xs text-muted">
          <label htmlFor={cpusId}>CPUs</label>
          <Input
            id={cpusId}
            type="number"
            inputMode="decimal"
            min={choice.vcpu}
            step="any"
            className="h-7 w-20"
            placeholder={String(choice.vcpu)}
            value={draft.cpus}
            disabled={disabled}
            onChange={(event) => onChange({ cpus: event.target.value })}
          />
          <label htmlFor={memoryId}>Memory (GB)</label>
          <Input
            id={memoryId}
            type="number"
            inputMode="decimal"
            min={choice.memory_mib / 1024}
            step="any"
            className="h-7 w-20"
            placeholder={String(choice.memory_mib / 1024)}
            value={draft.memoryGb}
            disabled={disabled}
            onChange={(event) => onChange({ memoryGb: event.target.value })}
          />
          <span>At least the size&apos;s own; empty is exactly that.</span>
        </div>
      )}
      {problem ? (
        <p role="alert" className="pl-6.5 text-xs text-danger">
          {problem}
        </p>
      ) : (
        choice.warning && <p className="pl-6.5 text-xs text-warn">{choice.warning}</p>
      )}
    </li>
  );
}
