/**
 * Choosing the checks a branch requires: every name reported on the
 * repository's commits lately, with the events it was reported for, ticked
 * when it is required, and a field for a name nothing has reported yet.
 * Posts each ticked name as `requiredChecks`.
 */
import { Plus, X } from "lucide-react";
import { useState } from "react";

import type { SeenCheck } from "@g1t/contracts";

import { CheckboxOption } from "./ui/checkbox";
import { TimeAgo } from "./ui";

/** The events a workflow reports for that matter to a merge, first. */
const EVENT_ORDER = ["pull_request", "merge_group", "pull_request_target", "push"];

function events(list: string[]): string {
  const sorted = [...list].sort((a, b) => {
    const ia = EVENT_ORDER.indexOf(a);
    const ib = EVENT_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return sorted.join(", ");
}

/** What to say under a name: where it was seen, and whether that is enough to require it. */
function about(seen: SeenCheck | undefined, mergeQueue: boolean) {
  if (!seen) return <>Not reported in the last 30 days. Until something reports it, nothing can merge.</>;
  const onPulls = seen.events.length === 0 || seen.events.some((event) => event.startsWith("pull_request"));
  const onQueue = seen.events.length === 0 || seen.events.includes("merge_group");
  return (
    <>
      {seen.events.length > 0 ? `Reported for ${events(seen.events)}` : "Reported by a tool other than a workflow"} ·{" "}
      <TimeAgo at={seen.lastSeen} />
      {!onPulls && <span className="text-warn"> · not on pull requests, so it would hold every merge</span>}
      {onPulls && mergeQueue && !onQueue && <span className="text-warn"> · not on merge_group, so the queue cannot pass</span>}
    </>
  );
}

export function RequiredChecksPicker({
  required,
  seen,
  mergeQueue,
  disabled,
}: {
  required: string[];
  seen: SeenCheck[];
  mergeQueue: boolean;
  disabled?: boolean;
}) {
  const [added, setAdded] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const known = (name: string, list: string[]) => list.some((other) => other.toLowerCase() === name.toLowerCase());
  // Required ones first, as they are; then the rest seen lately; then what was typed.
  const names = [
    ...required,
    ...seen.map((check) => check.name).filter((name) => !known(name, required)),
    ...added.filter((name) => !known(name, required) && !seen.some((check) => check.name.toLowerCase() === name.toLowerCase())),
  ];
  const add = () => {
    const name = typed.trim();
    if (name && !known(name, names)) setAdded([...added, name]);
    setTyped("");
  };
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-medium">Require status checks to pass before merging</p>
      <p className="mt-1 text-sm text-muted">
        A pull request merges only once each check ticked here has passed on its latest commit: for people and agents
        alike, by hand, by auto-merge and through the queue. A workflow reports a check named after it.
      </p>
      {names.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-3 text-sm text-faint">
          No checks have been reported on this repository in the last 30 days.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-bg">
          {names.map((name) => {
            const seenCheck = seen.find((check) => check.name.toLowerCase() === name.toLowerCase());
            const isAdded = known(name, added) && !known(name, required);
            return (
              <li key={name} className="flex items-start gap-2 px-3 py-2.5">
                <CheckboxOption
                  className="min-w-0 grow"
                  name="requiredChecks"
                  value={name}
                  defaultChecked={known(name, required) || isAdded}
                  disabled={disabled}
                  label={<span className="font-mono text-[0.8125rem]">{name}</span>}
                  description={about(seenCheck, mergeQueue)}
                />
                {isAdded && (
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => setAdded(added.filter((other) => other !== name))}
                    className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg"
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          disabled={disabled}
          maxLength={100}
          placeholder="Another check, by name"
          aria-label="Require another check, by name"
          className="min-w-0 grow rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm placeholder:font-sans placeholder:text-faint focus:border-line-strong focus:outline-none sm:max-w-xs"
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || typed.trim() === ""}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:bg-raised disabled:opacity-50"
        >
          <Plus size={13} />
          Add
        </button>
      </div>
    </div>
  );
}
