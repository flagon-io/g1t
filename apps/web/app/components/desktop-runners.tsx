import { AppWindow, Laptop, SquareTerminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import type { DesktopBackend, DesktopDiagnosis, DesktopRunner, DesktopUpdate, Runner } from "@g1t/contracts";

import { BACKEND_LABEL, type DesktopRunnerAction, type DesktopRunnerCapability, desktopRunner, jobHref, useDesktopRunner } from "../lib/desktop-runner";
import { EmptyState, TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Progress } from "./ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** A diagnosis's tone, as a dot. */
const DOT: Record<DesktopDiagnosis["tone"], string> = {
  ok: "bg-success",
  working: "bg-info",
  off: "bg-faint",
  warning: "bg-warn",
  problem: "bg-danger",
};

/** A kind of job's tone, as its label's. */
const BADGE: Record<DesktopDiagnosis["tone"], BadgeTone> = {
  ok: "success",
  working: "info",
  off: "neutral",
  warning: "warn",
  problem: "danger",
};

/** Each kind of job's icon: a terminal for Linux jobs, a window for Windows jobs, a laptop for macOS jobs. */
const ICON: Record<string, ReactNode> = {
  linux: <SquareTerminal size={15} aria-hidden />,
  windows: <AppWindow size={15} aria-hidden />,
  macos: <Laptop size={15} aria-hidden />,
};

/** How a kind of job keeps each job from the computer, and what that means. */
const ISOLATION: Record<string, { label: string; hint: string }> = {
  "nested-container": { label: "Fresh container in its VM", hint: "Each job runs in a fresh container inside the runner's own Linux VM, and is removed after." },
  vm: { label: "A VM of its own", hint: "Each job runs in a VM of its own, such as a Windows Sandbox, discarded after." },
};

type Row = {
  machine: string;
  person: string | null;
  backend: DesktopBackend;
  version: string | null;
  diagnosis: DesktopDiagnosis;
  /** This computer's fixes, which only work here. */
  actions: DesktopRunnerAction[];
  /** Sandboxed: each kind of job, Linux and Windows, with how it is (and here, its fixes and Start or Stop). */
  capabilities: DesktopRunnerCapability[];
  /** The kinds of job say it all: the whole runner's line isn't shown as well. */
  inCapabilities: boolean;
  here: boolean;
  reportedAt: string | null;
  /** How its runner's updates stand, while g1t is open there. */
  update: DesktopUpdate | null;
  /** Here only: the app's button that looks for a newer runner now. */
  check: DesktopRunnerAction | null;
};

/** The desktops to list: this computer, live, first; then the others, as their apps last said, or closed. */
export function desktopRows(desktops: DesktopRunner[], here: ReturnType<typeof useDesktopRunner>, slug: string): Row[] {
  const rows: Row[] = [];
  if (here && here.workspace === slug) {
    const capabilities = here.diagnosis.capabilities ?? [];
    rows.push({
      machine: here.machine,
      person: null,
      backend: here.backend,
      version: here.version,
      diagnosis: here.diagnosis,
      actions: here.diagnosis.actions,
      capabilities,
      inCapabilities: !!here.diagnosis.in_capabilities && capabilities.length > 0,
      here: true,
      reportedAt: null,
      update: here.diagnosis.update ?? null,
      check: here.diagnosis.update?.checking ? null : (here.diagnosis.update?.check ?? null),
    });
  }
  for (const desktop of desktops) {
    if (rows.some((row) => row.here && row.machine.toLowerCase() === desktop.machine.toLowerCase())) continue;
    const capabilities = desktop.open ? (desktop.diagnosis.capabilities ?? []).map((c) => ({ ...c, actions: [] })) : [];
    rows.push({
      machine: desktop.machine,
      person: desktop.person,
      backend: desktop.backend,
      version: desktop.version,
      diagnosis: desktop.open ? desktop.diagnosis : desktop.closed,
      actions: [],
      capabilities,
      inCapabilities: desktop.open && !!desktop.diagnosis.in_capabilities && capabilities.length > 0,
      here: false,
      reportedAt: desktop.reportedAt,
      update: desktop.open ? (desktop.diagnosis.update ?? null) : null,
      check: null,
    });
  }
  return rows;
}

/** A diagnosis's fixes, as buttons: they work only on this computer, in the app. */
function Actions({ actions, primary = true }: { actions: DesktopRunnerAction[]; primary?: boolean }) {
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((action, at) => (
        <Button key={action.id} size="xs" variant={primary && at === 0 ? "secondary" : "outline"} onClick={() => void desktopRunner()?.act(action.id).catch(() => {})}>
          {action.label}
        </Button>
      ))}
    </>
  );
}

/** Start or Stop for one kind of job on this computer, which leaves the others as they are. */
function Toggle({ capability }: { capability: DesktopRunnerCapability }) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const on = capability.enabled !== false;
  const waiting = asked !== null && asked !== on;
  return (
    <Button
      size="xs"
      variant={on ? "outline" : "soft"}
      className="ml-auto"
      disabled={waiting}
      aria-label={`${on ? "Stop" : "Start"} ${capability.label}`}
      onClick={() => {
        setAsked(!on);
        void desktopRunner()
          ?.act(on ? "stop" : "start", capability.id)
          .catch(() => setAsked(null));
      }}
    >
      {waiting ? (on ? "Stopping…" : "Starting…") : on ? "Stop" : "Start"}
    </Button>
  );
}

function Detail({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dt className="w-16 shrink-0 text-faint">{term}</dt>
      <dd className="min-w-0 break-words text-fg-soft">{children}</dd>
    </div>
  );
}

/** When the app last looked for a newer runner: the app sends when, and this says how long ago, as "Heard from" does. */
function Checked({ update }: { update: DesktopUpdate | null }) {
  if (!update?.checked_at) return null;
  return (
    <span className="block">
      Checked <TimeAgo at={update.checked_at} />
    </span>
  );
}

/** One kind of job, as a card of its own: its state, what it runs, why it doesn't and the fix, and here its own Start or Stop. */
function KindCard({ capability, here, runners, update }: { capability: DesktopRunnerCapability; here: boolean; runners: Runner[]; update: DesktopUpdate | null }) {
  const href = jobHref(capability, runners);
  const isolation = capability.isolation ? (ISOLATION[capability.isolation] ?? { label: capability.isolation, hint: null }) : null;
  const edge = capability.tone === "problem" ? "border-danger/40" : capability.tone === "warning" ? "border-warn/35" : "";
  const live = capability.state === "busy" || capability.state === "starting" || capability.state === "downloading" || capability.state === "updating";
  const fixes = here ? capability.actions : [];
  const toggle = here && capability.can_toggle;
  return (
    <Card tone="plain" radius="lg" className={`flex min-w-0 flex-col gap-3 p-4 ${edge}`} aria-label={capability.label} role="group">
      <div className="flex items-center gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-lg bg-raised ${capability.enabled === false ? "text-faint" : "text-fg-soft"}`}>
          {ICON[capability.id] ?? ICON.linux}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{capability.label}</p>
          <Badge tone={BADGE[capability.tone]} className="mt-1" role={here ? "status" : undefined}>
            <span className={`size-1.5 rounded-full bg-current ${live ? "motion-safe:animate-pulse" : ""}`} aria-hidden />
            {capability.title}
          </Badge>
        </div>
      </div>
      {capability.about && <p className="text-sm text-muted">{capability.about}</p>}
      {capability.job && (
        <div className="rounded-lg bg-raised px-3 py-2 text-sm">
          <span className="block text-[0.6875rem] font-medium tracking-wide text-muted uppercase">{capability.job.kind === "agent" ? "Agent work" : "Running"}</span>
          {href ? (
            <Link to={href} className="font-medium text-fg underline-offset-4 hover:underline">
              {capability.job.name}
            </Link>
          ) : (
            <span className="font-medium text-fg">{capability.job.name}</span>
          )}
          <span className="text-muted"> in {capability.job.repo}</span>
        </div>
      )}
      {capability.state === "downloading" && typeof capability.progress === "number" && (
        <div className="flex items-center gap-3">
          <Progress value={capability.progress} aria-label={`${capability.label}: the sandbox's image`} className="h-1.5" />
          <span className="w-9 shrink-0 text-right text-xs text-muted tabular-nums">{capability.progress}%</span>
        </div>
      )}
      {(capability.headline || capability.cause || capability.fix) && (
        <div className="space-y-1 text-sm">
          {capability.headline && <p className="font-medium text-fg">{capability.headline}</p>}
          {capability.cause && <p className="text-muted">{capability.cause}</p>}
          {capability.fix && <p className="text-fg-soft">{capability.fix}</p>}
        </div>
      )}
      {(capability.runner || capability.version || isolation) && (
        <dl className="space-y-0.5 border-t border-line pt-2 text-xs">
          {capability.runner && <Detail term="On g1t">{capability.runner}</Detail>}
          {capability.version && <Detail term="Version">g1t-runner {capability.version}</Detail>}
          {(capability.update || (capability.version && update?.checked_at)) && (
            <Detail term="Updates">
              {capability.update && <span className="block text-accent">{capability.update}</span>}
              <Checked update={update} />
            </Detail>
          )}
          {isolation && (
            <Detail term="Isolation">
              {isolation.hint ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">
                      {isolation.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{isolation.hint}</TooltipContent>
                </Tooltip>
              ) : (
                isolation.label
              )}
            </Detail>
          )}
        </dl>
      )}
      {(fixes.length > 0 || toggle) && (
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Actions actions={fixes} primary={capability.tone === "problem" || (capability.tone === "warning" && capability.state !== "waiting")} />
          {toggle && <Toggle key={String(capability.enabled)} capability={capability} />}
        </div>
      )}
    </Card>
  );
}

/**
 * The workspace's desktops: each person's computer with the g1t desktop
 * app, whose runner runs while g1t is open there. What each says, why it
 * isn't running and the fix, is the app's own words (lib/desktop-runner.ts).
 * A sandboxed one's kinds of job, Linux and Windows, are cards of their own:
 * one can run while the other can't, or is stopped; on this computer, each
 * has its own Start or Stop.
 */
export function DesktopRunners({ desktops, slug, runners = [] }: { desktops: DesktopRunner[] | null; slug: string; runners?: Runner[] }) {
  const here = useDesktopRunner();
  if (!desktops) return <p className="text-sm text-muted">The desktops can&apos;t be read right now.</p>;
  const rows = desktopRows(desktops, here, slug);
  if (rows.length === 0) {
    return (
      <EmptyState title="No desktops yet">
        The <Link to="/download" className="underline underline-offset-2">g1t desktop app</Link> runs this workspace&apos;s self-hosted jobs while it&apos;s open, sandboxed, with nothing to set up.
        Open it signed in as an owner of {slug}.
      </EmptyState>
    );
  }
  return (
    <Card asChild divided>
      <ul>
        {rows.map((row) => (
          <li key={row.machine} className="space-y-3 px-4 py-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Laptop size={13} className="text-muted" aria-hidden />
                  <span className="font-medium">{row.machine}</span>
                  {row.here && <Badge tone="accent">This computer</Badge>}
                  <Badge tone={row.backend === "sandboxed" ? "neutral" : "warn"}>{BACKEND_LABEL[row.backend]}</Badge>
                  {row.person && <span className="text-xs text-faint">@{row.person}</span>}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-faint">
                {row.version && <div>g1t-runner {row.version}</div>}
                {/* With no cards to say it, what becomes of a newer runner, and when the app last looked. */}
                {row.capabilities.length === 0 && row.update?.note && <div className="mt-0.5 text-accent">{row.update.note}</div>}
                {row.capabilities.length === 0 && row.update?.checked_at && (
                  <div className="mt-0.5">
                    <Checked update={row.update} />
                  </div>
                )}
                {row.reportedAt && (
                  <div className="mt-0.5">
                    Heard from <TimeAgo at={row.reportedAt} />
                  </div>
                )}
                {row.check && (
                  <div className="mt-2">
                    <Actions actions={[row.check]} primary={false} />
                  </div>
                )}
              </div>
            </div>
            {!row.inCapabilities && (
              <div className="flex items-start gap-3" role={row.here ? "status" : undefined}>
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[row.diagnosis.tone]}`} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm text-fg">{row.diagnosis.title}</p>
                  {row.diagnosis.cause && <p className="mt-0.5 text-sm text-muted">{row.diagnosis.cause}</p>}
                  {row.diagnosis.fix && <p className="mt-0.5 text-sm text-fg-soft">{row.diagnosis.fix}</p>}
                  {row.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Actions actions={row.actions} />
                    </div>
                  )}
                </div>
              </div>
            )}
            {row.capabilities.length > 0 && (
              <div className={`grid gap-3 ${row.capabilities.length > 1 ? "sm:grid-cols-2" : ""}`}>
                {row.capabilities.map((capability) => (
                  <KindCard key={capability.id} capability={capability} here={row.here} runners={runners} update={row.update} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
