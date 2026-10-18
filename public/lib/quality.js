// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Automatic quality checks, so a reviewer only listens to takes that already meet a minimum.
//
// checkMicrophone() runs once per visit on a few seconds of silence and one spoken sentence: room noise,
// level, and whether the microphone cuts high frequencies (Bluetooth headsets and phone lines do).
// checkTake() runs on every take, in the page and again on the server: empty, clipped, too quiet, noisy,
// cut at the start or end, long pauses, and a length that does not fit the text.
//
// Each problem is {level, code, message}. "error" means the take is not kept and must be recorded again;
// "warning" means it is kept but flagged for the reviewer (the codes are stored with the take).

const FRAME_SECONDS = 0.02;

export const LIMITS = {
  minSeconds: 0.3,
  maxSeconds: 60,
  clip: 0.99, // a sample this loud has hit the ceiling of the converter
  silentPeak: 0.03, // error: hardly anything recorded
  quietPeak: 0.1, // warning: usable, but should be louder
  noisyRoomDb: -50, // error: background noise louder than this (dBFS) in the microphone check
  roomWarningDb: -60, // warning: background noise louder than this
  minSnrDb: 15, // error: speech less than this above the noise
  goodSnrDb: 25, // warning below this
  edgeSeconds: 0.1, // speech in the first or last 0.1 s is probably cut off
  longPauseSeconds: 2.0,
  lettersPerSecond: 12, // a calm reading speed, to estimate how long a line should take
  highBandHz: 7500,
  narrowBandDb: -55, // energy above highBandHz, relative to all, below this means a band-limited microphone
};

const db = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));
const issue = (level, code, message) => ({ level, code, message });

export function frameLevels(wave, sampleRate) {
  const size = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const levels = [];
  for (let start = 0; start + size <= wave.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += wave[i] * wave[i];
    levels.push(Math.sqrt(sum / size));
  }
  return levels;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

export function peakAndClipped(wave) {
  let peak = 0;
  let clipped = 0;
  for (const sample of wave) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= LIMITS.clip) clipped++;
  }
  return { peak, clipped };
}

function letters(text) {
  return (text.normalize("NFD").match(/\p{L}/gu) || []).length;
}

// noiseFloor: RMS of the room from the microphone check, if known; otherwise the take's own quietest frames.
export function checkTake(wave, sampleRate, { text = "", noiseFloor = null } = {}) {
  const problems = [];
  const seconds = wave.length / sampleRate;
  if (seconds < LIMITS.minSeconds) {
    return { problems: [issue("error", "empty", "Nothing was recorded. Press Record, read the line, then press Stop.")], metrics: { seconds } };
  }
  if (seconds > LIMITS.maxSeconds) {
    problems.push(issue("error", "too_long", `The take is longer than ${LIMITS.maxSeconds} seconds. Press Stop after the line.`));
  }
  const { peak, clipped } = peakAndClipped(wave);
  if (clipped > 0) {
    problems.push(issue("error", "clipped", "Too loud: it clipped. Move back from the microphone or turn the input level down, then record again."));
  }
  if (peak < LIMITS.silentPeak) {
    problems.push(issue("error", "silent", "Almost nothing was heard. Check that the right microphone is chosen and not muted, then record again."));
  } else if (peak < LIMITS.quietPeak) {
    problems.push(issue("warning", "quiet", "Very quiet. Move closer to the microphone or turn the input level up."));
  }

  const levels = frameLevels(wave, sampleRate);
  const ownNoise = percentile(levels, 0.1);
  const noise = Math.max(noiseFloor !== null ? Math.min(noiseFloor, ownNoise) : ownNoise, 1e-5);
  const speech = percentile(levels, 0.95);
  const snrDb = db(speech / noise);
  const threshold = Math.max(noise * 3.16, peak * 0.03); // 10 dB above the noise
  const active = levels.map((level) => level > threshold);
  const first = active.indexOf(true);
  const last = active.lastIndexOf(true);
  const metrics = { seconds, peak, clipped, snrDb, noiseDb: db(noise), speechSeconds: 0 };

  if (first < 0 && peak >= LIMITS.silentPeak) {
    problems.push(issue("error", "noisy", "Your voice cannot be told apart from the background noise. Find a quieter place or move closer to the microphone."));
  }
  if (first >= 0 && peak >= LIMITS.silentPeak) {
    metrics.speechSeconds = (last - first + 1) * FRAME_SECONDS;
    if (snrDb < LIMITS.minSnrDb) {
      problems.push(issue("error", "noisy", "Too much background noise compared with your voice. Find a quieter place or move closer to the microphone."));
    } else if (snrDb < LIMITS.goodSnrDb) {
      problems.push(issue("warning", "noisy", "Some background noise. A quieter room or a closer microphone would help."));
    }
    const edgeFrames = Math.round(LIMITS.edgeSeconds / FRAME_SECONDS);
    if (first < edgeFrames && seconds > 2 * LIMITS.edgeSeconds) {
      problems.push(issue("warning", "cut_start", "You started speaking right away, so the first sound may be cut off. Wait a moment after Record."));
    }
    if (last >= levels.length - edgeFrames) {
      problems.push(issue("warning", "cut_end", "It still sounds at the very end, so the last sound may be cut off. Wait a moment before Stop."));
    }
    let pause = 0;
    let longest = 0;
    for (let i = first; i <= last; i++) {
      pause = active[i] ? 0 : pause + 1;
      longest = Math.max(longest, pause);
    }
    if (longest * FRAME_SECONDS > LIMITS.longPauseSeconds) {
      problems.push(issue("warning", "long_pause", "There is a long pause in the middle. Read the line in one go."));
    }
    const expected = letters(text) / LIMITS.lettersPerSecond;
    if (expected > 0) {
      metrics.expectedSeconds = expected;
      if (metrics.speechSeconds < 0.3 * expected) {
        problems.push(issue("warning", "too_short", "This is much shorter than the line. Did you read all of it?"));
      } else if (metrics.speechSeconds > 3 * expected + 2) {
        problems.push(issue("warning", "too_slow", "This is much longer than the line needs. Read at a calm, natural speed, without extra words."));
      }
    }
  }
  return { problems, metrics };
}

export const hasErrors = (problems) => problems.some((problem) => problem.level === "error");
export const codes = (problems) => [...new Set(problems.map((problem) => problem.code))].join(" ");

// Share of the energy above `hz`, in dB, averaged over the louder frames. In-place radix-2 FFT.
export function highBandDb(wave, sampleRate, hz = LIMITS.highBandHz, size = 1024) {
  if (sampleRate / 2 <= hz) return -Infinity;
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const cut = Math.floor((hz / sampleRate) * size);
  const frames = [];
  for (let start = 0; start + size <= wave.length; start += size) {
    let energy = 0;
    for (let i = start; i < start + size; i++) energy += wave[i] * wave[i];
    frames.push({ start, energy });
  }
  const loud = frames.sort((a, b) => b.energy - a.energy).slice(0, Math.max(1, Math.ceil(frames.length / 3)));
  let high = 0;
  let total = 0;
  for (const { start } of loud) {
    const re = Float64Array.from({ length: size }, (_, i) => wave[start + i] * window[i]);
    const im = new Float64Array(size);
    fft(re, im);
    for (let k = 1; k < size / 2; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      total += power;
      if (k >= cut) high += power;
    }
  }
  return 10 * Math.log10(Math.max(high, 1e-30) / Math.max(total, 1e-30));
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let i = 0; i < n; i += length) {
      for (let k = 0; k < length / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + length / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// silence: a few seconds of the room with nobody speaking; sentence: one spoken sentence.
// settings: MediaTrackSettings of the microphone, to see whether the browser still processes the sound.
export function checkMicrophone(silence, sentence, sampleRate, { text = "", settings = {} } = {}) {
  const problems = [];
  const roomLevels = frameLevels(silence, sampleRate);
  const room = percentile(roomLevels, 0.5);
  const roomDb = db(room);
  const { peak: roomPeak } = peakAndClipped(silence);
  if (roomPeak === 0) {
    problems.push(issue("error", "muted", "The microphone sends only silence. Check that it is not muted and that the right one is chosen."));
  } else if (roomDb > LIMITS.noisyRoomDb) {
    problems.push(issue("error", "noisy_room", "The room is too noisy for recording. Find a quieter place, or switch off fans and other machines."));
  } else if (roomDb > LIMITS.roomWarningDb) {
    problems.push(issue("warning", "noisy_room", "There is some background noise. A quieter room would sound better."));
  }
  const take = checkTake(sentence, sampleRate, { text, noiseFloor: roomPeak === 0 ? null : room });
  problems.push(...take.problems.filter((problem) => !["cut_start", "cut_end", "long_pause"].includes(problem.code)));
  const highDb = highBandDb(sentence, sampleRate);
  if (sampleRate < 44100 || (take.metrics.speechSeconds > 0 && highDb < LIMITS.narrowBandDb)) {
    problems.push(issue("warning", "narrow_band", "This microphone seems to cut off high sounds (like s), as Bluetooth headsets and phone lines do. A wired or USB microphone is better."));
  }
  const processed = ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((name) => settings[name] === true);
  if (processed.length) {
    problems.push(issue("warning", "processed", `Your browser still applies ${processed.join(", ")} to the microphone. Another browser (Chrome or Firefox) may record a cleaner sound.`));
  }
  return { problems, metrics: { roomDb, highDb, ...take.metrics } };
}
