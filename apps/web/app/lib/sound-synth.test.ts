import assert from "node:assert/strict";
import { test } from "node:test";

import { SOUND_CUES } from "@g1t/contracts/sounds";

import { PEAK, cueLength, cueSpec, envelope, renderCue, volumeGain } from "./sound-synth.ts";

const RATE = 48_000;

test("every cue in both sets is short, starts and ends in silence, and never clips", () => {
  for (const set of ["soft", "bright"] as const) {
    for (const cue of [...SOUND_CUES, "call"] as const) {
      const spec = cueSpec(set, cue);
      const length = cueLength(spec);
      assert.ok(length >= 40 && length <= 260, `${set} ${cue} lasts ${length} ms`);
      const samples = renderCue(spec, RATE);
      assert.equal(samples.length, Math.ceil((length / 1000) * RATE));
      // No click: the first and last millisecond are quiet.
      const ms = RATE / 1000;
      for (let i = 0; i < ms; i++) {
        assert.ok(Math.abs(samples[i]!) < 0.15, `${set} ${cue} clicks on at sample ${i}: ${samples[i]}`);
        assert.ok(Math.abs(samples[samples.length - 1 - i]!) < 0.05, `${set} ${cue} clicks off`);
      }
      assert.ok(Math.abs(samples[0]!) < 1e-6);
      assert.ok(Math.abs(samples[samples.length - 1]!) < 1e-3);
      let peak = 0;
      let energy = 0;
      for (const s of samples) {
        peak = Math.max(peak, Math.abs(s));
        energy += s * s;
      }
      assert.ok(Math.abs(peak - PEAK) < 1e-6, `${set} ${cue} peaks at ${peak}`);
      assert.ok(energy > 1, `${set} ${cue} is audible`);
    }
  }
});

test("the cues are told apart: different figures, and Bright is higher and shorter than Soft", () => {
  const soft = [...SOUND_CUES].map((cue) => cueSpec("soft", cue));
  const figures = new Set(soft.map((spec) => spec.notes.map((n) => `${n.freq.toFixed(0)}@${n.at}+${n.dur}`).join(" ")));
  assert.equal(figures.size, soft.length, "no two Soft cues are the same figure");
  for (const cue of SOUND_CUES) {
    const s = cueSpec("soft", cue);
    const b = cueSpec("bright", cue);
    assert.equal(b.notes.length, s.notes.length, "the same roles");
    for (const [i, note] of b.notes.entries()) {
      assert.ok(note.freq > s.notes[i]!.freq, `${cue}: Bright is higher`);
      assert.ok(note.dur < s.notes[i]!.dur, `${cue}: Bright is shorter`);
    }
    assert.ok(cueLength(b) < cueLength(s));
  }
  // The tick as you send is the quietest and shortest.
  assert.ok(cueLength(cueSpec("soft", "sent")) < 80);
});

test("the envelope rises from nothing, falls, and lands on exactly nothing", () => {
  assert.equal(envelope(-1, 100), 0);
  assert.equal(envelope(0, 100), 0);
  assert.ok(envelope(3, 100) > 0 && envelope(3, 100) < envelope(6, 100));
  assert.ok(envelope(50, 100) < envelope(10, 100), "it decays");
  assert.ok(envelope(99.9, 100) < 0.01);
  assert.equal(envelope(100, 100), 0);
});

test("volume is a curve: half way reads as half as loud, not a third", () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(100), 1);
  assert.ok(volumeGain(50) > 0.3 && volumeGain(50) < 0.35);
  assert.equal(volumeGain(200), 1);
  assert.equal(volumeGain(-5), 0);
});
