// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkMicrophone, checkTake, codes, hasErrors } from "../public/lib/quality.js";
import { RATE, lowPass, take } from "./signals.js";

const TEXT = "Elen síla lúmenn' omentielvo."; // 24 letters, about 2 s

const problemCodes = (wave, options = { text: TEXT }) => codes(checkTake(wave, RATE, options).problems);

test("a clean take with silence around the speech passes", () => {
  const result = checkTake(take([[0.4, "silence"], [2, "speech"], [0.6, "silence"]]), RATE, { text: TEXT });
  assert.deepEqual(result.problems, []);
  assert.ok(result.metrics.snrDb > 40);
});

test("empty, silent and clipped takes are errors", () => {
  assert.equal(problemCodes(new Float32Array(1000)), "empty");
  assert.match(problemCodes(take([[0.4, "silence"], [2, "speech", 0.01], [0.6, "silence"]])), /silent/);
  const loud = take([[0.4, "silence"], [2, "speech", 1.5], [0.6, "silence"]]).map((x) => Math.max(-1, Math.min(1, x)));
  const result = checkTake(loud, RATE, { text: TEXT });
  assert.ok(hasErrors(result.problems));
  assert.match(codes(result.problems), /clipped/);
});

test("a quiet take is a warning, not an error", () => {
  const result = checkTake(take([[0.4, "silence"], [2, "speech", 0.06], [0.6, "silence"]], { noise: 0.00005 }), RATE, { text: TEXT });
  assert.equal(codes(result.problems), "quiet");
  assert.equal(hasErrors(result.problems), false);
});

test("noise close to the voice is an error, some noise a warning", () => {
  assert.match(problemCodes(take([[0.4, "silence"], [2, "speech", 0.3], [0.6, "silence"]], { noise: 0.1 })), /noisy/);
  assert.ok(hasErrors(checkTake(take([[0.4, "silence"], [2, "speech", 0.3], [0.6, "silence"]], { noise: 0.1 }), RATE, { text: TEXT }).problems));
  const some = checkTake(take([[0.4, "silence"], [2, "speech", 0.3], [0.6, "silence"]], { noise: 0.02 }), RATE, { text: TEXT });
  assert.equal(codes(some.problems), "noisy");
  assert.equal(hasErrors(some.problems), false);
});

test("the room noise from the microphone check is used when the take has no silence", () => {
  const allSpeech = take([[2.5, "speech"]]);
  assert.match(problemCodes(allSpeech), /noisy/);
  assert.doesNotMatch(problemCodes(allSpeech, { text: TEXT, noiseFloor: 0.0005 }), /noisy/);
});

test("speech at the very start or end is flagged as possibly cut off", () => {
  assert.match(problemCodes(take([[2, "speech"], [0.6, "silence"]])), /cut_start/);
  assert.match(problemCodes(take([[0.4, "silence"], [2, "speech"]])), /cut_end/);
});

test("long pauses and lengths that do not fit the text are flagged", () => {
  assert.match(problemCodes(take([[0.4, "silence"], [1, "speech"], [3, "silence"], [1, "speech"], [0.6, "silence"]])), /long_pause/);
  assert.match(problemCodes(take([[0.4, "silence"], [0.3, "speech"], [0.6, "silence"]])), /too_short/);
  assert.match(problemCodes(take([[0.4, "silence"], [12, "speech"], [0.6, "silence"]])), /too_slow/);
});

test("microphone check: a good setup passes", () => {
  const result = checkMicrophone(take([[3, "silence"]]), take([[0.4, "silence"], [2, "speech"], [0.6, "silence"]], { seed: 2 }), RATE, { text: TEXT });
  assert.deepEqual(result.problems, []);
});

test("microphone check: muted microphones, noisy rooms and processing", () => {
  const speech = take([[0.4, "silence"], [2, "speech"], [0.6, "silence"]], { seed: 3 });
  assert.match(codes(checkMicrophone(new Float32Array(3 * RATE), speech, RATE).problems), /muted/);
  const noisy = checkMicrophone(take([[3, "silence"]], { noise: 0.02 }), speech, RATE, { text: TEXT });
  assert.ok(hasErrors(noisy.problems));
  assert.match(codes(noisy.problems), /noisy_room/);
  const processed = checkMicrophone(take([[3, "silence"]]), speech, RATE, { text: TEXT, settings: { noiseSuppression: true } });
  assert.equal(codes(processed.problems), "processed");
});

test("microphone check: a band-limited (Bluetooth-like) microphone is flagged", () => {
  const speech = lowPass(take([[0.4, "silence"], [2, "speech"], [0.6, "silence"]], { seed: 4, noise: 0 }), 3500);
  const result = checkMicrophone(lowPass(take([[3, "silence"]]), 3500), speech, RATE, { text: TEXT });
  assert.match(codes(result.problems), /narrow_band/);
});
