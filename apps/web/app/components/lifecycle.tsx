import { Hand, Loader } from "lucide-react";

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
 * Where a pull request made by g1t stands while g1t is still seeing it
 * through: the step it is on, as a five-part bar, and what is happening now.
 * Once it is ready or queued the merge box says so, and this steps aside.
 */
export function LifecyclePanel({ lifecycle }: { lifecycle: Lifecycle }) {
  const { stage, detail, revisions } = lifecycle;
  if (stage === "ready" || stage === "queued") return null;
  if (stage === "needs_you") {
    return (
      <div className="mt-4 flex gap-3 rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-sm">
        <Hand size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="font-medium">{TITLE[stage]}</p>
          <p className="mt-0.5 text-muted">{detail}</p>
        </div>
      </div>
    );
  }
  const current = STEP_OF[stage];
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm">
      <div className="flex items-center gap-2.5">
        <Loader size={15} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
        <p className="font-medium">
          {STAGE_LABEL[stage]}
          <span className="font-normal text-faint"> · step {current + 1} of {STEPS.length}</span>
        </p>
        {revisions > 0 && (
          <span className="ml-auto text-xs text-faint">Revised {revisions === 1 ? "once" : `${revisions} times`}</span>
        )}
      </div>
      <ol className="mt-3 grid grid-cols-5 gap-1.5" aria-label="Steps">
        {STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step} aria-current={active ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={`block h-1 rounded-full ${
                  done ? "bg-accent" : active ? "animate-pulse bg-accent/60 motion-reduce:animate-none" : "bg-line"
                }`}
              />
              <span className={`mt-1.5 block truncate text-[0.6875rem] ${active ? "font-medium text-fg" : done ? "text-muted" : "text-faint"}`}>
                {step}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2.5 text-muted">{detail}</p>
    </div>
  );
}
