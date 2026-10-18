// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Recording helpers and WAV encoding and decoding. Shared by the page and the worker. Quality checks: quality.js.

export const TAIL_SECONDS = 0.5; // keep recording this long after Stop, so the last sound is not cut off
export const MAX_SECONDS = 60;
export const MIN_SAMPLE_RATE = 44100;

// Drops the digital silence (exact zeros) some microphones send while the stream starts.
export function stripStartup(wave) {
  const first = wave.findIndex((sample) => sample !== 0);
  return first > 0 ? wave.subarray(first) : wave;
}

// 16-bit PCM mono WAV. Browser microphones deliver 16-bit at best, so 24-bit would only make files bigger.
export function encodeWav(wave, sampleRate) {
  const buffer = new ArrayBuffer(44 + wave.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + wave.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, wave.length * 2, true);
  wave.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return buffer;
}

// Returns {format, channels, sampleRate, bitsPerSample, dataOffset, dataBytes} of a RIFF/WAVE file, or null.
export function readWavHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 44 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;
  let header = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(offset) === "fmt " && size >= 16) {
      header = {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (ascii(offset) === "data") {
      return header && { ...header, dataOffset: offset + 8, dataBytes: Math.min(size, bytes.byteLength - offset - 8) };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

// Why a WAV upload is refused, or null if it is fine.
export function wavProblem(header) {
  if (!header) return "not a WAV file";
  if (header.format !== 1 || ![16, 24].includes(header.bitsPerSample)) return "not 16- or 24-bit PCM";
  if (header.channels !== 1) return "not mono";
  if (header.sampleRate < MIN_SAMPLE_RATE) return `sample rate below ${MIN_SAMPLE_RATE} Hz`;
  const seconds = header.dataBytes / (header.sampleRate * header.bitsPerSample / 8);
  if (seconds > MAX_SECONDS) return `longer than ${MAX_SECONDS} seconds`;
  return null;
}

// The samples of a 16- or 24-bit PCM WAV (checked with wavProblem first), as floats from -1 to 1.
export function decodeWav(bytes, header) {
  const width = header.bitsPerSample / 8;
  const count = Math.floor(header.dataBytes / width);
  const wave = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataOffset, count * width);
  for (let i = 0; i < count; i++) {
    if (width === 2) {
      wave[i] = view.getInt16(i * 2, true) / 0x8000;
    } else {
      const value = view.getUint8(i * 3) | (view.getUint8(i * 3 + 1) << 8) | (view.getInt8(i * 3 + 2) << 16);
      wave[i] = value / 0x800000;
    }
  }
  return wave;
}
