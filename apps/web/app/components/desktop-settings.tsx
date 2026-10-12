import { ExternalLink } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import type { DesktopBackend } from "@g1t/contracts";

import { useBusy } from "../lib/busy";
import { type DesktopRunnerView, desktopRunner, runnerStatusKey } from "../lib/desktop-runner";
import {
  BACKEND_NOTE,
  type DesktopSettings,
  type DesktopSettingsView,
  SECTIONS,
  type SectionId,
  ZOOMS,
  checkFailed,
  desktopSettings,
  hostOf,
  platformWords,
  saveSetting,
  updateLine,
} from "../lib/desktop-settings";
import { cn } from "../lib/cn";
import { ActButton, Actions, DOT, KindCard } from "./desktop-runners";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { SelectField } from "./ui/select";
import { SwitchCard } from "./ui/switch";

/**
 * The desktop app's settings, as a dialog over the site, the way a desktop
 * app's preferences are: its sections down the left, the one chosen on the
 * right, and Escape or the X to close. The app opens it (from the title
 * bar, its menu, the tray, a shortcut or the account menu) through
 * `DesktopApp`, at a section when it names one. Each change is kept the
 * moment it is made, over the settings as the app has them then
 * (lib/desktop-settings.ts); there is nothing to save.
 */
export function DesktopSettingsDialog({
  open,
  section,
  check,
  onOpenChange,
  onSection,
  runner,
}: {
  open: boolean;
  section: SectionId;
  /** Opened by "Check for updates…": it looks as it opens. Changes each time it is asked. */
  check: number;
  onOpenChange: (open: boolean) => void;
  onSection: (section: SectionId) => void;
  runner: DesktopRunnerView | null;
}) {
  const [view, setView] = useState<DesktopSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "That could not be changed."), []);

  // The settings as the app has them, each time it opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    desktopSettings()
      ?.get()
      .then(setView)
      .catch(fail);
  }, [open, fail]);

  /** One change, shown at once and kept over the app's settings as they are now. */
  const change = (patch: Partial<DesktopSettings>) => {
    if (!view) return;
    const before = view;
    setView({ ...view, ...patch });
    setError(null);
    saveSetting(patch).then(setView, (reason: unknown) => {
      setView(before);
      fail(reason);
    });
  };

  const checking = useChecking(view, setView, check);
  // A download finishing in the background, while the settings are open.
  useEffect(() => desktopSettings()?.onUpdateReady((version) => setView((current) => (current ? { ...current, updateReady: version } : current))), []);

  const live = runner ?? view?.runnerView ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(42rem,calc(100dvh-4rem))] max-w-4xl gap-0 overflow-hidden p-0 max-sm:h-[calc(100dvh-2rem)]"
        // Focus goes to the panel, not the first section in the list, which would look chosen.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <nav aria-label="Settings" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-bg/40 p-3 max-sm:w-40">
          <DialogTitle className="px-2 pt-1 pb-3">Settings</DialogTitle>
          {SECTIONS.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              aria-current={section === item.id ? "page" : undefined}
              aria-pressed={section === item.id}
              onClick={() => onSection(item.id)}
            >
              {item.label}
              {item.id === "runner" && live?.chip && <span className={cn("ml-auto size-2 rounded-full", DOT[live.chip.tone])} aria-hidden />}
            </Button>
          ))}
        </nav>
        <div className="@container min-w-0 grow overflow-y-auto overscroll-contain p-6 pr-12">
          <DialogDescription className="sr-only">For the desktop app on this computer. Your account&apos;s settings, notifications included, are on g1t itself.</DialogDescription>
          <h3 className="mb-4 text-base font-semibold tracking-tight">{SECTIONS.find((item) => item.id === section)?.label}</h3>
          {view ? (
            <div className="space-y-2">
              {section === "general" && <General view={view} change={change} setView={setView} fail={fail} />}
              {section === "runner" && <RunnerSection view={view} runner={live} change={change} fail={fail} />}
              {section === "notifications" && <Notifications view={view} change={change} />}
              {section === "window" && <WindowSection view={view} change={change} fail={fail} />}
              {section === "updates" && <Updates view={view} change={change} checking={checking} fail={fail} />}
              {section === "server" && <Server view={view} fail={fail} />}
              {section === "about" && <About view={view} />}
            </div>
          ) : (
            <p className="text-sm text-muted">{error ? null : "Loading…"}</p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Change = (patch: Partial<DesktopSettings>) => void;
type Fail = (reason: unknown) => void;

/** A setting that isn't a switch: its title, what it means, and its control. */
function SettingCard({ title, children, control, id }: { title: ReactNode; children?: ReactNode; control?: ReactNode; id?: string }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 basis-60 grow">
        <p id={id} className="text-sm font-medium text-fg">
          {title}
        </p>
        {children && <div className="mt-1 text-sm text-muted">{children}</div>}
      </div>
      {control && <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>}
    </Card>
  );
}

function General({ view, change, setView, fail }: { view: DesktopSettingsView; change: Change; setView: (view: DesktopSettingsView) => void; fail: Fail }) {
  return (
    <>
      <SwitchCard
        title="Open g1t when you sign in"
        checked={view.openAtLogin}
        onCheckedChange={(on) => {
          const before = view;
          setView({ ...view, openAtLogin: on });
          desktopSettings()
            ?.setOpenAtLogin(on)
            .then(setView, (reason: unknown) => {
              setView(before);
              fail(reason);
            });
        }}
      >
        g1t starts with your computer.
      </SwitchCard>
      {/* Starting in the tray only means something when g1t starts at sign-in. */}
      <SwitchCard title="Start in the tray" checked={view.startHidden} disabled={!view.openAtLogin} onCheckedChange={(on) => change({ startHidden: on })}>
        Opened at sign-in, g1t waits in the tray without opening its window.
      </SwitchCard>
      <SwitchCard title="Keep g1t running when the window closes" checked={view.closeToTray} onCheckedChange={(on) => change({ closeToTray: on })}>
        It stays in the tray for notifications. Turned off, closing the window quits.
      </SwitchCard>
    </>
  );
}

const BACKENDS: { value: DesktopBackend; label: string }[] = [
  { value: "sandboxed", label: "Sandboxed (recommended)" },
  { value: "docker", label: "In Docker" },
  { value: "host", label: "Directly on this computer" },
];

function RunnerSection({ view, runner, change, fail }: { view: DesktopSettingsView; runner: DesktopRunnerView | null; change: Change; fail: Fail }) {
  const backendId = useId();
  const workspaceId = useId();
  // Taking jobs out of the sandbox is chosen in the Runner window, a page
  // of the app's own: no page from the network may do it (src/bridge.rs).
  const [outside, setOutside] = useState(false);
  if (!runner) return <p className="text-sm text-muted">Loading…</p>;
  const backend = runner.backend;
  const note = BACKEND_NOTE[backend] ?? BACKEND_NOTE.sandboxed;
  const workspaces = [...runner.workspaces];
  if (runner.workspace && !workspaces.some((w) => w.slug === runner.workspace)) workspaces.unshift({ slug: runner.workspace, name: null });
  const diagnosis = runner.diagnosis;
  const kinds = diagnosis.capabilities ?? [];
  const cardsSayIt = !!diagnosis.in_capabilities && kinds.length > 0;
  const status = runnerStatusKey(runner);
  return (
    <>
      {!cardsSayIt && (
        <Card className="flex items-start gap-3 p-4" role="status">
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[diagnosis.tone])} aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{diagnosis.title}</p>
            {diagnosis.cause && <p className="mt-0.5 text-sm text-muted">{diagnosis.cause}</p>}
            {diagnosis.fix && <p className="mt-0.5 text-sm text-fg-soft">{diagnosis.fix}</p>}
            {diagnosis.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Actions actions={diagnosis.actions} status={status} onError={fail} />
              </div>
            )}
          </div>
        </Card>
      )}
      {kinds.length > 0 && (
        <div className={cn("grid gap-2", kinds.length > 1 && "@xl:grid-cols-2")}>
          {kinds.map((kind) => (
            <KindCard key={kind.id} capability={kind} here runners={[]} update={diagnosis.update ?? null} view={runner} onError={fail} />
          ))}
        </div>
      )}
      <SwitchCard title="Run jobs on this computer while g1t is open" checked={view.runner} onCheckedChange={(on) => change({ runner: on })}>
        Your workspace&apos;s <code>runs-on: self-hosted</code> jobs, at no cost. Off, nothing runs here until you turn it on again.
      </SwitchCard>
      <SettingCard
        id={backendId}
        title="How jobs run"
        control={
          <SelectField
            aria-labelledby={backendId}
            size="sm"
            className="w-56"
            align="end"
            value={backend}
            options={BACKENDS}
            onValueChange={(chosen) => {
              if (chosen === "sandboxed") {
                setOutside(false);
                change({ runnerBackend: "sandboxed" });
                return;
              }
              setOutside(true);
              void desktopRunner()?.act("runner_window").catch(fail);
            }}
          />
        }
      >
        <span className={note.warn ? "text-warn" : undefined}>{note.text}</span>
        {outside && <span className="mt-1 block text-fg-soft">Jobs outside the sandbox can reach your files, so that is chosen in the Runner window, which has opened.</span>}
      </SettingCard>
      <SettingCard
        id={workspaceId}
        title="Workspace"
        control={
          <SelectField
            aria-labelledby={workspaceId}
            size="sm"
            className="w-56"
            align="end"
            value={runner.workspace ?? ""}
            disabled={workspaces.length === 0}
            placeholder="Open g1t, signed in, to choose"
            options={workspaces.map((w) => ({ value: w.slug, label: w.name ? `${w.name} (${w.slug})` : w.slug }))}
            onValueChange={(slug) => change({ runnerWorkspace: slug || null })}
          />
        }
      >
        The workspace whose jobs it runs. Only a workspace&apos;s owners can add runners to it.
      </SettingCard>
      <SettingCard
        title={`This computer: ${runner.machine}`}
        control={runner.link ? <ActButton action="view_runners" status={status} fail={fail} label="View on g1t" /> : null}
      >
        {[runner.version ? `g1t-runner ${runner.version}` : null, diagnosis.update?.checked].filter(Boolean).join(" · ") || null}
      </SettingCard>
    </>
  );
}

function Notifications({ view, change }: { view: DesktopSettingsView; change: Change }) {
  const words = platformWords(view.platform);
  return (
    <>
      <SwitchCard title="Show notifications" checked={view.notifications} onCheckedChange={(on) => change({ notifications: on })}>
        From your system, for what needs you while g1t is behind another window. Which things notify you is set on g1t.
      </SwitchCard>
      <SwitchCard title={words.flash} checked={view.flash} onCheckedChange={(on) => change({ flash: on })}>
        When a notification arrives and the window is not in front.
      </SwitchCard>
      <SwitchCard title="Show a badge on the icon" checked={view.badge} onCheckedChange={(on) => change({ badge: on })}>
        How many things are waiting for you.
      </SwitchCard>
    </>
  );
}

function WindowSection({ view, change, fail }: { view: DesktopSettingsView; change: Change; fail: Fail }) {
  const words = platformWords(view.platform);
  const zoomId = useId();
  const restart = useBusy(String(view.titleBarChanged), fail);
  return (
    <>
      <SwitchCard title="Use the system's title bar" checked={view.systemTitleBar} onCheckedChange={(on) => change({ systemTitleBar: on })}>
        {words.systemTitleBar}
      </SwitchCard>
      {view.titleBarChanged && (
        <SettingCard
          title="Restart to change the title bar"
          control={
            <Button size="sm" variant="accent" busy={restart.busy} onClick={() => restart.run(() => desktopSettings()?.restart())}>
              Restart now
            </Button>
          }
        >
          g1t opens again where you were.
        </SettingCard>
      )}
      <SettingCard
        id={zoomId}
        title="Zoom"
        control={
          <SelectField
            aria-labelledby={zoomId}
            size="sm"
            className="w-28"
            align="end"
            value={String(ZOOMS.includes(view.zoom) ? view.zoom : 1)}
            options={ZOOMS.map((zoom) => ({ value: String(zoom), label: `${Math.round(zoom * 100)}%` }))}
            onValueChange={(value) => change({ zoom: Number(value) || 1 })}
          />
        }
      >
        {words.zoom}
      </SettingCard>
    </>
  );
}

/** Where a check for updates stands: under way, and what it last said that the view doesn't. */
type Checking = { checking: boolean; said: string | null; look: () => void };

/**
 * Looking for updates, kept by the dialog rather than its Updates section,
 * so a check carries on while another section is shown. `check` changes
 * each time the app asks for one ("Check for updates…" in a menu).
 */
function useChecking(view: DesktopSettingsView | null, setView: (update: (view: DesktopSettingsView | null) => DesktopSettingsView | null) => void, check: number): Checking {
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const handled = useRef(0);
  const look = useCallback(() => {
    const bridge = desktopSettings();
    if (!bridge) return;
    setChecking(true);
    setSaid("Checking, and downloading any new version…");
    bridge
      .checkForUpdates()
      .then(
        (answer) => {
          const ready = answer.startsWith("ready:") ? answer.slice(6) : null;
          setView((current) => (current ? { ...current, updateReady: ready ?? current.updateReady, checkedAt: Date.now() } : current));
          setSaid(null);
        },
        (reason: unknown) => setSaid(checkFailed(reason)),
      )
      .finally(() => setChecking(false));
  }, [setView]);
  // Asked by the app: once the settings are there to say what it finds.
  useEffect(() => {
    if (!view || check <= handled.current) return;
    handled.current = check;
    look();
  }, [view, check, look]);
  return { checking, said, look };
}

function Updates({ view, change, checking, fail }: { view: DesktopSettingsView; change: Change; checking: Checking; fail: Fail }) {
  const restart = useBusy(view.updateReady ?? "", fail);
  const { said, look } = checking;
  return (
    <>
      <SwitchCard title="Download updates by themselves" checked={view.autoUpdate} onCheckedChange={(on) => change({ autoUpdate: on })}>
        Each one installs when you restart or quit g1t, never in the middle of something.
      </SwitchCard>
      <SettingCard
        title={`g1t ${view.version}`}
        control={
          <>
            {view.updateReady && (
              <Button size="sm" variant="accent" busy={restart.busy} onClick={() => restart.run(() => desktopSettings()?.restartToUpdate())}>
                Restart now
              </Button>
            )}
            <Button size="sm" variant="outline" busy={checking.checking} onClick={look}>
              Check for updates
            </Button>
          </>
        }
      >
        <span aria-live="polite">{restart.busy ? "Installing…" : (said ?? updateLine(view))}</span>
      </SettingCard>
    </>
  );
}

function Server({ view, fail }: { view: DesktopSettingsView; fail: Fail }) {
  const { busy, run } = useBusy(view.server, fail);
  return (
    <SettingCard
      title={hostOf(view.server)}
      control={
        <Button size="sm" variant="outline" busy={busy} onClick={() => run(() => desktopSettings()?.changeServer(), false)}>
          Change…
        </Button>
      }
    >
      The g1t this app opens. Change it if you run g1t yourself.
    </SettingCard>
  );
}

function About({ view }: { view: DesktopSettingsView }) {
  const platform = view.platform === "macos" ? "macOS" : view.platform === "windows" ? "Windows" : view.platform === "linux" ? "Linux" : view.platform;
  return (
    <SettingCard
      title={`g1t ${view.version}`}
      control={
        <Button size="sm" variant="outline" asChild>
          <a href="https://docs.g1t.sh/guides/desktop/">
            About the desktop app
            <ExternalLink size={13} aria-hidden />
          </a>
        </Button>
      }
    >
      The desktop app for {platform}, opening {hostOf(view.server)}. Your account&apos;s settings, notifications included, are on g1t itself.
    </SettingCard>
  );
}
