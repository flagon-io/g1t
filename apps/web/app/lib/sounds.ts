/**
 * The sound layer: named cues (`message`, `direct`, `mention`,
 * `agent_done`, `sent`, and `call`, reserved), the person's sound settings
 * as the page knows them, and a `SoundPort` that plays a cue.
 *
 * The default port is Web Audio: each cue of a set is rendered once from
 * lib/sound-synth.ts into an AudioBuffer and reused, nothing is downloaded,
 * and the context is made and resumed on the first click or key (browsers
 * allow sound only after a gesture), so a cue that arrives before anyone
 * has touched the page is kept as a note in the log, not an error. Nothing
 * here throws: a browser with no audio plays nothing.
 *
 * The port is one interface on purpose: the desktop app (Tauri, loading
 * this same web code) swaps in a native implementation with
 * `setSoundPort`, so cues play through the system mixer and respect the
 * system's own do-not-disturb, and nothing else in the app changes. Which
 * cue plays when is lib/chat-sounds.ts; lib/sound-events.ts runs it.
 */
import { useSyncExternalStore } from "react";

import { DEFAULT_SOUND_SETTINGS, type SoundCue, type SoundSet, type SoundSettings, type SoundSettingsChange } from "@g1t/contracts/sounds";

import { cueSpec, renderCue, volumeGain } from "./sound-synth";

// ── The port ─────────────────────────────────────────────────────────────

/** Where a cue goes to be heard. One implementation at a time (`setSoundPort`). */
export interface SoundPort {
  /** Whether a sound could be heard now: audio is there and has been allowed. */
  canPlay(): boolean;
  /** Plays a cue from a set at a volume (0–100). Never throws. */
  play(cue: SoundCue, set: SoundSet, volume: number): void;
  /** The same, from the settings page: a set the person is choosing, now, whatever is on screen. */
  preview(cue: SoundCue, set: SoundSet, volume: number): void;
}

/** Web Audio: the browser's own, used unless the desktop app installs its port. */
export class WebAudioPort implements SoundPort {
  private context: AudioContext | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();

  /** The context, made on first use; null where the browser has none. */
  private audio(): AudioContext | null {
    if (this.context) return this.context;
    try {
      if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
      this.context = new AudioContext();
    } catch {
      return null;
    }
    return this.context;
  }

  /** Makes the context and resumes it: called from a user gesture, so the browser allows it. */
  unlock(): void {
    const context = this.audio();
    if (context && context.state === "suspended") void context.resume().catch(() => {});
  }

  canPlay(): boolean {
    const context = this.audio();
    return !!context && context.state === "running";
  }

  private buffer(context: AudioContext, cue: SoundCue, set: SoundSet): AudioBuffer {
    const key = `${set}:${cue}:${context.sampleRate}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      const samples = renderCue(cueSpec(set, cue), context.sampleRate);
      buffer = context.createBuffer(1, Math.max(1, samples.length), context.sampleRate);
      buffer.copyToChannel(samples, 0);
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  play(cue: SoundCue, set: SoundSet, volume: number): void {
    try {
      const context = this.audio();
      if (!context) return;
      if (context.state === "suspended") void context.resume().catch(() => {});
      const source = context.createBufferSource();
      source.buffer = this.buffer(context, cue, set);
      const gain = context.createGain();
      gain.gain.value = volumeGain(volume);
      source.connect(gain).connect(context.destination);
      source.start();
    } catch {
      // No audio here: nothing lost.
    }
  }

  preview(cue: SoundCue, set: SoundSet, volume: number): void {
    this.unlock();
    this.play(cue, set, volume);
  }
}

let port: SoundPort = new WebAudioPort();

/** Installs another way to play cues (the desktop app's native one). Returns the one it replaced. */
export function setSoundPort(next: SoundPort): SoundPort {
  const before = port;
  port = next;
  return before;
}

export function soundPort(): SoundPort {
  return port;
}

// ── Settings ─────────────────────────────────────────────────────────────

let settings: SoundSettings = DEFAULT_SOUND_SETTINGS;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The settings as the page has them: the root loader's with the page, then as saved here. */
export function soundSettings(): SoundSettings {
  return settings;
}

/** The root hands the person's settings over with the page, so the first event already respects them. */
export function applySoundSettings(next: SoundSettings | null | undefined): void {
  if (!next) return;
  settings = { ...DEFAULT_SOUND_SETTINGS, ...next, sound_cues: { ...DEFAULT_SOUND_SETTINGS.sound_cues, ...next.sound_cues } };
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(subscribe, () => settings, () => DEFAULT_SOUND_SETTINGS);
}

/**
 * Saves a change with the account (`/-/notify`, intent `sounds`): shown at
 * once, put back if it does not save. Returns the settings as kept, or null.
 */
export async function saveSoundSettings(change: SoundSettingsChange): Promise<SoundSettings | null> {
  const before = settings;
  applySoundSettings({ ...settings, ...change, sound_cues: { ...settings.sound_cues, ...change.sound_cues } });
  try {
    const response = await fetch("/-/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "sounds", change }) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const saved = (await response.json()) as SoundSettings;
    applySoundSettings(saved);
    return saved;
  } catch (error) {
    console.error("sounds: the settings did not save", error);
    applySoundSettings(before);
    return null;
  }
}

// ── Playing ──────────────────────────────────────────────────────────────

/** What happened, for the harness and for anyone debugging: the last few cues. */
export type SoundEvent = { cue: SoundCue; set: SoundSet; volume: number; at: number; how: "play" | "preview" | "silent" };

const LOG_KEPT = 20;
const log: SoundEvent[] = [];

function record(event: SoundEvent): void {
  log.push(event);
  if (log.length > LOG_KEPT) log.shift();
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("g1t:sound", { detail: event }));
    } catch {
      // Nothing listening.
    }
  }
}

/** The last cues played (or not, `silent`, when audio was not allowed yet), oldest first. */
export function recentSounds(): readonly SoundEvent[] {
  return log;
}

/** Plays a cue from the person's set at their volume. The caller has already decided it should sound. */
export function play(cue: SoundCue): void {
  const { sound_set: set, sound_volume: volume } = settings;
  if (volume <= 0) {
    record({ cue, set, volume, at: Date.now(), how: "silent" });
    return;
  }
  const how = port.canPlay() ? "play" : "silent";
  record({ cue, set, volume, at: Date.now(), how });
  port.play(cue, set, volume);
}

/** From the settings page: a cue from any set, at the volume being chosen. */
export function preview(cue: SoundCue, set: SoundSet = settings.sound_set, volume: number = settings.sound_volume): void {
  record({ cue, set, volume, at: Date.now(), how: "preview" });
  port.preview(cue, set, volume);
}

export function canPlay(): boolean {
  return port.canPlay();
}

// ── Allowing sound ───────────────────────────────────────────────────────

const GESTURES = ["pointerdown", "keydown", "touchstart"] as const;
let unlocking = false;

/**
 * From the first click or key on the page, audio is allowed: the context is
 * made then, so a cue a second later plays. Mounted once by the root
 * (components/notifications/live-notifications.tsx). Returns how to stop.
 */
export function startSounds(): () => void {
  if (typeof window === "undefined" || unlocking) return () => {};
  unlocking = true;
  const unlock = () => {
    const current = port;
    if (current instanceof WebAudioPort) current.unlock();
    if (current.canPlay()) stop();
  };
  const stop = () => {
    for (const name of GESTURES) window.removeEventListener(name, unlock, { capture: true });
    unlocking = false;
  };
  for (const name of GESTURES) window.addEventListener(name, unlock, { capture: true, passive: true });
  return stop;
}
