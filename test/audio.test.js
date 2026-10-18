// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeWav, encodeWav, readWavHeader, stripStartup, wavProblem } from "../public/lib/audio.js";

test("drops leading digital silence only", () => {
  assert.deepEqual([...stripStartup(Float32Array.from([0, 0, 0.5, 0, 0.25]))], [0.5, 0, 0.25]);
  assert.equal(stripStartup(new Float32Array(3)).length, 3);
});

test("encodes a WAV the server accepts and decodes it back", () => {
  const wave = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin(i / 10));
  const wav = new Uint8Array(encodeWav(wave, 48000));
  const header = readWavHeader(wav);
  assert.deepEqual(header, { format: 1, channels: 1, sampleRate: 48000, bitsPerSample: 16, dataOffset: 44, dataBytes: 96000 });
  assert.equal(wavProblem(header), null);
  const back = decodeWav(wav, header);
  assert.ok(back.every((sample, i) => Math.abs(sample - wave[i]) < 1e-4));
});

test("decodes 24-bit WAV, as quenya_tts.record writes it", () => {
  const bytes = new Uint8Array(44 + 6);
  bytes.set(new Uint8Array(encodeWav(new Float32Array(0), 48000)).subarray(0, 44));
  const view = new DataView(bytes.buffer);
  view.setUint16(32, 3, true);
  view.setUint16(34, 24, true);
  view.setUint32(40, 6, true);
  bytes.set([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0], 44); // +0.5, -0.5
  const header = readWavHeader(bytes);
  assert.equal(wavProblem(header), null);
  assert.deepEqual([...decodeWav(bytes, header)], [0.5, -0.5]);
});

test("refuses what is not a short mono PCM WAV", () => {
  assert.equal(wavProblem(readWavHeader(new TextEncoder().encode("ID3 not a wav file at all, just some bytes......"))), "not a WAV file");
  assert.match(wavProblem({ format: 1, channels: 2, sampleRate: 48000, bitsPerSample: 16, dataBytes: 10 }), /mono/);
  assert.match(wavProblem({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 10 }), /sample rate/);
  assert.match(wavProblem({ format: 1, channels: 1, sampleRate: 48000, bitsPerSample: 16, dataBytes: 48000 * 2 * 61 }), /longer/);
});
