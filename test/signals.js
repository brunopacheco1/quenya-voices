// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Synthetic takes for the quality tests: silence, room noise and a speech-like signal.

export const RATE = 48000;

// Deterministic noise, so the tests always see the same signal.
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 * 2 - 1;
  };
}

// parts: [[seconds, "silence" | "speech", amplitude]]; noise: room noise amplitude under everything.
export function take(parts, { noise = 0.0005, seed = 1, bright = true } = {}) {
  const next = random(seed);
  const samples = [];
  for (const [seconds, kind, amplitude = 0.4] of parts) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i++) {
      let sample = noise * next();
      if (kind === "speech") {
        const t = i / RATE;
        const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t); // four syllables a second
        const voice = Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 420 * t) + 0.3 * Math.sin(2 * Math.PI * 1100 * t);
        const hiss = bright ? 0.15 * next() : 0; // like s and other fricatives
        sample += amplitude * syllable * (voice / 1.8 + hiss);
      }
      samples.push(sample);
    }
  }
  return Float32Array.from(samples);
}

// A first-order low-pass at about `hz`, applied several times: what a Bluetooth headset does to the sound.
export function lowPass(wave, hz, passes = 6) {
  const alpha = 1 - Math.exp(-2 * Math.PI * hz / RATE);
  let out = Float32Array.from(wave);
  for (let pass = 0; pass < passes; pass++) {
    let y = 0;
    out = out.map((x) => (y += alpha * (x - y)));
  }
  return out;
}
