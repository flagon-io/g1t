import { Check, Hand } from "lucide-react";

import type { Lifecycle, Stage } from "@g1t/contracts";

const STEPS = ["Change", "Checks", "Review", "Up to date", "Landing"];

/** Which step a stage is at. A revision is the change being made again. */
const STEP_OF: Record<Exclude<Stage, "needs_you">, number> = {
  working: 0,
  revising: 0,
  checking: 1,
  reviewing: 2,
  catching_up: 3,
  // Its change is made; it is answering another agent.
  answering: 2,
  ready: 4,
  queued: 4,
};

/** A word or two for a stage, for lists. */
export const STAGE_LABEL: Record<Stage, string> = {
  working: "Making the change",
  checking: "Running checks",
  reviewing: "In review",
  revising: "Revising",
  catching_up: "Catching up",
  answering: "Answering an agent",
  queued: "In the merge queue",
  ready: "Ready to merge",
  needs_you: "Needs you",
};

/** Five dots showing how far along a pull request is. */
export function StageDots({ stage }: { stage: Stage }) {
  if (stage === "needs_you") return null;
  const current = STEP_OF[stage];
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {STEPS.map((step, index) => (
        <span
          key={step}
          className={`size-1.5 rounded-full ${
            index < current || stage === "ready"
              ? "bg-accent"
              : index === current
                ? "animate-pulse bg-accent"
                : "bg-line-strong"
          }`}
        />
      ))}
    </span>
  );
}

const TITLE: Record<Stage, string> = {
  working: "g1t is seeing this through",
  checking: "g1t is seeing this through",
  reviewing: "g1t is seeing this through",
  revising: "g1t is seeing this through",
  catching_up: "g1t is seeing this through",
  answering: "g1t is seeing this through",
  queued: "In the merge queue",
  ready: "Ready to merge",
  needs_you: "Needs you",
};

/**
 * Where a pull request made by g1t stands between "assigned" and
 * "ready to merge", and what is happening to it right now.
 */
export function LifecyclePanel({ lifecycle }: { lifecycle: Lifecycle }) {
  const { stage, detail, revisions } = lifecycle;
  if (stage === "needs_you") {
    return (
      <div className="mt-4 rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-sm">
        <p className="flex items-center gap-2.5 font-medium">
          <Hand size={16} className="shrink-0 text-warn" />
          {TITLE[stage]}
        </p>
        <p className="mt-1 text-muted">{detail}</p>
      </div>
    );
  }
  const current = STEP_OF[stage];
  const ready = stage === "ready";
  return (
    <div
      className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
        ready ? "border-accent/40 bg-accent/5" : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium">{TITLE[stage]}</p>
        {revisions > 0 && (
          <p className="text-xs text-faint">
            Revised {revisions === 1 ? "once" : `${revisions} times`}
          </p>
        )}
      </div>
      <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs">
        {STEPS.map((step, index) => {
          const done = index < current || ready;
          const active = index === current && !ready;
          return (
            <li key={step} className="flex items-center gap-2">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={`h-px w-4 sm:w-6 ${done || active ? "bg-accent-dim" : "bg-line"}`}
                />
              )}
              <span
                className={`flex items-center gap-1.5 ${
                  done ? "text-fg" : active ? "font-medium text-accent" : "text-faint"
                }`}
              >
                {done ? (
                  <Check size={13} className="text-accent" />
                ) : (
                  <span
                    className={`size-1.5 rounded-full ${
                      active ? "animate-pulse bg-accent" : "bg-line-strong"
                    }`}
                  />
                )}
                {step}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-muted">{detail}</p>
    </div>
  );
}
