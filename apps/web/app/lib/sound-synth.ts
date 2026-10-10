/**
 * The sounds themselves, as numbers: each cue is a few notes with an
 * envelope, rendered into samples here so nothing is downloaded and nothing
 * is licensed. Pure, so the shapes are tested on their own
 * (sound-synth.test.ts); lib/sounds.ts puts the samples in an AudioBuffer
 * and plays them.
 *
 * Two sets with the same roles. "Soft" is warm and low: a sine with a
 * little of its second and third harmonic, 190–250 ms, like a muted
 * marimba. "Bright" is the same figures a fifth higher and a quarter
 * shorter, nearly pure sines, like a small bell. Every note fades in over
 * 6 ms and out over its last 12 ms, so there is never a click.
 */
import type { SoundCue, SoundSet } from "@g1t/contracts/sounds";

/** A note: when it starts and how long it lasts, in ms; `gain` scales it (1 is full). */
export type Note = { freq: number; at: number; dur: number; gain?: number };

/** The timbre of a set: which overtones ride on each note, as fractions of the fundamental. */
export type Timbre = { partials: { ratio: number; gain: number; decay: number }[] };

export type CueSpec = { notes: Note[]; timbre: Timbre };

// Pitches, in Hz (equal temperament, A4 = 440).
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880;
const C6 = 1046.5;
const D6 = 1174.66;
const A4 = 440;
const CS5 = 554.37;

/** Warm: a rounded fundamental with a touch of the octave and the twelfth, which die away first. */
const WARM: Timbre = {
  partials: [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 2, gain: 0.22, decay: 0.55 },
    { ratio: 3, gain: 0.07, decay: 0.4 },
  ],
};

/** Bright: nearly a pure sine, with a faint octave for sparkle. */
const BRIGHT: Timbre = {
  partials: [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 2, gain: 0.1, decay: 0.5 },
  ],
};

/**
 * The Soft set. Each is short, two tones, and tells its own story: a
 * message steps up a third (something arrived), a direct message leaps a
 * fifth (someone is talking to you), a mention rings twice on the high note
 * (look up), an agent finishing settles down a fifth (resolved), and
 * sending is a single soft tick. `call` is reserved: a two-tone to repeat.
 */
export const SOFT: Record<SoundCue, Note[]> = {
  message: [
    { freq: C5, at: 0, dur: 90, gain: 0.9 },
    { freq: E5, at: 70, dur: 120, gain: 0.8 },
  ],
  direct: [
    { freq: D5, at: 0, dur: 90, gain: 0.9 },
    { freq: A5, at: 80, dur: 150, gain: 0.85 },
  ],
  mention: [
    { freq: A5, at: 0, dur: 60, gain: 0.8 },
    { freq: D6, at: 60, dur: 90, gain: 0.9 },
    { freq: D6, at: 150, dur: 90, gain: 0.75 },
  ],
  agent_done: [
    { freq: G5, at: 0, dur: 80, gain: 0.85 },
    { freq: C5, at: 80, dur: 160, gain: 0.9 },
  ],
  sent: [{ freq: C6, at: 0, dur: 55, gain: 0.45 }],
  call: [
    { freq: A4, at: 0, dur: 120, gain: 0.9 },
    { freq: CS5, at: 120, dur: 130, gain: 0.9 },
  ],
};

/** A fifth higher and a quarter shorter: the Bright set from the Soft figures. */
function brighten(notes: Note[]): Note[] {
  return notes.map((note) => ({ ...note, freq: note.freq * 1.5, at: note.at * 0.75, dur: note.dur * 0.75 }));
}

export const BRIGHT_NOTES: Record<SoundCue, Note[]> = {
  message: brighten(SOFT.message),
  direct: brighten(SOFT.direct),
  mention: brighten(SOFT.mention),
  agent_done: brighten(SOFT.agent_done),
  sent: brighten(SOFT.sent),
  call: brighten(SOFT.call),
};

export function cueSpec(set: SoundSet, cue: SoundCue): CueSpec {
  return set === "bright" ? { notes: BRIGHT_NOTES[cue], timbre: BRIGHT } : { notes: SOFT[cue], timbre: WARM };
}

/** How long a cue lasts, in ms: its last note's end. */
export function cueLength(spec: CueSpec): number {
  return Math.max(0, ...spec.notes.map((note) => note.at + note.dur));
}

/** The fade in and out of each note, in ms. */
export const ATTACK_MS = 6;
export const RELEASE_MS = 12;
/** The loudest any rendered sample is: room left under full scale. */
export const PEAK = 0.8;

/**
 * A note's loudness at `t` ms into it: a raised-cosine rise over the
 * attack, an exponential fall to about a third by the end, and a
 * raised-cosine release over the last `RELEASE_MS` to exactly zero.
 */
export function envelope(t: number, dur: number): number {
  if (t < 0 || t >= dur) return 0;
  const rise = t < ATTACK_MS ? 0.5 - 0.5 * Math.cos((Math.PI * t) / ATTACK_MS) : 1;
  const fall = Math.exp((-1.1 * t) / dur);
  const left = dur - t;
  const release = left < RELEASE_MS ? 0.5 - 0.5 * Math.cos((Math.PI * left) / RELEASE_MS) : 1;
  return rise * fall * release;
}

/**
 * The cue as mono samples at `sampleRate`, peaking at `PEAK`. Each note is
 * the sum of its timbre's partials, each with the envelope; overlapping
 * notes add. A quiet cue is scaled up to the peak and a loud one down, so
 * the volume setting is the only thing that changes loudness.
 */
export function renderCue(spec: CueSpec, sampleRate: number): Float32Array<ArrayBuffer> {
  const length = Math.ceil((cueLength(spec) / 1000) * sampleRate);
  const out = new Float32Array(new ArrayBuffer(length * 4));
  for (const note of spec.notes) {
    const start = Math.floor((note.at / 1000) * sampleRate);
    const count = Math.floor((note.dur / 1000) * sampleRate);
    const gain = note.gain ?? 1;
    for (let i = 0; i < count && start + i < length; i++) {
      const tMs = (i / sampleRate) * 1000;
      const shape = envelope(tMs, note.dur);
      if (shape === 0) continue;
      let sample = 0;
      for (const partial of spec.timbre.partials) {
        // Higher partials fade faster than the fundamental: the tone mellows as it rings.
        const fade = partial.decay === 1 ? 1 : Math.exp((-(1 - partial.decay) * 4 * tMs) / note.dur);
        sample += partial.gain * fade * Math.sin((2 * Math.PI * note.freq * partial.ratio * i) / sampleRate);
      }
      out[start + i] += gain * shape * sample;
    }
  }
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const scale = PEAK / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

/** The perceived loudness of a 0–100 setting as a gain: the ear hears a curve, not a line. */
export function volumeGain(volume: number): number {
  const v = Math.max(0, Math.min(100, volume)) / 100;
  return v ** 1.6;
}
