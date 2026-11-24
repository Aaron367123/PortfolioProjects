#!/usr/bin/env node
/**
 * Synthesises three short, royalty-free "lo-fi" loops as WAV files so the
 * demo library has something to play without shipping copyrighted audio.
 *
 *   node scripts/generate-demo-audio.js   -> public/audio/demo-loop-{1,2,3}.wav
 *
 * Each loop is four 2-second chords played as a soft electric-piano
 * arpeggio over a sine bass: 16 kHz, 16-bit mono, ~256 KB per file.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const SAMPLE_RATE = 16000;
const CHORD_SEC = 2;
const OUT_DIR = new URL('../public/audio/', import.meta.url);

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Chord progressions as MIDI note numbers (root first).
const PROGRESSIONS = [
  [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]], // Am7  Fmaj7 Cmaj7 G7
  [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [45, 48, 52, 55]], // Dm7  G7    Cmaj7 Am7
  [[52, 55, 59, 62], [57, 60, 64, 67], [50, 53, 57, 60], [55, 59, 62, 66]], // Em7  Am7   Dm7   Gmaj7
];

/** A soft "keys" voice: a few harmonics with an exponential decay. */
function keyTone(freq, t) {
  const env = Math.exp(-3 * t) * Math.min(1, t * 200);
  return env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t) + 0.1 * Math.sin(6 * Math.PI * freq * t));
}

function render(progression) {
  const total = progression.length * CHORD_SEC * SAMPLE_RATE;
  const samples = new Float32Array(total);
  const step = CHORD_SEC / 8; // eight arpeggio notes per chord

  progression.forEach((chord, ci) => {
    const chordStart = ci * CHORD_SEC;
    for (let i = 0; i < total; i += 1) {
      const t = i / SAMPLE_RATE - chordStart;
      if (t < 0 || t >= CHORD_SEC + 1) continue;
      // Bass: chord root an octave down, gently swelling in and out.
      if (t < CHORD_SEC) samples[i] += 0.35 * Math.sin(Math.PI * t / CHORD_SEC) * Math.sin(2 * Math.PI * midiToHz(chord[0] - 12) * t);
      // Arpeggio: up and back down the chord.
      for (let n = 0; n < 8; n += 1) {
        const noteT = t - n * step;
        if (noteT < 0 || noteT > 1) continue;
        const note = chord[[0, 1, 2, 3, 2, 1, 2, 3][n]] + 12;
        samples[i] += 0.22 * keyTone(midiToHz(note), noteT);
      }
    }
  });

  // Fade the loop edges to avoid clicks, then normalise to 70 % of full scale.
  const fade = SAMPLE_RATE * 0.05;
  for (let i = 0; i < fade; i += 1) {
    samples[i] *= i / fade;
    samples[total - 1 - i] *= i / fade;
  }
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  return samples.map((v) => (v / peak) * 0.7);
}

function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

mkdirSync(OUT_DIR, { recursive: true });
PROGRESSIONS.forEach((progression, i) => {
  const file = new URL(`demo-loop-${i + 1}.wav`, OUT_DIR);
  writeFileSync(file, toWav(render(progression)));
  console.log(`wrote ${file.pathname}`);
});
