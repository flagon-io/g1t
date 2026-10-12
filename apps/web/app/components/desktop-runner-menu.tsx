import { Settings2 } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useBusy } from "../lib/busy";
import { BACKEND_LABEL, type DesktopRunnerCapability, type DesktopRunnerView, desktopRunner, jobHref, kindStatusKey, runnerStatusKey } from "../lib/desktop-runner";
import { cn } from "../lib/cn";
import { ActButton, Actions, BADGE, DOT, ICON, Toggle } from "./desktop-runners";
import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Progress } from "./ui/progress";
import { Separator } from "./ui/separator";

/** How many of the log's last lines the menu shows. */
const LOG_LINES = 6;

/**
 * The runner's menu, hanging under its dot in the desktop app's title bar,
 * beside the settings button: what the runner is doing, the whole
 * runner's line when it needs the person, each kind of job with the job it
 * runs and its own Start or Stop, Start or Stop for the whole runner, its
 * updates, the last of its log, and the way to its settings. The title bar
 * is a page of its own above this one, so the menu is drawn here, anchored
 * at `at` (where the dot is, as a share of the window's width) along the
 * top edge. Escape, a click outside, or the dot again closes it.
 */
export function DesktopRunnerMenu({
  open,
  at,
  runner,
  onOpenChange,
  onSettings,
}: {
  open: boolean;
  /** Where the dot's right edge is across the window, 0 to 1. */
  at: number;
  runner: DesktopRunnerView | null;
  onOpenChange: (open: boolean) => void;
  /** "Runner settings…": the settings dialog at its Runner section. */
  onSettings: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "That didn't work."), []);
  return (
    <Popover
      open={open && runner !== null}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      {/* The dot is in the title bar, above this page: the menu hangs from the top edge under it. */}
      <PopoverAnchor asChild>
        <span aria-hidden className="pointer-events-none fixed top-0 size-0" style={{ left: `${at * 100}%` }} />
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={4}
        aria-label="Runner"
        // Focus goes to the menu itself, so Escape and Tab work, without a button looking chosen.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="w-92 max-h-[calc(var(--radix-popover-content-available-height)-0.5rem)] overflow-y-auto p-0"
      >
        {runner && <MenuBody runner={runner} fail={fail} onSettings={onSettings} />}
        {error && (
          <p role="alert" className="border-t border-line px-4 py-2.5 text-xs text-danger">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuBody({ runner, fail, onSettings }: { runner: DesktopRunnerView; fail: (reason: unknown) => void; onSettings: () => void }) {
  const status = runnerStatusKey(runner);
  const diagnosis = runner.diagnosis;
  const kinds = diagnosis.capabilities ?? [];
  const chip = runner.chip ?? { tone: diagnosis.tone, label: diagnosis.title };
  // The whole runner's line, when the kinds of job don't already say it all.
  const line = !(diagnosis.in_capabilities && kinds.length > 0);
  const on = runner.enabled && !runner.paused;
  const engine = useBusy(status, fail);
  const update = diagnosis.update ?? null;
  const log = runner.log.slice(-LOG_LINES);
  const working = chip.tone === "working";
  return (
    <>
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <span className={cn("size-2.5 shrink-0 rounded-full", DOT[chip.tone], working && "motion-safe:animate-pulse")} aria-hidden />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium text-fg" role="status">
            {chip.label}
          </p>
          <p className="truncate text-xs text-muted">
            {[BACKEND_LABEL[runner.backend], runner.workspace ? `for ${runner.workspace}` : null, runner.version ? `g1t-runner ${runner.version}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Button
          size="xs"
          variant={on ? "outline" : "soft"}
          busy={engine.busy}
          aria-label={on ? "Stop the runner" : "Start the runner"}
          onClick={() => engine.run(() => desktopRunner()?.act(on ? "stop" : "start"))}
        >
          {on ? "Stop" : "Start"}
        </Button>
      </div>

      {line && (
        <div className="space-y-1 border-t border-line px-4 py-3 text-sm">
          <p className="font-medium text-fg">{diagnosis.title}</p>
          {diagnosis.cause && <p className="text-muted">{diagnosis.cause}</p>}
          {diagnosis.fix && <p className="text-fg-soft">{diagnosis.fix}</p>}
          {diagnosis.actions.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1.5">
              <Actions actions={diagnosis.actions} status={status} onError={fail} />
            </div>
          )}
        </div>
      )}

      {kinds.length > 0 && (
        <ul className="divide-y divide-line border-t border-line" aria-label="Kinds of job this computer runs">
          {kinds.map((kind) => (
            <KindRow key={kind.id} kind={kind} runner={runner} fail={fail} />
          ))}
        </ul>
      )}

      {update && (
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
          <p className="min-w-0 grow text-xs text-muted">
            {update.note ? <span className="block text-accent">{update.note}</span> : null}
            {update.checked_at ? (
              <>
                Checked <TimeAgo at={update.checked_at} />
              </>
            ) : (
              update.checked
            )}
          </p>
          <Actions actions={[update.check]} primary={false} status={status} working={update.checking} onError={fail} />
        </div>
      )}

      <div className="border-t border-line px-4 py-3">
        <LogTail lines={log} />
        <div className="mt-2 flex justify-end">
          <ActButton action="view_log" label="Open the whole log" status={status} fail={fail} />
        </div>
      </div>

      <Separator />
      <div className="p-1.5">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onSettings}>
          <Settings2 size={15} aria-hidden />
          Runner settings…
        </Button>
      </div>
    </>
  );
}

/** The log's last lines, kept scrolled to the newest unless scrolled back to read. */
function LogTail({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const pre = box.current;
    if (pre && following.current) pre.scrollTop = pre.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={box}
      tabIndex={0}
      aria-label="The runner's recent log"
      onScroll={(event) => {
        const pre = event.currentTarget;
        following.current = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      }}
      className="max-h-32 overflow-auto rounded-md bg-bg px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap wrap-break-word text-muted"
    >
      {lines.length ? lines.join("\n") : "Nothing yet."}
    </pre>
  );
}

/** One kind of job, in a line: its state, the job it runs, a newer runner waiting, its fixes, and its own Start or Stop. */
function KindRow({ kind, runner, fail }: { kind: DesktopRunnerCapability; runner: DesktopRunnerView; fail: (reason: unknown) => void }) {
  const status = kindStatusKey(kind, runner);
  const href = jobHref(kind, []);
  const live = kind.state === "busy" || kind.state === "starting" || kind.state === "downloading" || kind.state === "updating";
  const urgent = kind.tone === "problem" || (kind.tone === "warning" && kind.state !== "waiting");
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-raised", kind.enabled === false ? "text-faint" : "text-fg-soft")}>{ICON[kind.id] ?? ICON.linux}</span>
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium text-fg">{kind.label}</p>
          <Badge tone={BADGE[kind.tone]} role="status">
            <span className={cn("size-1.5 rounded-full bg-current", live && "motion-safe:animate-pulse")} aria-hidden />
            {kind.title}
          </Badge>
        </div>
        {kind.can_toggle && <Toggle capability={kind} status={status} onError={fail} />}
      </div>
      {kind.job && (
        <p className="truncate pl-9.5 text-xs text-muted">
          Running{" "}
          {href ? (
            <Link to={href} className="font-medium text-fg underline-offset-4 hover:underline">
              {kind.job.name}
            </Link>
          ) : (
            <span className="font-medium text-fg">{kind.job.name}</span>
          )}{" "}
          in {kind.job.repo}
        </p>
      )}
      {kind.state === "downloading" && typeof kind.progress === "number" && (
        <div className="flex items-center gap-2 pl-9.5">
          <Progress value={kind.progress} aria-label={`${kind.label}: the sandbox's image`} className="h-1" />
          <span className="w-8 shrink-0 text-right text-[0.6875rem] text-muted tabular-nums">{kind.progress}%</span>
        </div>
      )}
      {(kind.cause || kind.fix) && kind.tone !== "ok" && (
        <div className="space-y-0.5 pl-9.5 text-xs">
          {kind.cause && <p className="text-muted">{kind.cause}</p>}
          {kind.fix && <p className="text-fg-soft">{kind.fix}</p>}
        </div>
      )}
      {kind.update && <p className="pl-9.5 text-xs text-accent">{kind.update}</p>}
      {kind.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-9.5">
          <Actions actions={kind.actions} primary={urgent} status={status} onError={fail} />
        </div>
      )}
    </li>
  );
}
