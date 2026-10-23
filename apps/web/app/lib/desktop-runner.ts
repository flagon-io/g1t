/**
 * The runner the desktop app keeps on this computer, from the site's side
 * (apps/desktop/src-tauri/src/runner). The app finds out what to run for,
 * and gets its registration token, through the page:
 *
 * 1. On every page, the page tells the app who is signed in, the
 *    workspaces they own (only owners add runners) and the one they are
 *    in (`offer`). The app answers with the workspace it wants a
 *    registration token for, if any, and asks again later (`onWanted`).
 * 2. For that workspace, the page asks the server for a token
 *    (`POST /-/desktop/runner`, owners only, same origin) and hands it to
 *    the app (`register`), or says why there is none. It is never shown
 *    or kept here.
 * 3. Whenever the runner's state changes, and every few minutes while g1t
 *    is open, the page sends the app's diagnosis to the server
 *    (`report`), so the workspace's Runners page lists every person's
 *    desktop with its state, why and the fix, in the app's own words.
 */
import { useEffect, useState } from "react";

import type {
  DesktopBackend,
  DesktopCapability,
  DesktopCapabilityState,
  DesktopDiagnosis,
  DesktopJob,
  DesktopReport,
  DesktopUpdate,
  Runner,
} from "@g1t/contracts";

import { sandboxRunHref, workflowRunHref } from "./runners.ts";

/**
 * A fix, as a button: its id is the app's (`runner_control`). `waits`: its
 * button stays busy until the runner's status that follows (lib/busy.ts);
 * `confirm`: what the person is asked first. Both are the app's, from its
 * one catalogue of the runner's words (src/runner/diagnosis.rs).
 */
export type DesktopRunnerAction = { id: string; label: string; waits?: boolean; confirm?: string | null };

/** The runner in a few words, as the title bar's dot says it (`diagnosis::Chip`). */
export type DesktopRunnerChip = { tone: DesktopDiagnosis["tone"]; label: string };

/**
 * A kind of job the sandbox runs, with its fixes' buttons
 * (`diagnosis::CapabilityLine` in the app), and what only this computer
 * knows: whether it can start and stop on its own, and how far its
 * image has downloaded.
 */
export type DesktopRunnerCapability = DesktopCapability & {
  actions: DesktopRunnerAction[];
  available?: boolean;
  can_toggle?: boolean;
  progress?: number | null;
  job?: (DesktopJob & { link?: string | null }) | null;
};

/**
 * How the runner's updates stand on this computer (`diagnosis::UpdateLine`
 * in the app): besides what is reported, when it last looked in the app's
 * words, and its button that looks now.
 */
export type DesktopRunnerUpdate = DesktopUpdate & {
  /** `Checked 12 min ago`. */
  checked: string;
  checking: boolean;
  /** "Check for runner updates". */
  check: DesktopRunnerAction;
};

/** What the app says of its runner (`runner::View` in the app). */
export type DesktopRunnerView = {
  diagnosis: Omit<DesktopDiagnosis, "capabilities" | "update"> & {
    actions: DesktopRunnerAction[];
    capabilities?: DesktopRunnerCapability[];
    update?: DesktopRunnerUpdate | null;
  };
  closed: DesktopDiagnosis & { actions: DesktopRunnerAction[] };
  running: boolean;
  version: string | null;
  backend: DesktopBackend;
  workspace: string | null;
  workspaces: { slug: string; name: string | null }[];
  enabled: boolean;
  paused: boolean;
  link: string | null;
  machine: string;
  platform: string;
  log: string[];
  /** Absent from an app older than the dot. */
  chip?: DesktopRunnerChip;
  /**
   * The sandbox's Linux jobs' sizes, as its launcher says them. Absent from an app or a
   * g1t-runner older than sizes: read it with `sizesOf`, never as it is.
   */
  sizes?: unknown;
};

/**
 * The whole runner's status, as far as a button waits on it: a press of
 * Start, Stop, Retry or Check for runner updates is done when any of it
 * changes (lib/busy.ts).
 */
export function runnerStatusKey(view: DesktopRunnerView): string {
  const { diagnosis } = view;
  const update = diagnosis.update;
  return JSON.stringify([
    diagnosis.code,
    diagnosis.tone,
    diagnosis.title,
    diagnosis.cause,
    view.chip?.label,
    view.enabled,
    view.paused,
    update?.checking,
    update?.checked_at,
    update?.ready,
  ]);
}

/** One kind of job's status, with the whole runner's, for its own buttons. */
export function kindStatusKey(kind: DesktopRunnerCapability, view: DesktopRunnerView | null): string {
  return JSON.stringify([view ? runnerStatusKey(view) : null, kind.state, kind.enabled, kind.tone, kind.title, kind.cause]);
}

export type DesktopRunnerOffer = { signedIn: boolean; workspaces: { slug: string; name: string | null }[]; current: string | null };

/** `window.g1tDesktop.runner`, from the app's bridge.js. */
export type DesktopRunnerBridge = {
  status(): Promise<DesktopRunnerView>;
  offer(offer: DesktopRunnerOffer): Promise<string | null>;
  register(answer: { workspace: string; token?: string | null; allowed?: boolean; error?: string | null }): Promise<void>;
  /** A fix, or Start and Stop: of one kind of job alone with its id as `capability`. */
  act(action: string, capability?: string): Promise<void>;
  onWanted(listener: (workspace: string) => void): () => void;
  onStatus(listener: (view: DesktopRunnerView) => void): () => void;
  /**
   * The sizes Linux jobs are taken for: `1-core,2-core:4:16384m` (empty for none), or null to have one
   * picked again. Absent from an app older than sizes: see `canSetSizes`.
   */
  setSizes?: (sizes: string | null) => Promise<void>;
  /** The Linux sandbox's share: whole CPUs and MiB of memory. Absent from an app older than it: see `canSetShare`. */
  setShare?: (cpus: number, memoryMib: number) => Promise<void>;
};

/** The bridge's runner, inside the desktop app (lib/notify-client.ts describes the rest of `window.g1tDesktop`). */
export function desktopRunner(): DesktopRunnerBridge | null {
  if (typeof window === "undefined") return null;
  const runner = window.g1tDesktop?.runner;
  return runner && typeof runner.status === "function" ? runner : null;
}

/**
 * Whether what the app answered is a whole runner view. While it updates
 * its runner, the app has answered without a `diagnosis`, and every
 * screen that read one crashed the page (flagon-io#447); such an answer is
 * passed over, and the last whole one stays.
 */
export function isRunnerView(view: unknown): view is DesktopRunnerView {
  if (!view || typeof view !== "object") return false;
  const { diagnosis, closed, log } = view as Partial<DesktopRunnerView>;
  return !!diagnosis && typeof diagnosis === "object" && !!closed && typeof closed === "object" && Array.isArray(log);
}

/** This computer's runner, live, inside the desktop app; null elsewhere. */
export function useDesktopRunner(): DesktopRunnerView | null {
  const [view, setView] = useState<DesktopRunnerView | null>(null);
  useEffect(() => {
    const runner = desktopRunner();
    if (!runner) return;
    let live = true;
    runner
      .status()
      .then((first) => {
        if (live && isRunnerView(first)) setView(first);
      })
      .catch(() => {});
    const stop = runner.onStatus((next) => {
      if (isRunnerView(next)) setView(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return view;
}

/** How often a desktop says it is still open, with nothing new: within the server's ten minutes. */
export const HEARTBEAT_MS = 4 * 60 * 1000;

/** A kind of job as the server keeps it: what it says, without what only works or changes on that computer. */
function plainCapability(capability: DesktopCapability): DesktopCapability {
  const { id, label, tone, title, cause, fix, state, headline, about, enabled, job, runner, isolation, version, update } = capability;
  const said: DesktopCapability = { id, label, tone, title, cause: cause ?? null, fix: fix ?? null };
  if (state) said.state = state;
  if (headline) said.headline = headline;
  if (about) said.about = about;
  if (typeof enabled === "boolean") said.enabled = enabled;
  if (job) said.job = { kind: job.kind, name: job.name, repo: job.repo };
  if (runner) said.runner = runner;
  if (isolation) said.isolation = isolation;
  if (version) said.version = version;
  if (update) said.update = update;
  return said;
}

/** How the updates stand, as the server keeps it: without what only this computer's settings show. */
function plainUpdate(update: DesktopUpdate | null | undefined): DesktopUpdate | null {
  if (!update) return null;
  return { checked_at: update.checked_at ?? null, ready: update.ready ?? null, note: update.note ?? null };
}

/** What goes to the server, without the buttons, which only work on that computer. */
export function reportOf(view: DesktopRunnerView): DesktopReport | null {
  if (!view.workspace) return null;
  const plain = ({ code, tone, title, cause, fix, capabilities, in_capabilities, update }: DesktopDiagnosis): DesktopDiagnosis => {
    const said: DesktopDiagnosis = { code, tone, title, cause, fix };
    if (capabilities?.length) {
      said.capabilities = capabilities.map(plainCapability);
      if (in_capabilities) said.in_capabilities = true;
    }
    const updates = plainUpdate(update);
    if (updates) said.update = updates;
    return said;
  };
  return {
    workspace: view.workspace,
    machine: view.machine,
    backend: view.backend,
    version: view.version,
    diagnosis: plain(view.diagnosis),
    closed: plain(view.closed),
  };
}

/** Whether a report is due: something the Runners page shows changed, or the heartbeat. */
export function reportDue(last: { key: string; at: number } | null, report: DesktopReport, now: number): boolean {
  if (!last) return true;
  return last.key !== reportKey(report) || now - last.at >= HEARTBEAT_MS;
}

export function reportKey(report: DesktopReport): string {
  const { diagnosis } = report;
  const capabilities = (diagnosis.capabilities ?? []).map((c) =>
    [c.id, c.tone, c.title, c.cause, c.fix, c.state, c.enabled, c.headline, c.job?.name, c.job?.repo, c.version, c.update].join("\u0001"),
  );
  const update = diagnosis.update ? [diagnosis.update.checked_at, diagnosis.update.ready, diagnosis.update.note].join("\u0001") : "";
  return [
    report.workspace,
    report.machine,
    report.backend,
    report.version,
    diagnosis.code,
    diagnosis.title,
    diagnosis.cause,
    diagnosis.fix,
    diagnosis.in_capabilities,
    update,
    ...capabilities,
  ].join("\u0000");
}

/** A string with something in it, or null. */
export const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const BACKENDS: DesktopBackend[] = ["sandboxed", "docker", "host"];
const TONES: DesktopDiagnosis["tone"][] = ["ok", "working", "off", "warning", "problem"];
const STATES: DesktopCapabilityState[] = ["busy", "idle", "starting", "downloading", "updating", "waiting", "stopped", "unavailable", "problem"];

export function backendOf(value: unknown): DesktopBackend | null {
  return BACKENDS.find((backend) => backend === value) ?? null;
}

/** A diagnosis as the app sent it, or null when it is not one. */
export function diagnosisOf(value: unknown): DesktopDiagnosis | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const code = text(given.code);
  const title = text(given.title);
  const tone = TONES.find((t) => t === given.tone);
  if (!code || !title || !tone) return null;
  const said: DesktopDiagnosis = { code, tone, title, cause: text(given.cause), fix: text(given.fix) };
  const capabilities = Array.isArray(given.capabilities)
    ? given.capabilities
        .map(capabilityOf)
        .filter((c): c is DesktopCapability => c !== null)
        .slice(0, MAX_CAPABILITIES)
    : [];
  if (capabilities.length > 0) {
    said.capabilities = capabilities;
    if (given.in_capabilities === true) said.in_capabilities = true;
  }
  const update = updateOf(given.update);
  if (update) said.update = update;
  return said;
}

/** How the updates stand, as the app sent it, or null when it says nothing. */
function updateOf(value: unknown): DesktopUpdate | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const checkedAt = text(given.checked_at);
  const update: DesktopUpdate = {
    checked_at: checkedAt && !Number.isNaN(Date.parse(checkedAt)) ? checkedAt : null,
    ready: text(given.ready),
    note: text(given.note),
  };
  return update.checked_at || update.ready || update.note ? update : null;
}

/** The most kinds of job a desktop reports (the server keeps as many). */
const MAX_CAPABILITIES = 4;

/** A kind of job as the app sent it, or null when it is not one. */
function capabilityOf(value: unknown): DesktopCapability | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const id = text(given.id);
  const label = text(given.label);
  const title = text(given.title);
  const tone = TONES.find((t) => t === given.tone);
  if (!id || !label || !title || !tone) return null;
  const said: DesktopCapability = { id, label, tone, title, cause: text(given.cause), fix: text(given.fix) };
  const state = STATES.find((s) => s === given.state);
  if (state) said.state = state;
  for (const key of ["headline", "about", "runner", "isolation", "version", "update"] as const) {
    const value = text(given[key]);
    if (value) said[key] = value;
  }
  if (typeof given.enabled === "boolean") said.enabled = given.enabled;
  const job = given.job && typeof given.job === "object" ? (given.job as Record<string, unknown>) : null;
  const [kind, name, repo] = [text(job?.kind), text(job?.name), text(job?.repo)];
  if (kind && name && repo) said.job = { kind, name, repo };
  return said;
}

/**
 * Where a kind of job's current work is on g1t: its run, from the runner
 * it is (by its name, `build-box-linux`), else its repository's runs.
 */
export function jobHref(capability: Pick<DesktopCapability, "job" | "runner">, runners: Pick<Runner, "name" | "work">[]): string | null {
  const job = capability.job;
  if (!job) return null;
  const work = capability.runner ? runners.find((runner) => runner.name === capability.runner)?.work : null;
  if (work?.runId && work.repo) return work.kind === "workflow" ? workflowRunHref(work.repo, work.runId) : sandboxRunHref(work.repo);
  return job.kind === "agent" ? sandboxRunHref(job.repo) : `/${job.repo}/actions`;
}

/** The words for how a desktop runs jobs, as its settings say them. */
export const BACKEND_LABEL: Record<DesktopBackend, string> = {
  sandboxed: "Sandboxed",
  docker: "In Docker (not a sandbox)",
  host: "Directly on the computer (not a sandbox)",
};

/** What the sandbox's Linux jobs take, as its launcher says it (`sizes::SizesView` in g1t-runner). */
export type DesktopRunnerSizes = {
  /** When a change counts: `restart` (after the job Linux jobs are running) or `poll`. */
  applies: string;
  /** This computer's CPUs and memory, and the sandbox's share of them. */
  machine: { cpus: number; memory_mib: number };
  share: { cpus: number; memory_mib: number } | null;
  /** Chosen for the person, not by them, and why. */
  picked: boolean;
  reason: string | null;
  choices: DesktopRunnerSize[];
  /** The most the share can be where the launcher can tell (the Linux VM's, on Windows). */
  limit: { cpus: number; memory_mib: number } | null;
  /** What the share costs this computer, when it may hurt. Never a refusal. */
  shareWarning: string | null;
  /** The launcher can change the share; one before it can't, and the share is only shown. */
  shareSettable: boolean;
  /** A change is under way, or why the last one failed (the app's). */
  saving: boolean;
  error: string | null;
};

/** One of g1t's machines as a size the sandbox's Linux jobs take, or could. */
export type DesktopRunnerSize = {
  /** `2-core`. */
  size: string;
  /** `Standard`. */
  name: string;
  /** `2 vCPU · 8 GB`: the size, and the least a job of it gets. */
  spec: string;
  vcpu: number;
  memory_mib: number;
  /** The least memory its jobs run with where the sandbox has less than the size. */
  least_memory_mib: number;
  offered: boolean;
  given_cpus: number | null;
  given_memory_mib: number | null;
  /** What a job taken for it gets: `4 vCPU · 16 GB`. */
  sandbox: string;
  /** What offering it costs this computer, when it may hurt. Never a refusal. */
  warning: string | null;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function roomOf(value: unknown): { cpus: number; memory_mib: number } | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const cpus = num(given.cpus);
  const memory = num(given.memory_mib);
  return cpus !== null && memory !== null ? { cpus, memory_mib: memory } : null;
}

function sizeOf(value: unknown): DesktopRunnerSize | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const [size, name, spec, sandbox] = [text(given.size), text(given.name), text(given.spec), text(given.sandbox)];
  const [vcpu, memory] = [num(given.vcpu), num(given.memory_mib)];
  if (!size || !name || !spec || vcpu === null || memory === null) return null;
  return {
    size,
    name,
    spec,
    vcpu,
    memory_mib: memory,
    least_memory_mib: num(given.least_memory_mib) ?? memory,
    offered: given.offered === true,
    given_cpus: num(given.given_cpus),
    given_memory_mib: num(given.given_memory_mib),
    sandbox: sandbox ?? spec,
    warning: text(given.warning),
  };
}

/** The sizes in a runner view, or null when it has none it can say (an older app or g1t-runner) or they don't read. */
export function sizesOf(value: unknown): DesktopRunnerSizes | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const machine = roomOf(given.machine);
  const choices = Array.isArray(given.choices) ? given.choices.map(sizeOf).filter((c): c is DesktopRunnerSize => c !== null) : [];
  if (!machine || choices.length === 0) return null;
  return {
    applies: text(given.applies) ?? "restart",
    machine,
    share: roomOf(given.share),
    picked: given.picked === true,
    reason: text(given.reason),
    choices,
    limit: roomOf(given.limit),
    shareWarning: text(given.share_warning),
    shareSettable: given.share_settable === true,
    saving: given.saving === true,
    error: text(given.error),
  };
}

/** Whether this app can change the sizes: one older than them has no `setSizes`, and shows none. */
export function canSetSizes(bridge: DesktopRunnerBridge | null): bridge is DesktopRunnerBridge & { setSizes: (sizes: string | null) => Promise<void> } {
  return !!bridge && typeof bridge.setSizes === "function";
}

/** Whether this app can change the sandbox's share: one older than it has no `setShare`. */
export function canSetShare(
  bridge: DesktopRunnerBridge | null,
): bridge is DesktopRunnerBridge & { setShare: (cpus: number, memoryMib: number) => Promise<void> } {
  return !!bridge && typeof bridge.setShare === "function";
}

/** The share as it is being typed: CPUs and GB. */
export type ShareDraft = { cpus: string; memoryGb: string };

/** The draft the share starts from: what it is now. */
export function shareDraftOf(share: { cpus: number; memory_mib: number }): ShareDraft {
  return { cpus: String(share.cpus), memoryGb: String(Math.round((share.memory_mib / 1024) * 100) / 100) };
}

/**
 * The share a draft sets, as the launcher takes it (whole CPUs, MiB), or why it can't: at least one
 * CPU and 1 GB, and no more CPUs than the computer (or its Linux VM) has. More memory than that, or
 * more than half the computer, only warns.
 */
export function shareOf(draft: ShareDraft, limit: { cpus: number }): { cpus: number; memoryMib: number } | string {
  const cpus = Number(draft.cpus);
  if (!Number.isInteger(cpus) || cpus < 1) return "CPUs are a whole number, 1 or more.";
  if (cpus > limit.cpus) return `At most ${limit.cpus} CPUs here.`;
  const gb = Number(draft.memoryGb);
  if (!Number.isFinite(gb) || gb < 1) return "Memory is 1 GB or more.";
  return { cpus, memoryMib: Math.round(gb * 1024) };
}

/** A size as it is being chosen: taken or not, and what its jobs get beyond it, as typed (empty for the size's own). */
export type SizeDraft = { size: string; offered: boolean; cpus: string; memoryGb: string };

/** The drafts the sizes start from: what is taken now. */
export function draftsOf(sizes: DesktopRunnerSizes): SizeDraft[] {
  return sizes.choices.map((choice) => ({
    size: choice.size,
    offered: choice.offered,
    cpus: choice.given_cpus !== null ? String(choice.given_cpus) : "",
    memoryGb: choice.given_memory_mib !== null ? String(Math.round((choice.given_memory_mib / 1024) * 100) / 100) : "",
  }));
}

/**
 * What a draft gives a job beyond its size, or why it can't: a job never gets less than it asked
 * for, so CPUs and memory are at least the size's (the launcher refuses less too).
 */
export function draftProblem(draft: SizeDraft, choice: DesktopRunnerSize): string | null {
  if (!draft.offered) return null;
  if (draft.cpus.trim()) {
    const cpus = Number(draft.cpus);
    if (!Number.isFinite(cpus) || cpus < choice.vcpu) return `${choice.name} jobs get at least ${choice.vcpu} vCPU.`;
  }
  if (draft.memoryGb.trim()) {
    const gb = Number(draft.memoryGb);
    if (!Number.isFinite(gb) || gb * 1024 < choice.least_memory_mib) return `${choice.name} jobs get at least ${choice.least_memory_mib / 1024} GB.`;
  }
  return null;
}

/** The launcher's list for the taken drafts: `1-core,2-core:4:16384m`; empty for none. */
export function sizesList(drafts: SizeDraft[]): string {
  return drafts
    .filter((draft) => draft.offered)
    .map((draft) => {
      const cpus = draft.cpus.trim() ? String(Number(draft.cpus)) : "";
      const memory = draft.memoryGb.trim() ? `${Math.round(Number(draft.memoryGb) * 1024)}m` : "";
      return cpus || memory ? `${draft.size}:${cpus}${memory ? `:${memory}` : ""}` : draft.size;
    })
    .join(",");
}

/** How the sandbox keeps a job from this computer, in plain words, by its isolation. */
export function isolationWords(isolation: string | null | undefined): string | null {
  switch (isolation) {
    case "nested-container":
      return "Nested container: each job in a fresh container inside the runner's own sandbox, removed after.";
    case "vm":
      return "VM: each job in a throwaway virtual machine of its own.";
    case "container":
      return "Container: each job in a container on a Docker it shares with this computer.";
    case "host":
      return "Host: jobs run directly on this computer, with no sandbox.";
    default:
      return null;
  }
}
